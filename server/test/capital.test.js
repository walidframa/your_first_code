/**
 * What the shop is worth, and how the months moved it.
 *
 * A shopkeeper's own question — "I put this much in; am I ahead?" — and one
 * the ledgers do not answer on their own. The figure starts where the owner
 * says, and each finished month's net profit is added to it.
 *
 * The arithmetic is checked against the library directly as well as through the
 * route, because the interesting cases are about *months*, and a test that had
 * to wait for one to pass would never run.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4639;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;
let capitalHistory;
let stockAtCost;

async function req(method, route, body, bearer = token) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Some responses legitimately carry no body.
  }
  return { status: res.status, json };
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready in time');
}

/** The first day of the month after the one `date` is in. */
function monthAfter(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

const today = new Date().toISOString().slice(0, 10);
const thisMonth = today.slice(0, 7);

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-capital-'));
  const dbPath = path.join(workDir, 'capital.sqlite');
  const env = {
    ...process.env,
    DB_PATH: dbPath,
    JWT_SECRET: 'capital-test-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: serverRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' }, null)).json
    .token;

  /*
   * The same file the running server writes to, opened in this process so the
   * month arithmetic can be asked about a date that has not arrived yet.
   */
  process.env.DB_PATH = dbPath;
  process.env.ACCOUNT_SECRET = 'capital-test-account-secret-32-chars';
  ({ capitalHistory, stockAtCost } = await import('../src/lib/capital.js'));
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a shop that has not said what it started with is asked, not guessed at', async () => {
  const { json } = await req('GET', '/expenses/capital');
  assert.equal(json.capital.set, false);
  assert.equal(json.capital.capital, 0);
  // With the figure most shops mean by it offered as a starting point.
  assert.ok(json.stockAtCost > 0, 'the seeded shelves are worth something');
  assert.equal(json.stockAtCost, stockAtCost());
});

test('the opening figure is what it says, until a month finishes', async () => {
  const set = await req('PUT', '/settings', {
    capital_opening: 5000,
    capital_opening_date: `${thisMonth}-01`,
  });
  assert.equal(set.status, 200);

  const { json } = await req('GET', '/expenses/capital');
  assert.equal(json.capital.set, true);
  assert.equal(json.capital.opening, 5000);
  /*
   * The month in hand is still happening, so nothing has been added — a
   * headline that fell every time somebody wrote down an expense is the one
   * thing that would stop anybody trusting it.
   */
  assert.equal(json.capital.capital, 5000);
  assert.deepEqual(json.capital.months, []);
});

test('this month is shown beside the total, marked as not counted yet', async () => {
  const sale = await req('POST', '/orders', {
    items: [{ productId: (await req('GET', '/products')).json.products[0].id, quantity: 1 }],
    paymentMethod: 'card',
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const { json } = await req('GET', '/expenses/capital');
  assert.equal(json.capital.capital, 5000, 'an unfinished month moved the headline');
  assert.ok(json.capital.thisMonth.netProfit > 0, 'the sale made nothing');
  assert.equal(
    json.capital.thisMonth.wouldBe,
    Math.round((5000 + json.capital.thisMonth.netProfit) * 100) / 100,
    'what it would stand at if the month ended today',
  );
});

test('once the month is over, its profit is part of the capital', () => {
  // Asked about the first of next month, so this month is a finished one.
  const next = monthAfter(today);
  const after = capitalHistory({ today: next });

  assert.equal(after.months.length, 1);
  assert.equal(after.months[0].month, thisMonth);
  assert.ok(after.months[0].netProfit > 0);
  assert.equal(
    after.capital,
    Math.round((5000 + after.months[0].netProfit) * 100) / 100,
    'the rise from one month to the next is exactly what the shop earned',
  );
  // And the month it moved into is the one now in progress.
  assert.equal(after.thisMonth.month, next.slice(0, 7));
});

test('an expense comes off the month it was spent in', async () => {
  const before = capitalHistory({ today: monthAfter(today) }).capital;

  const spend = await req('POST', '/expenses', { category: 'rent', amountUsd: 20, note: 'Rent' });
  assert.equal(spend.status, 201, JSON.stringify(spend.json));

  const after = capitalHistory({ today: monthAfter(today) }).capital;
  assert.equal(
    after,
    Math.round((before - 20) * 100) / 100,
    'capital follows net profit, so what the shop spent has to come off it',
  );
});

test('buying stock does not make the shop richer or poorer', async () => {
  /*
   * The money changed shape, that is all. A figure that rose every time a
   * delivery arrived would make a strong month look flat, which is the
   * opposite of useful.
   */
  const before = capitalHistory({ today: monthAfter(today) }).capital;

  const supplier = (await req('POST', '/suppliers', { name: 'A wholesaler' })).json.party.id;
  const product = (await req('GET', '/products')).json.products[0];
  const doc = await req('POST', '/documents', {
    docType: 'purchase_invoice',
    partyType: 'supplier',
    partyId: supplier,
    items: [{ productId: product.id, quantity: 20, price: 3 }],
  });
  assert.equal(doc.status, 201, JSON.stringify(doc.json));
  assert.equal((await req('POST', `/documents/${doc.json.document.id}/confirm`, {})).status, 200);

  assert.equal(capitalHistory({ today: monthAfter(today) }).capital, before);
});

test('a nonsense opening figure is refused rather than stored', async () => {
  for (const body of [{ capital_opening: -1 }, { capital_opening: 'lots' }]) {
    assert.equal((await req('PUT', '/settings', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await req('PUT', '/settings', { capital_opening_date: 'March' })).status, 400);
});

test('what the shop has made is not a figure a shift is shown', async () => {
  const cashier = await req('POST', '/users', {
    name: 'A cashier',
    username: 'till',
    password: 'a-long-enough-password',
    role: 'cashier',
  });
  assert.equal(cashier.status, 201, JSON.stringify(cashier.json));

  const theirs = (
    await req('POST', '/auth/login', { username: 'till', password: 'a-long-enough-password' }, null)
  ).json.token;
  assert.equal((await req('GET', '/expenses/capital', null, theirs)).status, 403);
});

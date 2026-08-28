/**
 * The till's own movements, and whether the books know about them.
 *
 * Sales, invoices and expenses each had a posting path from the start. The
 * things the *drawer* does to itself did not: the float put in to make change,
 * the count that came up short, the takings swept to the safe, the notes
 * carried to the bank. Every one of them moved real money and none of them
 * reached the ledger, so the books and the drawer disagreed from the first
 * morning a till was opened.
 *
 * The assertion throughout is one number: what the ledger says the shop's cash
 * accounts hold, against what its tills actually hold. The revaluation report
 * already works that out — it calls the gap `unexplained`, and refuses to
 * dress it up as an exchange difference — so these tests read it rather than
 * deriving the same figure a second way.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4653;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;
let widget;

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

/** The gap between what the books say the tills hold and what they hold. */
const unexplained = async () => (await req('GET', '/ledger/revaluation')).json.unexplained;
const balanceOf = async (code) =>
  (await req('GET', '/ledger/trial-balance')).json.accounts.find((a) => a.code === code)?.balance ?? 0;
const balanced = async () => (await req('GET', '/ledger/trial-balance')).json.balanced;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-till-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'till.sqlite'),
    JWT_SECRET: 'till-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  await req('PUT', '/settings', { tax_enabled: false, exchange_rate: 89000 });

  widget = (await req('POST', '/products', {
    name: 'Charger', sku: 'TL-1', price: 100, cost: 60, stock: 50,
  })).json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a shop that has done nothing has nothing unexplained', async () => {
  assert.equal(await unexplained(), 0);
});

test('the float put in to make change reaches the books', async () => {
  /*
   * The bug this closes. Opening a till with $200 wrote a movement and nothing
   * else, so the books were short by the float from that moment on — and the
   * Exchange differences screen reported it as unexplained, correctly refusing
   * to call it a rate movement.
   */
  const opened = await req('POST', '/cash/open', { openingUsd: 200 });
  assert.equal(opened.status, 201, JSON.stringify(opened.json));

  assert.equal(await balanceOf('1110'), 200, 'the books hold what the drawer holds');
  assert.equal(await balanceOf('3100'), 200, 'and it came from the owner, not from nowhere');
  assert.equal(await unexplained(), 0, 'so there is nothing left to explain');
  assert.equal(await balanced(), true);
});

test('and carried-over cash is not counted a second time', async () => {
  /*
   * Money already in the drawer is already in the books. It is recorded on the
   * sitting rather than as a movement precisely so that opening a till twice
   * does not post the same notes twice.
   */
  const before = await balanceOf('1110');
  await req('POST', '/cash/close', { countedUsd: 200, carriedUsd: 200 });
  const reopened = await req('POST', '/cash/open', {});
  assert.equal(reopened.status, 201, JSON.stringify(reopened.json));

  assert.equal(await balanceOf('1110'), before, 'the same notes, counted once');
  assert.equal(await unexplained(), 0);
});

test('a sale still posts once, not twice', async () => {
  /*
   * The risk in fixing this: the till and the sale both move the same money,
   * and posting the movement as well as the sale would double every takings
   * figure in the shop.
   */
  const sale = await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 1 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 100 }],
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  assert.equal(await balanceOf('4100'), 100, 'one sale, one hundred dollars');
  assert.equal(await balanceOf('1110'), 300, 'the float and the takings, once each');
  assert.equal(await unexplained(), 0);
});

test('a drawer counted short says so in the books', async () => {
  const closed = await req('POST', '/cash/close', { countedUsd: 295, carriedUsd: 0 });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));

  assert.equal(await balanceOf('5900'), 5, 'five dollars nobody can account for');
  assert.equal(await unexplained(), 0, 'and the books still match the drawer');
  assert.equal(await balanced(), true);
});

test('what leaves the drawer at close leaves the books too', async () => {
  /*
   * A one-till shop carrying its takings to the bank. The money is still the
   * shop's, so it moves to the bank account rather than vanishing — but it is
   * certainly not in the drawer any more, and the books used to say it was.
   */
  assert.equal(await balanceOf('1110'), 0, 'the drawer was emptied');
  assert.equal(await balanceOf('1120'), 295, 'and the money is where it went');
  assert.equal(await unexplained(), 0);
  assert.equal(await balanced(), true);
});

test('a sweep between two of the shop’s own tills is one event', async () => {
  /*
   * Carrying notes from the drawer to the safe does not change what the shop
   * holds. With both tills on the same ledger account — which is the default —
   * there is nothing to write, and writing a debit and a credit against the
   * same account would be noise in a journal somebody has to read.
   */
  const safe = (await req('POST', '/accounts/cash', { name: 'Back safe', kind: 'safe' })).json.account;
  await req('PUT', `/accounts/cash/${safe.id}`, { isDefault: true });

  await req('POST', '/cash/open', { openingUsd: 100 });
  const before = await balanceOf('1110');
  const closed = await req('POST', '/cash/close', { countedUsd: 100, carriedUsd: 20 });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));

  assert.equal(await balanceOf('1110'), before, 'the shop holds what it held');
  assert.equal(await unexplained(), 0, 'and the books still match the tills');
  assert.equal(await balanced(), true);
});

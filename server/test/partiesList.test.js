/**
 * Finding one customer among thousands.
 *
 * The list used to answer with everybody, every time, and the browser did the
 * searching. That works for the shop with ninety customers it was written for
 * and stops working somewhere on the way to the shop with nine thousand: the
 * whole ledger comes down the wire so that forty rows can be drawn from it.
 *
 * So the list is paged, and — the part that actually matters at a desk — it can
 * be asked the question it is usually opened for: *who owes me money*. Both
 * have to happen on the server. A filter applied to the page on screen answers
 * about fifty people and looks like it answered about all of them, which is the
 * worst kind of wrong for a figure somebody is about to act on.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4694;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;

async function req(method, route, body, auth = token) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* Some responses carry no body. */
  }
  return { status: res.status, json };
}

/** Somebody on the books, with a balance put there deliberately. */
async function customer(name, opening = 0) {
  const { json } = await req('POST', '/customers', { name, opening_balance: opening });
  return json.party;
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-parties-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'parties-secret-long-enough-for-the-production-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };
  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' }, null)).json
    .token;

  // Enough to need more than one page of ten, with balances all three ways.
  for (let i = 1; i <= 24; i += 1) {
    await customer(`Zebra Test ${String(i).padStart(2, '0')}`, i % 3 === 0 ? 25 : 0);
  }
  await customer('Ahmad Halabi', 140);
  await customer('Nadia Khoury', -60);
  await customer('Settled Sami', 0);
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const list = async (query = '') => (await req('GET', `/customers${query}`)).json;

/* ------------------------------------------------------------ the pages */

test('without a limit the list is still everybody, as the register needs', async () => {
  /*
   * The customer picker at the till searches the list it holds. A page of fifty
   * would quietly become "this shop has fifty customers" at the counter, so
   * pagination is something a screen opts into rather than something that
   * happens to every caller.
   */
  const all = await list();
  assert.ok(all.parties.length >= 27, `got ${all.parties.length}`);
  assert.equal(all.limit, null, 'nothing was capped');
  assert.equal(all.parties.length, all.total, 'and the count agrees with the rows');
});

test('a page is the size asked for, and says how many there are in all', async () => {
  const first = await list('?limit=10');
  assert.equal(first.parties.length, 10);
  assert.equal(first.offset, 0);
  assert.ok(first.total >= 27, 'the total counts every one of them, not the page');

  const second = await list('?limit=10&offset=10');
  assert.equal(second.parties.length, 10);
  assert.equal(second.total, first.total, 'the total does not change when you turn the page');

  const overlap = first.parties.filter((p) => second.parties.some((q) => q.id === p.id));
  assert.deepEqual(overlap, [], 'page two is not page one again');
});

test('the last page is short rather than padded, and past the end is empty', async () => {
  const { total } = await list('?limit=1');
  const last = await list(`?limit=10&offset=${Math.floor(total / 10) * 10}`);
  assert.equal(last.parties.length, total % 10);

  const past = await list(`?limit=10&offset=${total + 50}`);
  assert.deepEqual(past.parties, []);
  assert.equal(past.total, total, 'and it still knows how many there really are');
});

/* --------------------------------------------------------- by what is owed */

test('the list can be asked for the people who owe money', async () => {
  const owing = await list('?balance=owing');
  assert.ok(owing.parties.length > 0);
  assert.ok(
    owing.parties.every((p) => p.balance > 0.005),
    'nobody square or in credit is in the owing list',
  );
  assert.ok(owing.parties.some((p) => p.name === 'Ahmad Halabi'));
  assert.equal(owing.total, owing.parties.length);
});

test('and for the ones in credit, and the ones that are square', async () => {
  const credit = await list('?balance=credit');
  assert.deepEqual(
    credit.parties.map((p) => p.name),
    ['Nadia Khoury'],
  );
  assert.equal(credit.parties[0].balance, -60);

  const settled = await list('?balance=settled');
  assert.ok(settled.parties.every((p) => Math.abs(p.balance) <= 0.005));
  assert.ok(settled.parties.some((p) => p.name === 'Settled Sami'));
});

test('the money on the card is the whole filtered set, not the page on screen', async () => {
  /*
   * The figure at the top of that screen is what the shop is owed. Adding up
   * the fifty rows that happen to be loaded would print a smaller number in
   * exactly the same place, and somebody would act on it.
   */
  const page = await list('?balance=owing&limit=2');
  const everyone = await list('?balance=owing');
  const summed = everyone.parties.reduce((n, p) => n + p.balance, 0);

  assert.equal(page.parties.length, 2, 'a page of two');
  assert.equal(Math.round(page.owing * 100) / 100, Math.round(summed * 100) / 100);
  assert.equal(page.total, everyone.parties.length);
});

test('filtering and paging are the same question asked twice', async () => {
  const owing = await list('?balance=owing&limit=100');
  const firstTwo = await list('?balance=owing&limit=2&sort=balance');
  const sorted = [...owing.parties].sort((a, b) => b.balance - a.balance).slice(0, 2);
  assert.deepEqual(
    firstTwo.parties.map((p) => p.id),
    sorted.map((p) => p.id),
    'biggest debt first, so the page is the top of the list rather than a slice of the middle',
  );
});

/* -------------------------------------------------------------- searching */

test('the search is words in any order, and it searches all of them', async () => {
  // Not just the page: "halabi ahmad" has to find HALABI AHMAD wherever it is.
  const found = await list('?search=halabi%20ahmad&limit=10');
  assert.deepEqual(
    found.parties.map((p) => p.name),
    ['Ahmad Halabi'],
  );
  assert.equal(found.total, 1, 'the count is of what matched, not of everybody');
});

test('a search and a balance filter narrow together', async () => {
  const both = await list('?search=zebra&balance=owing&limit=100');
  assert.ok(both.parties.length > 0);
  assert.ok(both.parties.every((p) => p.name.startsWith('Zebra') && p.balance > 0.005));

  const none = await list('?search=zebra&balance=credit');
  assert.deepEqual(none.parties, [], 'no Zebra is in credit');
  assert.equal(none.total, 0);
  assert.equal(none.owing, 0);
});

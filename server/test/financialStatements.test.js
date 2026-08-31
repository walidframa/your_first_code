/**
 * The two statements a shop is actually asked for.
 *
 * The trial balance was a working paper: it proves the ledger adds up. What an
 * accountant, a bank or the tax office wants is what the shop earned over a
 * period and what it owns and owes on a date.
 *
 * The claim that matters most: a balance sheet drawn between two closings has
 * to carry the profit that has not been closed yet, or it is out by exactly
 * that profit — which reads as a bookkeeping error and is not one.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4671;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;

async function req(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Some replies carry no body.
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

/** An account's id by its code, so the test reads in the shop's own terms. */
let byCode = {};

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-stmt-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 's.sqlite'),
    JWT_SECRET: 'statements-test-secret-long-enough',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };
  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();
  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;

  const { accounts } = (await req('GET', '/ledger/accounts')).json;
  byCode = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** Post a balanced entry, the way the books require, and insist it landed. */
async function post(date, memo, lines) {
  const res = await req('POST', '/ledger/entries', { entryDate: date, memo, lines });
  assert.equal(res.status, 201, `${memo}: ${JSON.stringify(res.json)}`);
  return res;
}

test('a shop that has traded gets a profit it can read in two lines', async () => {
  /* Capital in, goods bought and sold, and a month's rent. */
  await post('2026-03-01', 'Owner put money in', [
    { accountId: byCode['1110'], debit: 10000 },
    { accountId: byCode['3100'], credit: 10000 },
  ]);
  await post('2026-03-05', 'Sold phones', [
    { accountId: byCode['1110'], debit: 4000 },
    { accountId: byCode['4100'], credit: 4000 },
  ]);
  await post('2026-03-05', 'What those phones cost', [
    { accountId: byCode['5100'], debit: 2500 },
    { accountId: byCode['1110'], credit: 2500 },
  ]);
  await post('2026-03-31', 'March rent', [
    { accountId: byCode['5300'], debit: 500 },
    { accountId: byCode['1110'], credit: 500 },
  ]);

  const { json } = await req('GET', '/ledger/income-statement?from=2026-03-01&to=2026-03-31');

  assert.equal(json.totals.revenue, 4000);
  assert.equal(json.totals.costOfSales, 2500, 'cost of goods sold is above the gross line');
  assert.equal(json.totals.grossProfit, 1500);
  assert.equal(json.totals.grossMargin, 37.5, 'and the margin that goes with it');
  assert.equal(json.totals.operating, 500, 'rent is the cost of being open, not of the goods');
  assert.equal(json.totals.netProfit, 1000);
});

test('the period is a period — April does not borrow March’s trading', async () => {
  const { json } = await req('GET', '/ledger/income-statement?from=2026-04-01&to=2026-04-30');
  assert.equal(json.totals.revenue, 0);
  assert.equal(json.totals.netProfit, 0);
  assert.equal(json.totals.grossMargin, null, 'no revenue is not a margin of zero');
});

test('the balance sheet balances, carrying the profit nobody has closed yet', async () => {
  /*
   * The whole reason this is its own line. Between two closings the shop's
   * earnings sit in the income and expense accounts, outside equity. A balance
   * sheet drawn without them is out by exactly the profit.
   */
  const { json } = await req('GET', '/ledger/balance-sheet?asAt=2026-03-31');

  assert.equal(json.result, 1000, 'March made a thousand and nothing has closed it');
  assert.equal(json.totals.assets, 11000, 'ten in, four out of sales, less 2,500 and 500');
  assert.equal(json.totals.liabilities, 0);
  assert.equal(json.totals.equity, 11000, 'the owner’s ten thousand plus what it earned');
  assert.equal(json.totals.difference, 0);
  assert.equal(json.balanced, true);
});

test('and it still balances once the books are closed', async () => {
  /*
   * Closing sweeps income and expenses into retained earnings. The figures move
   * from one side of equity to the other and the total must not budge — if it
   * does, the statement was double-counting the profit.
   */
  const before = (await req('GET', '/ledger/balance-sheet?asAt=2026-03-31')).json;

  const closed = await req('POST', '/ledger/closings', { to: '2026-03-31' });
  assert.equal(closed.status, 201, JSON.stringify(closed.json));

  const after = (await req('GET', '/ledger/balance-sheet?asAt=2026-03-31')).json;
  assert.equal(after.result, 0, 'nothing is left unclosed');
  assert.equal(after.totals.equity, before.totals.equity, 'and equity is exactly where it was');
  assert.equal(after.balanced, true);
});

/**
 * Restating the pounds at today's rate.
 *
 * The claim under test: the books carry the shop's pounds at the rates they
 * were taken in at, today's rate is a different number, and the difference is
 * an entry rather than an opinion.
 *
 * The tests that matter most are the ones about what it refuses to do — it
 * must not rewrite the entries already written, and it must not call a
 * bookkeeping error an exchange difference just because both are gaps.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4651;
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

const report = async () => (await req('GET', '/ledger/revaluation')).json;
const cashRow = async () => (await report()).accounts.find((a) => a.code === '1110');
const tb = async () => (await req('GET', '/ledger/trial-balance')).json;
const balanceOf = async (code) => (await tb()).accounts.find((a) => a.code === code)?.balance ?? 0;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-fx-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'fx.sqlite'),
    JWT_SECRET: 'fx-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;

  await req('PUT', '/settings', { exchange_rate: 89000, tax_enabled: false });
  await req('POST', '/cash/open', { openingUsd: 0 });

  widget = (await req('POST', '/products', {
    name: 'Charger', sku: 'FX-1', price: 100, cost: 60, stock: 50,
  })).json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('with the rate where it was, there is nothing to restate', async () => {
  // A sale paid entirely in pounds, at the rate the books are using.
  const sale = await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 1 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'LBP', amount: 8900000 }],
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const cash = await cashRow();
  assert.equal(cash.heldLbp, 8900000, 'the pounds are in the drawer');
  assert.equal(cash.difference, 0, 'and worth exactly what the books say');

  const nothing = await req('POST', '/ledger/revaluation');
  assert.equal(nothing.status, 400);
  assert.match(nothing.json.error, /nothing to restate/i);
});

test('the books hold the pounds at the rate they came in at', async () => {
  const cash = await cashRow();
  assert.equal(cash.bookedLbpUsd, 100, 'eight million nine hundred thousand at 89,000');
  assert.equal(cash.impliedRate, 89000, 'which is the rate they were taken at');
});

test('when the pound weakens, the shop is holding less than it thought', async () => {
  await req('PUT', '/settings', { exchange_rate: 100000 });

  const cash = await cashRow();
  assert.equal(cash.heldLbp, 8900000, 'the same pounds are still there');
  assert.equal(cash.bookedLbpUsd, 100, 'still on the books at what they cost');
  assert.equal(cash.worthTodayUsd, 89, 'and worth less this morning');
  assert.equal(cash.difference, -11, 'eleven dollars of it has evaporated');
});

test('restating it moves the difference, and only the difference', async () => {
  const cashBefore = await balanceOf('1110');
  const salesBefore = await balanceOf('4100');

  const posted = await req('POST', '/ledger/revaluation');
  assert.equal(posted.status, 201, JSON.stringify(posted.json));

  assert.equal(await balanceOf('1110'), Math.round((cashBefore - 11) * 100) / 100);
  assert.equal(await balanceOf('5800'), 11, 'the loss is an exchange difference');
  assert.equal(await balanceOf('4100'), salesBefore, 'and the sale is untouched');

  assert.equal((await tb()).balanced, true);
});

test('and afterwards the books agree with the drawer', async () => {
  const cash = await cashRow();
  assert.equal(cash.difference, 0, 'nothing left to restate');

  const again = await req('POST', '/ledger/revaluation');
  assert.equal(again.status, 400, 'so pressing it twice does nothing');
});

test('when the pound strengthens it goes the other way', async () => {
  await req('PUT', '/settings', { exchange_rate: 89000 });

  const cash = await cashRow();
  assert.equal(cash.difference, 11, 'back to where it started');

  await req('POST', '/ledger/revaluation');
  assert.equal(await balanceOf('5800'), 0, 'the loss and the gain cancel');
  assert.equal((await tb()).balanced, true);
});

test('the entry that was already written is left exactly as it was', async () => {
  /*
   * The whole reason this is a new entry rather than a correction. A sale
   * records what it was worth when it was rung up; a shop whose March accounts
   * change every time the rate moves cannot close a month.
   */
  const entries = (await req('GET', '/ledger/entries')).json.entries;
  // Every automatic posting carries the same source; the sale is the one that
  // credited Sales.
  let sale = null;
  for (const e of entries.filter((x) => x.source === 'auto')) {
    const { entry } = (await req('GET', `/ledger/entries/${e.id}`)).json;
    if (entry.lines.some((l) => l.account_code === '4100')) { sale = entry; break; }
  }
  assert.ok(sale, 'the sale is in the journal');

  assert.equal(sale.status, 'posted', 'the sale still stands');
  assert.equal(sale.reversed_by, null, 'and was never reversed');
  const sales = sale.lines.find((l) => l.account_code === '4100');
  assert.equal(sales.credit_usd, 100, 'at the hundred dollars it was rung up for');
});

test('a gap with no pounds behind it is not called an exchange difference', async () => {
  /*
   * The failure this refuses. Somebody writes a journal entry against cash by
   * hand and the books no longer match the drawer — that is a bookkeeping
   * mistake, and filing it under "the rate moved" puts it in the one account
   * nobody will ever look in for it.
   *
   * Done on the bank, which holds no pounds at all.
   */
  // A bank account of the shop's own, so 1120 is money this report knows about.
  const till = (await req('POST', '/accounts/cash', { name: 'Bank of Beirut', kind: 'bank' })).json;
  assert.ok(till.account, `the bank till was opened: ${JSON.stringify(till)}`);

  const chart = (await req('GET', '/ledger/accounts')).json.accounts;
  const bank = chart.find((a) => a.code === '1120');
  const capital = chart.find((a) => a.code === '3100');
  await req('POST', '/ledger/entries', {
    memo: 'Money the books think is in the bank',
    lines: [
      { accountId: bank.id, debit: 500, credit: 0 },
      { accountId: capital.id, debit: 0, credit: 500 },
    ],
  });

  const r = await report();
  const bankRow = r.accounts.find((a) => a.code === '1120');
  assert.equal(bankRow.holdsPounds, false, 'there are no pounds in it');
  assert.equal(bankRow.unexplained, 500, 'and the gap is reported as unexplained');
  assert.equal(r.unexplained, 500, 'and totalled separately');

  const refused = await req('POST', '/ledger/revaluation');
  assert.equal(refused.status, 400, 'so there is still nothing to restate');
  assert.equal(await balanceOf('5800'), 0, 'and Exchange differences was not used to hide it');
});

test('two tills sharing one ledger account are counted together, once', async () => {
  /*
   * The counter drawer and the safe are both "cash in hand" until a shop says
   * otherwise. Comparing one of them against an account both post to would
   * report the other one as a difference.
   */
  const safe = (await req('POST', '/accounts/cash', { name: 'Back safe', kind: 'safe' })).json.account;
  assert.ok(safe, 'the safe was opened');

  const cash = await cashRow();
  assert.ok(cash.tills.length >= 2, `both tills are behind 1110: ${cash.tills.join(', ')}`);
  assert.equal(cash.difference, 0, 'and an empty second till changes nothing');
});

test('the books are not open to a cashier, and neither is this', async () => {
  const cashier = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' }))
    .json.token;
  assert.equal((await req('GET', '/ledger/revaluation', null, cashier)).status, 403);
  assert.equal((await req('POST', '/ledger/revaluation', {}, cashier)).status, 403);
});

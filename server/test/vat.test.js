/**
 * The VAT return.
 *
 * Two figures and their difference: what the shop **charged** on what it sold,
 * less what it **paid** on what it bought.
 *
 * Read out of the ledger rather than by adding up sales again, and that is the
 * claim worth testing. A return worked out separately is a second derivation
 * of the same period, and when it disagrees with the accounts — which it will,
 * the first time somebody voids a sale — there is no way to tell which is
 * right. So the tests here void things, correct things, and check the return
 * follows.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4649;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;
let widget;
let supplier;
let customer;

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

const ret = async () => (await req('GET', '/ledger/vat')).json;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-vat-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'vat.sqlite'),
    JWT_SECRET: 'vat-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;

  // Eleven per cent, which is what a shop here charges.
  await req('PUT', '/settings', { tax_enabled: true, tax_percent: 11, tax_name: 'VAT' });
  await req('POST', '/cash/open', { openingUsd: 500 });

  widget = (await req('POST', '/products', {
    name: 'Charger', sku: 'VAT-1', price: 100, cost: 60, stock: 50,
  })).json.product;
  supplier = (await req('POST', '/suppliers', { name: 'Wholesaler' })).json.party;
  customer = (await req('POST', '/customers', { name: 'Rami' })).json.party;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('the return knows the rate the shop actually charges', async () => {
  const r = await ret();
  assert.equal(r.enabled, true);
  assert.equal(r.rate, 11);
  assert.equal(r.taxName, 'VAT');
});

test('tax charged on a sale is held for somebody else, not earned', async () => {
  const sale = await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 1 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 111 }],
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const r = await ret();
  assert.equal(r.output, 11, 'eleven per cent of a hundred, charged');
  assert.equal(r.netSales, 100, 'and the hundred is what the shop actually earned');

  // The books agree, which is the whole point of reading the return off them.
  const tb = (await req('GET', '/ledger/trial-balance')).json;
  assert.equal(tb.balanced, true);
  assert.equal(tb.accounts.find((a) => a.code === '2200').balance, 11);
  assert.equal(tb.accounts.find((a) => a.code === '4100').balance, 100);
});

test('tax paid on a purchase comes off what is owed, and never touches the stock value', async () => {
  /*
   * The bug this closes. A purchase invoice used to book its gross total to
   * stock, so every margin was overstated by the tax rate and not a penny of
   * it could be reclaimed.
   */
  const doc = (await req('POST', '/documents', {
    docType: 'purchase_invoice',
    partyId: supplier.id,
    items: [{ productId: widget.id, quantity: 10, price: 50 }],
    taxPercent: 11,
    paymentMethod: 'account',
  })).json.document;
  await req('POST', `/documents/${doc.id}/confirm`);

  const r = await ret();
  assert.ok(r.input > 0, 'there is tax to reclaim');

  const tb = (await req('GET', '/ledger/trial-balance')).json;
  const stock = tb.accounts.find((a) => a.code === '1300');
  const reclaim = tb.accounts.find((a) => a.code === '1250');
  assert.ok(reclaim, 'reclaimable tax has an account of its own');
  assert.equal(
    Math.round((stock.balance + reclaim.balance - doc.total + 60) * 100) / 100,
    0,
    'the stock and the reclaim together are the invoice, less what was already on the shelf',
  );
});

test('the return is what was charged less what was paid', async () => {
  const r = await ret();
  assert.equal(r.due, Math.round((r.output - r.input) * 100) / 100);
});

test('voiding a sale takes its tax back off the return', async () => {
  /*
   * The reason the return is read off the ledger rather than by adding up
   * sales again. A void writes a real entry, so the return follows it without
   * anybody teaching it what a void is.
   */
  const sale = (await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 1 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 111 }],
  })).json.order;

  const charged = (await ret()).output;
  await req('POST', `/orders/${sale.id}/refund`, {});
  assert.equal((await ret()).output, charged - 11, 'the tax on it comes back off');
});

test('a hand-written correction moves the return too', async () => {
  const chart = (await req('GET', '/ledger/accounts')).json.accounts;
  const at = (code) => chart.find((a) => a.code === code).id;

  const before = (await ret()).output;
  await req('POST', '/ledger/entries', {
    memo: 'Tax missed on a cash sale nobody rang up',
    lines: [
      { accountId: at('1110'), debit: 5 },
      { accountId: at('2200'), credit: 5 },
    ],
  });
  assert.equal((await ret()).output, before + 5, 'the books are the return, not a second sum');
});

test('a period is two dates, and only what falls inside it counts', async () => {
  const everything = await ret();
  const nothing = (await req('GET', '/ledger/vat?from=2000-01-01&to=2000-12-31')).json;
  assert.equal(nothing.output, 0, 'a quarter the shop had not opened yet is empty');
  assert.equal(nothing.input, 0);
  assert.ok(everything.output > 0, 'while all of time is not');
});

test('settling it clears both accounts and moves the difference', async () => {
  const before = await ret();
  assert.ok(before.output !== 0 || before.input !== 0, 'there is something to settle');

  const settled = await req('POST', '/ledger/vat/settle', { through: '1120' });
  assert.equal(settled.status, 201, JSON.stringify(settled.json));

  const after = await ret();
  assert.equal(after.output, 0, 'nothing is left charged');
  assert.equal(after.input, 0, 'nor left to reclaim');

  const tb = (await req('GET', '/ledger/trial-balance')).json;
  assert.equal(tb.balanced, true, 'and the books still balance');

  // What was owed really moved through the account the shop named.
  const bank = tb.accounts.find((a) => a.code === '1120');
  assert.ok(bank, 'the money went through the bank');
  assert.equal(Math.abs(bank.balance), Math.abs(before.due));
});

test('settling twice does not pay twice', async () => {
  /*
   * The mistake a screen like this invites: press it again, having forgotten.
   * The lines are built from what is standing on the accounts, so the second
   * one finds nothing left to clear and says so.
   */
  const again = await req('POST', '/ledger/vat/settle', { through: '1120' });
  assert.equal(again.status, 400);
  assert.match(again.json.error, /nothing to settle/i);
});

test('the books are not open to a cashier, and neither is the return', async () => {
  const cashier = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' }))
    .json.token;
  assert.equal((await req('GET', '/ledger/vat', null, cashier)).status, 403);
  assert.equal((await req('POST', '/ledger/vat/settle', {}, cashier)).status, 403);
});

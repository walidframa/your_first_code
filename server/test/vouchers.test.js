/**
 * Payment and receipt vouchers.
 *
 * The thread: money that is neither a sale nor a purchase still has to land in
 * two places at once — the drawer it came out of, and the account it went to.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Taken: 4592 permissions, 4593 wallets, 4594 repairs, 4595 units, 4596 profit,
// 4598 cash, 4599 api.
const PORT = 4591;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let customer;
let supplier;
let wallet;

async function req(method, route, body, token) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

const drawer = async () => (await req('GET', '/cash/current', null, adminToken)).json.expected;
const balanceOf = async (kind, id) =>
  (await req('GET', `/${kind}s/${id}`, null, adminToken)).json.party.balance;
const walletBalance = async (id) =>
  (await req('GET', '/wallets', null, adminToken)).json.wallets.find((w) => w.id === id).balance;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-vouchers-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'vouchers.sqlite'),
    JWT_SECRET: 'vouchers-test-secret-long-enough-for-guard',
    ACCOUNT_SECRET: 'vouchers-account-secret-long-enough-32ch',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;

  customer = (await req('POST', '/customers', { name: 'Rami Haddad', credit_limit: 500 }, adminToken))
    .json.party;
  supplier = (await req('POST', '/suppliers', { name: 'Beirut Phones' }, adminToken)).json.party;
  wallet = (await req('POST', '/wallets', { name: 'Alfa credit' }, adminToken)).json.wallet;

  await req('POST', '/cash/open', { openingUsd: 500, openingLbp: 20000000 }, adminToken);
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- basics */

test('a payment voucher takes the money out of the drawer and numbers itself', async () => {
  const before = await drawer();

  const res = await req(
    'POST',
    '/vouchers',
    {
      kind: 'payment',
      accountType: 'other',
      accountName: 'Abu Khalil the landlord',
      amountUsd: 300,
      reason: 'rent',
      note: 'August rent',
    },
    adminToken,
  );

  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.voucher.voucher_number, 'PV-0001');
  assert.equal(res.json.voucher.account_name, 'Abu Khalil the landlord');

  const after = await drawer();
  assert.equal(Math.round((after.usd - before.usd) * 100) / 100, -300);
});

test('a receipt voucher brings it in, numbered in its own series', async () => {
  const before = await drawer();

  const res = await req(
    'POST',
    '/vouchers',
    { kind: 'receipt', accountType: 'other', accountName: 'The owner', amountUsd: 1000, reason: 'owner_funds' },
    adminToken,
  );

  assert.equal(res.json.voucher.voucher_number, 'RV-0001', 'receipts number apart from payments');
  const after = await drawer();
  assert.equal(Math.round((after.usd - before.usd) * 100) / 100, 1000);
});

test('pounds move as pounds, never as a converted figure', async () => {
  const before = await drawer();
  await req(
    'POST',
    '/vouchers',
    { kind: 'payment', accountType: 'other', accountName: 'Electrician', amountLbp: 4500000, reason: 'other' },
    adminToken,
  );

  const after = await drawer();
  assert.equal(after.lbp - before.lbp, -4500000);
  assert.equal(after.usd, before.usd, 'the dollars did not move');
});

test('a voucher paid by bank does not touch the drawer', async () => {
  const before = await drawer();
  const res = await req(
    'POST',
    '/vouchers',
    {
      kind: 'payment',
      accountType: 'supplier',
      accountId: supplier.id,
      amountUsd: 200,
      method: 'bank',
      reason: 'supplier',
    },
    adminToken,
  );
  assert.equal(res.status, 201);

  const after = await drawer();
  assert.equal(after.usd, before.usd, 'a bank transfer is not cash');
});

test('an amount is required, and a direction is not a minus sign', async () => {
  const empty = await req(
    'POST',
    '/vouchers',
    { kind: 'payment', accountType: 'other', accountName: 'Nobody' },
    adminToken,
  );
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /amount/i);

  const negative = await req(
    'POST',
    '/vouchers',
    { kind: 'payment', accountType: 'other', accountName: 'Nobody', amountUsd: -50 },
    adminToken,
  );
  assert.equal(negative.status, 400);
  assert.match(negative.json.error, /negative/);
});

test('"someone else" needs a name — an unnamed voucher explains nothing', async () => {
  const res = await req(
    'POST',
    '/vouchers',
    { kind: 'payment', accountType: 'other', amountUsd: 10 },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Name who/);
});

/* ----------------------------------------------------------- the ledgers */

test('paying a supplier reduces what the shop owes them', async () => {
  // Something to owe: a bill on their account.
  await req(
    'POST',
    `/suppliers/${supplier.id}/charges`,
    { amountUsd: 400, note: 'Delivery' },
    adminToken,
  );
  const owed = await balanceOf('supplier', supplier.id);

  await req(
    'POST',
    '/vouchers',
    {
      kind: 'payment',
      accountType: 'supplier',
      accountId: supplier.id,
      amountUsd: 150,
      reason: 'supplier',
    },
    adminToken,
  );

  assert.equal(await balanceOf('supplier', supplier.id), Math.round((owed - 150) * 100) / 100);
});

test('a customer paying reduces what they owe', async () => {
  await req('POST', `/customers/${customer.id}/charges`, { amountUsd: 250, note: 'On account' }, adminToken);
  const owed = await balanceOf('customer', customer.id);

  await req(
    'POST',
    '/vouchers',
    { kind: 'receipt', accountType: 'customer', accountId: customer.id, amountUsd: 100, reason: 'customer' },
    adminToken,
  );

  assert.equal(await balanceOf('customer', customer.id), Math.round((owed - 100) * 100) / 100);
});

test('paying a customer money makes them owe more, not less', async () => {
  const owed = await balanceOf('customer', customer.id);

  await req(
    'POST',
    '/vouchers',
    { kind: 'payment', accountType: 'customer', accountId: customer.id, amountUsd: 40, reason: 'refund' },
    adminToken,
  );

  assert.equal(
    await balanceOf('customer', customer.id),
    Math.round((owed + 40) * 100) / 100,
    'money handed to a customer is money they have not yet paid for',
  );
});

test('a supplier refunding the shop increases what is owed to them', async () => {
  const owed = await balanceOf('supplier', supplier.id);

  await req(
    'POST',
    '/vouchers',
    { kind: 'receipt', accountType: 'supplier', accountId: supplier.id, amountUsd: 60, reason: 'refund' },
    adminToken,
  );

  assert.equal(await balanceOf('supplier', supplier.id), Math.round((owed + 60) * 100) / 100);
});

/* ------------------------------------------------------------- a wallet */

test('paying a wallet buys credit; being paid by one takes it back', async () => {
  await req(
    'POST',
    '/vouchers',
    {
      kind: 'payment',
      accountType: 'wallet',
      accountId: wallet.id,
      amountUsd: 250,
      reason: 'wallet_top_up',
    },
    adminToken,
  );
  assert.equal(await walletBalance(wallet.id), 250);

  await req(
    'POST',
    '/vouchers',
    {
      kind: 'receipt',
      accountType: 'wallet',
      accountId: wallet.id,
      amountUsd: 50,
      reason: 'wallet_withdrawal',
    },
    adminToken,
  );
  assert.equal(await walletBalance(wallet.id), 200);
});

/* ---------------------------------------------------------- cancellation */

test('cancelling puts back the cash, the ledger and the credit', async () => {
  const written = (
    await req(
      'POST',
      '/vouchers',
      {
        kind: 'payment',
        accountType: 'wallet',
        accountId: wallet.id,
        amountUsd: 90,
        reason: 'wallet_top_up',
      },
      adminToken,
    )
  ).json.voucher;

  const cash = await drawer();
  const credit = await walletBalance(wallet.id);

  const cancelled = await req('POST', `/vouchers/${written.id}/cancel`, {}, adminToken);
  assert.equal(cancelled.json.voucher.status, 'cancelled');

  assert.equal(Math.round(((await drawer()).usd - cash.usd) * 100) / 100, 90);
  assert.equal(await walletBalance(wallet.id), credit - 90);

  // Kept, not deleted: the number was on a slip somebody signed.
  assert.equal((await req('POST', `/vouchers/${written.id}/cancel`, {}, adminToken)).status, 400);
});

test('a cancelled voucher is out of the totals but still in the list', async () => {
  const { vouchers, summary } = (await req('GET', '/vouchers?preset=today', null, adminToken)).json;

  const cancelled = vouchers.filter((v) => v.status === 'cancelled');
  assert.equal(cancelled.length, 1, 'still listed');
  assert.ok(summary.paidUsd > 0);
  assert.ok(
    !vouchers.some((v) => v.status === 'cancelled' && summary.paidUsd === v.amount_usd),
    'the cancelled amount is not the total',
  );
});

test('vouchers are found by number, name or note', async () => {
  const byNumber = (await req('GET', '/vouchers?search=PV-0001', null, adminToken)).json;
  assert.equal(byNumber.vouchers.length, 1);

  const byName = (await req('GET', '/vouchers?search=landlord', null, adminToken)).json;
  assert.equal(byName.vouchers[0].reason, 'rent');

  const onlyReceipts = (await req('GET', '/vouchers?kind=receipt', null, adminToken)).json;
  assert.ok(onlyReceipts.vouchers.every((v) => v.kind === 'receipt'));
});

test('the desk is its own permission', async () => {
  const cashier = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' })).json
    .token;
  assert.equal((await req('GET', '/vouchers', null, cashier)).status, 403);

  const staff = (await req('GET', '/users', null, adminToken)).json.users.find(
    (u) => u.username === 'cashier',
  );
  await req('PUT', `/users/${staff.id}/permissions`, { permissions: ['register', 'vouchers'] }, adminToken);

  assert.equal((await req('GET', '/vouchers', null, cashier)).status, 200);
  const written = await req(
    'POST',
    '/vouchers',
    { kind: 'payment', accountType: 'other', accountName: 'Water', amountUsd: 5, reason: 'other' },
    cashier,
  );
  assert.equal(written.status, 201);
});

/**
 * Money moving from one account to another.
 *
 * The thread: a voucher names both ends, so nothing appears from nowhere and
 * nothing vanishes — and the shop's own accounts are separate piles that each
 * have to add up on their own.
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
let mainTill;
let deskTill;

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

const registry = async () => (await req('GET', '/accounts/registry', null, adminToken)).json;
const tillBalance = async (id) =>
  (await registry()).registry.cash.find((a) => a.id === id) ?? { balance: 0, balanceLbp: 0 };
const partyBalance = async (type, id) =>
  (await registry()).registry[type].find((p) => p.id === id).balance;
const walletBalance = async (id) => (await registry()).registry.wallet.find((w) => w.id === id).balance;

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

  mainTill = (await registry()).registry.cash[0];
  deskTill = (
    await req('POST', '/accounts/cash', { name: 'Transfer desk', kind: 'desk' }, adminToken)
  ).json.account;

  // Each till is its own sitting, opened separately.
  await req('POST', '/cash/open', { accountId: mainTill.id, openingUsd: 500, openingLbp: 20000000 }, adminToken);
  await req('POST', '/cash/open', { accountId: deskTill.id, openingUsd: 200 }, adminToken);
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ tills */

test('a shop starts with one till and can name as many more as it has', async () => {
  const { registry: reg } = await registry();
  const names = reg.cash.map((a) => a.name);
  assert.ok(names.includes('Main drawer'), 'the one that was always there');
  assert.ok(names.includes('Transfer desk'));
  assert.equal(reg.cash.find((a) => a.name === 'Main drawer').isDefault, true);
});

test('each till counts on its own', async () => {
  assert.equal((await tillBalance(mainTill.id)).balance, 500);
  assert.equal((await tillBalance(deskTill.id)).balance, 200);
});

test('a till can be renamed', async () => {
  const renamed = await req('PUT', `/accounts/cash/${deskTill.id}`, { name: 'OMT desk' }, adminToken);
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.account.name, 'OMT desk');

  await req('PUT', `/accounts/cash/${deskTill.id}`, { name: 'Transfer desk' }, adminToken);
});

test('a till being counted cannot be put away mid-count', async () => {
  const res = await req('DELETE', `/accounts/cash/${deskTill.id}`, null, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Close its cashbox/);
});

test('nor can one with money still in it', async () => {
  const spare = (await req('POST', '/accounts/cash', { name: 'Back safe', kind: 'safe' }, adminToken)).json
    .account;

  // Opened, floated, and closed carrying the whole count forward — which is
  // exactly a safe that has money in it and nobody counting.
  await req('POST', '/cash/open', { accountId: spare.id, openingUsd: 75 }, adminToken);
  await req(
    'POST',
    '/cash/close',
    { accountId: spare.id, countedUsd: 75, carriedUsd: 75 },
    adminToken,
  );

  const res = await req('DELETE', `/accounts/cash/${spare.id}`, null, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /still money/);
});

test('the default till cannot be put away either', async () => {
  const res = await req('DELETE', `/accounts/cash/${mainTill.id}`, null, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /default/);
});

/* --------------------------------------------------------------- vouchers */

test('a payment names the till it came out of', async () => {
  const res = await req(
    'POST',
    '/vouchers',
    {
      fromType: 'cash',
      fromId: mainTill.id,
      toType: 'other',
      toName: 'Abu Khalil the landlord',
      amountUsd: 300,
      reason: 'rent',
      note: 'August rent',
    },
    adminToken,
  );

  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.voucher.kind, 'payment', 'ours out, theirs in');
  assert.equal(res.json.voucher.voucher_number, 'PV-0001');
  assert.equal(res.json.voucher.from_name, 'Main drawer');
  assert.equal(res.json.voucher.to_name, 'Abu Khalil the landlord');

  assert.equal((await tillBalance(mainTill.id)).balance, 200);
  assert.equal((await tillBalance(deskTill.id)).balance, 200, 'the other till is untouched');
});

test('a receipt names the till it went into', async () => {
  const res = await req(
    'POST',
    '/vouchers',
    {
      fromType: 'other',
      fromName: 'The owner',
      toType: 'cash',
      toId: deskTill.id,
      amountUsd: 100,
      reason: 'owner_funds',
    },
    adminToken,
  );

  assert.equal(res.json.voucher.kind, 'receipt');
  assert.equal(res.json.voucher.voucher_number, 'RV-0001', 'its own series');
  assert.equal((await tillBalance(deskTill.id)).balance, 300);
  assert.equal((await tillBalance(mainTill.id)).balance, 200);
});

test('money can be moved between two of the shop’s own tills', async () => {
  const res = await req(
    'POST',
    '/vouchers',
    {
      fromType: 'cash',
      fromId: deskTill.id,
      toType: 'cash',
      toId: mainTill.id,
      amountUsd: 50,
      reason: 'bank_drop',
    },
    adminToken,
  );

  assert.equal(res.json.voucher.kind, 'transfer', 'neither paid nor received — it never left');
  assert.equal(res.json.voucher.voucher_number, 'TV-0001');
  assert.equal((await tillBalance(deskTill.id)).balance, 250);
  assert.equal((await tillBalance(mainTill.id)).balance, 250);
});

test('a voucher between two outsiders is refused — the shop is not involved', async () => {
  const res = await req(
    'POST',
    '/vouchers',
    { fromType: 'customer', fromId: customer.id, toType: 'supplier', toId: supplier.id, amountUsd: 10 },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /One end has to be the shop/);
});

test('money cannot be moved to the account it came from', async () => {
  const res = await req(
    'POST',
    '/vouchers',
    { fromType: 'cash', fromId: mainTill.id, toType: 'cash', toId: mainTill.id, amountUsd: 10 },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /somewhere else/);
});

test('pounds move as pounds, never as a converted figure', async () => {
  const before = await tillBalance(mainTill.id);
  await req(
    'POST',
    '/vouchers',
    { fromType: 'cash', fromId: mainTill.id, toType: 'other', toName: 'Electrician', amountLbp: 4500000 },
    adminToken,
  );

  const after = await tillBalance(mainTill.id);
  assert.equal(after.balanceLbp - before.balanceLbp, -4500000);
  assert.equal(after.balance, before.balance, 'the dollars did not move');
});

test('an amount is required, and a direction is not a minus sign', async () => {
  const empty = await req(
    'POST',
    '/vouchers',
    { fromType: 'cash', fromId: mainTill.id, toType: 'other', toName: 'Nobody' },
    adminToken,
  );
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /amount/i);

  const negative = await req(
    'POST',
    '/vouchers',
    { fromType: 'cash', fromId: mainTill.id, toType: 'other', toName: 'Nobody', amountUsd: -50 },
    adminToken,
  );
  assert.equal(negative.status, 400);
  assert.match(negative.json.error, /negative/);
});

test('"someone else" needs a name — an unnamed voucher explains nothing', async () => {
  const res = await req(
    'POST',
    '/vouchers',
    { fromType: 'cash', fromId: mainTill.id, toType: 'other', amountUsd: 10 },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Name who/);
});

/* ----------------------------------------------------------- the ledgers */

test('paying a supplier reduces what the shop owes them', async () => {
  const billed = await req(
    'POST',
    `/suppliers/${supplier.id}/charges`,
    { amount: 400, note: 'Delivery' },
    adminToken,
  );
  assert.equal(billed.status, 201, JSON.stringify(billed.json));
  const owed = await partyBalance('supplier', supplier.id);

  await req(
    'POST',
    '/vouchers',
    {
      fromType: 'cash',
      fromId: mainTill.id,
      toType: 'supplier',
      toId: supplier.id,
      amountUsd: 150,
      reason: 'supplier',
    },
    adminToken,
  );

  assert.equal(await partyBalance('supplier', supplier.id), Math.round((owed - 150) * 100) / 100);
});

test('a customer paying reduces what they owe', async () => {
  const charged = await req(
    'POST',
    `/customers/${customer.id}/charges`,
    { amount: 250, note: 'On account' },
    adminToken,
  );
  assert.equal(charged.status, 201, JSON.stringify(charged.json));
  const owed = await partyBalance('customer', customer.id);

  await req(
    'POST',
    '/vouchers',
    {
      fromType: 'customer',
      fromId: customer.id,
      toType: 'cash',
      toId: mainTill.id,
      amountUsd: 100,
      reason: 'customer',
    },
    adminToken,
  );

  assert.equal(await partyBalance('customer', customer.id), Math.round((owed - 100) * 100) / 100);
});

test('paying a customer money makes them owe more, not less', async () => {
  const owed = await partyBalance('customer', customer.id);

  await req(
    'POST',
    '/vouchers',
    {
      fromType: 'cash',
      fromId: mainTill.id,
      toType: 'customer',
      toId: customer.id,
      amountUsd: 40,
      reason: 'refund',
    },
    adminToken,
  );

  assert.equal(
    await partyBalance('customer', customer.id),
    Math.round((owed + 40) * 100) / 100,
    'money handed to a customer is money they have not yet paid for',
  );
});

test('a supplier refunding the shop increases what is owed to them', async () => {
  const owed = await partyBalance('supplier', supplier.id);

  await req(
    'POST',
    '/vouchers',
    {
      fromType: 'supplier',
      fromId: supplier.id,
      toType: 'cash',
      toId: mainTill.id,
      amountUsd: 60,
      reason: 'refund',
    },
    adminToken,
  );

  assert.equal(await partyBalance('supplier', supplier.id), Math.round((owed + 60) * 100) / 100);
});

/* ------------------------------------------------------------- a wallet */

test('buying credit moves it from a till into the wallet', async () => {
  const cash = (await tillBalance(mainTill.id)).balance;

  await req(
    'POST',
    '/vouchers',
    {
      fromType: 'cash',
      fromId: mainTill.id,
      toType: 'wallet',
      toId: wallet.id,
      amountUsd: 250,
      reason: 'wallet_top_up',
    },
    adminToken,
  );

  assert.equal(await walletBalance(wallet.id), 250);
  assert.equal((await tillBalance(mainTill.id)).balance, Math.round((cash - 250) * 100) / 100);
});

test('taking credit back out puts the cash back', async () => {
  await req(
    'POST',
    '/vouchers',
    {
      fromType: 'wallet',
      fromId: wallet.id,
      toType: 'cash',
      toId: mainTill.id,
      amountUsd: 50,
    },
    adminToken,
  );
  assert.equal(await walletBalance(wallet.id), 200);
});

/* ---------------------------------------------------------- cancellation */

test('cancelling puts back both ends at once', async () => {
  const written = (
    await req(
      'POST',
      '/vouchers',
      {
        fromType: 'cash',
        fromId: mainTill.id,
        toType: 'wallet',
        toId: wallet.id,
        amountUsd: 90,
        reason: 'wallet_top_up',
      },
      adminToken,
    )
  ).json.voucher;

  const cash = (await tillBalance(mainTill.id)).balance;
  const credit = await walletBalance(wallet.id);

  const cancelled = await req('POST', `/vouchers/${written.id}/cancel`, {}, adminToken);
  assert.equal(cancelled.json.voucher.status, 'cancelled');

  assert.equal((await tillBalance(mainTill.id)).balance, Math.round((cash + 90) * 100) / 100);
  assert.equal(await walletBalance(wallet.id), credit - 90);

  // Kept, not deleted: the number was on a slip somebody signed.
  assert.equal((await req('POST', `/vouchers/${written.id}/cancel`, {}, adminToken)).status, 400);
});

test('transfers between own accounts are in neither total', async () => {
  const { summary } = (await req('GET', '/vouchers?preset=today', null, adminToken)).json;
  assert.ok(summary.transfers >= 1);
  assert.ok(summary.paidUsd > 0);
  assert.ok(summary.receivedUsd > 0);
});

test('vouchers are found by number or by either end', async () => {
  assert.equal((await req('GET', '/vouchers?search=PV-0001', null, adminToken)).json.vouchers.length, 1);

  const byName = (await req('GET', '/vouchers?search=landlord', null, adminToken)).json;
  assert.equal(byName.vouchers[0].reason, 'rent');

  const byTill = (await req('GET', '/vouchers?search=Transfer desk', null, adminToken)).json;
  assert.ok(byTill.vouchers.length > 0, 'the till is an end like any other');
});

/* -------------------------------------------------------------- who owes */

test('the registry answers who owes the shop and who it owes', async () => {
  const { summary } = await registry();

  assert.ok(summary.receivable > 0, 'somebody owes us');
  assert.equal(summary.receivableCount, 1);
  assert.ok(summary.payable > 0, 'we owe somebody');
  assert.equal(summary.payableCount, 1);

  // The shop's own money is counted apart from what is owed either way.
  assert.ok(summary.cashUsd > 0);
  assert.equal(summary.walletUsd, 200);
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
    { fromType: 'cash', fromId: mainTill.id, toType: 'other', toName: 'Water', amountUsd: 5 },
    cashier,
  );
  assert.equal(written.status, 201);

  // Naming a till is the cashbox's business, not the voucher desk's.
  assert.equal(
    (await req('POST', '/accounts/cash', { name: 'Sneaky till' }, cashier)).status,
    403,
  );
});

/* --------------------------------------------- money taken on an invoice */

/**
 * An invoice settled at the counter is a receipt like any other.
 *
 * It used to move the drawer and the customer's ledger silently, so an owner
 * reading down the vouchers for the day's takings saw everything except the
 * invoices — usually the largest part of it.
 */
test('an invoice paid in cash writes its own receipt', async () => {
  const before = (await tillBalance(mainTill.id)).balance;

  const product = (
    await req('POST', '/products', { name: 'Charger', sku: 'CHG-1', price: 12, cost: 5, stock: 10 }, adminToken)
  ).json.product;

  const draft = await req(
    'POST',
    '/documents',
    {
      docType: 'sales_invoice',
      partyId: customer.id,
      items: [{ productId: product.id, quantity: 1, price: 12 }],
      payments: [{ currency: 'USD', amount: 12 }],
      paymentMethod: 'cash',
    },
    adminToken,
  );
  assert.equal(draft.status, 201);
  const doc = draft.json.document;

  assert.equal((await req('POST', `/documents/${doc.id}/confirm`, null, adminToken)).status, 200);

  const found = (await req('GET', `/vouchers?search=${doc.doc_number}`, null, adminToken)).json.vouchers;
  assert.equal(found.length, 1, 'one slip for one payment');
  assert.equal(found[0].kind, 'receipt', 'money coming in');
  assert.equal(found[0].amount_usd, 12);
  assert.equal(found[0].to_name, mainTill.name, 'into the till it was paid into');
  assert.equal(found[0].from_name, 'Rami Haddad');

  // Written, not applied: the drawer moved once, when the invoice was confirmed.
  assert.equal((await tillBalance(mainTill.id)).balance, before + 12);

  // And it cannot be undone here, which would hand the money back a second time.
  const refused = await req('POST', `/vouchers/${found[0].id}/cancel`, null, adminToken);
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /cancel that invoice instead/);

  // Cancelling the invoice voids the slip with it, and puts the money back once.
  assert.equal((await req('POST', `/documents/${doc.id}/cancel`, null, adminToken)).status, 200);
  assert.equal((await tillBalance(mainTill.id)).balance, before);
  const after = (await req('GET', `/vouchers?search=${doc.doc_number}`, null, adminToken)).json.vouchers;
  assert.equal(after[0].status, 'cancelled');
});

/* ---------------------------------------- settling an account at the counter */

/*
 * Paying off a balance is the same act as every other movement of money in and
 * out of a till, so it goes in the same book and comes out with the same slip.
 * It used to be two calls that each did half of it, and one half could fail
 * silently — see the route.
 */
test('a customer settling their account gets a numbered slip', async () => {
  const customer = (
    await req('POST', '/customers', { name: 'Settling Up', credit_limit: 500 }, adminToken)
  ).json.party;
  await req('POST', `/customers/${customer.id}/charges`, { amount: 80 }, adminToken);

  const before = (await tillBalance(mainTill.id)).balance;
  const paid = await req(
    'POST',
    `/customers/${customer.id}/payments`,
    { payments: [{ currency: 'USD', amount: 30 }], note: 'On account' },
    adminToken,
  );
  assert.equal(paid.status, 201, JSON.stringify(paid.json));

  // A receipt, because the money came in. The direction is the two accounts.
  assert.match(paid.json.voucher.voucher_number, /^RV-/);
  assert.equal(paid.json.voucher.kind, 'receipt');
  assert.equal(paid.json.voucher.from_name, 'Settling Up');
  assert.equal(paid.json.balance, 50, '80 owed less 30 paid');
  assert.equal((await tillBalance(mainTill.id)).balance, before + 30, 'and the drawer has it');
});

test('paying a supplier is the same slip the other way round', async () => {
  const supplier = (await req('POST', '/suppliers', { name: 'Owed Money Co' }, adminToken)).json.party;
  await req('POST', `/suppliers/${supplier.id}/charges`, { amount: 100 }, adminToken);

  const before = (await tillBalance(mainTill.id)).balance;
  const paid = await req(
    'POST',
    `/suppliers/${supplier.id}/payments`,
    { payments: [{ currency: 'USD', amount: 40 }] },
    adminToken,
  );
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  assert.match(paid.json.voucher.voucher_number, /^PV-/);
  assert.equal(paid.json.voucher.to_name, 'Owed Money Co');
  assert.equal(paid.json.balance, 60, '100 owed less 40 paid');
  assert.equal((await tillBalance(mainTill.id)).balance, before - 40, 'out of the drawer');
});

/*
 * The slip is reachable from the line it wrote, which is what makes reprinting
 * and voiding possible without hunting through the voucher book by number.
 */
test('the payment’s slip is on the account it settled', async () => {
  const customer = (
    await req('POST', '/customers', { name: 'Has A Slip', credit_limit: 500 }, adminToken)
  ).json.party;
  await req('POST', `/customers/${customer.id}/charges`, { amount: 25 }, adminToken);
  const paid = await req(
    'POST',
    `/customers/${customer.id}/payments`,
    { payments: [{ currency: 'USD', amount: 25 }] },
    adminToken,
  );

  const detail = (await req('GET', `/customers/${customer.id}`, null, adminToken)).json;
  const slip = detail.vouchers.find((v) => v.id === paid.json.voucher.id);
  assert.ok(slip, 'the account knows which slip its payment wrote');
  assert.ok(
    detail.entries.some((e) => e.id === slip.entry_id),
    'and it is keyed to the line that moved the balance',
  );

  // Voided, and the money goes back the way it came.
  const voided = await req('POST', `/vouchers/${slip.id}/cancel`, null, adminToken);
  assert.equal(voided.status, 200, JSON.stringify(voided.json));
  assert.equal(voided.json.voucher.status, 'cancelled');

  const after = (await req('GET', `/customers/${customer.id}`, null, adminToken)).json;
  assert.equal(after.party.balance, 25, 'they owe it again');
});

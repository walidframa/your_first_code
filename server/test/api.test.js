import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let cashierToken;

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
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready in time');
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-test-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'test.sqlite'),
    JWT_SECRET: 'test-secret-long-enough-for-the-production-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  cashierToken = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' })).json.token;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------- auth */

test('issues tokens for valid credentials', () => {
  assert.ok(adminToken);
  assert.ok(cashierToken);
});

test('rejects a bad password', async () => {
  const res = await req('POST', '/auth/login', { username: 'admin', password: 'wrong' });
  assert.equal(res.status, 401);
});

test('rejects requests with no token', async () => {
  assert.equal((await req('GET', '/products')).status, 401);
});

/* --------------------------------------------------------------- products */

test('looks a product up by barcode', async () => {
  const res = await req('GET', '/products/lookup?code=5012345000011', null, cashierToken);
  assert.equal(res.json.product.name, 'Espresso');
});

test('looks a product up by SKU, case-insensitively', async () => {
  const res = await req('GET', '/products/lookup?code=bak-001', null, cashierToken);
  assert.equal(res.json.product.name, 'Croissant');
});

test('returns 404 for an unknown code', async () => {
  assert.equal((await req('GET', '/products/lookup?code=nope', null, cashierToken)).status, 404);
});

test('blocks cashiers from creating products', async () => {
  const res = await req('POST', '/products', { name: 'X', sku: 'X-1', price: 1 }, cashierToken);
  assert.equal(res.status, 403);
});

/* ----------------------------------------------------------------- orders */

test('records a cash sale and computes tax and change', async () => {
  const espresso = (await req('GET', '/products/lookup?code=BEV-001', null, cashierToken)).json.product;
  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: espresso.id, quantity: 2 }], paymentMethod: 'cash', amountTendered: 20 },
    cashierToken,
  );
  assert.equal(res.status, 201);
  assert.equal(res.json.order.subtotal, 7);
  assert.equal(res.json.order.tax, 0.56);
  assert.equal(res.json.order.total, 7.56);
  assert.equal(res.json.order.change_due, 12.44);
});

test('applies a percentage discount before tax', async () => {
  const espresso = (await req('GET', '/products/lookup?code=BEV-001', null, cashierToken)).json.product;
  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: espresso.id, quantity: 2 }], discountPercent: 10, paymentMethod: 'card' },
    cashierToken,
  );
  assert.equal(res.json.order.discount, 0.7);
  assert.equal(res.json.order.tax, 0.5);
  assert.equal(res.json.order.total, 6.8);
});

test('decrements stock as part of the sale', async () => {
  const before = (await req('GET', '/products/lookup?code=BAK-002', null, cashierToken)).json.product;
  await req(
    'POST',
    '/orders',
    { items: [{ productId: before.id, quantity: 3 }], paymentMethod: 'card' },
    cashierToken,
  );
  const after = (await req('GET', '/products/lookup?code=BAK-002', null, cashierToken)).json.product;
  assert.equal(after.stock, before.stock - 3);
});

test('refuses to oversell', async () => {
  const product = (await req('GET', '/products/lookup?code=BAK-004', null, cashierToken)).json.product;
  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: product.id, quantity: product.stock + 1 }], paymentMethod: 'card' },
    cashierToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Not enough stock/);

  const after = (await req('GET', '/products/lookup?code=BAK-004', null, cashierToken)).json.product;
  assert.equal(after.stock, product.stock, 'stock must be unchanged after a failed sale');
});

test('refuses cash payment below the total', async () => {
  const product = (await req('GET', '/products/lookup?code=APP-001', null, cashierToken)).json.product;
  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'cash', amountTendered: 1 },
    cashierToken,
  );
  assert.equal(res.status, 400);
});

test('rejects an empty cart', async () => {
  const res = await req('POST', '/orders', { items: [], paymentMethod: 'card' }, cashierToken);
  assert.equal(res.status, 400);
});

test('refunds restore stock and mark the order refunded', async () => {
  const product = (await req('GET', '/products/lookup?code=SNK-001', null, cashierToken)).json.product;
  const order = (
    await req(
      'POST',
      '/orders',
      { items: [{ productId: product.id, quantity: 4 }], paymentMethod: 'card' },
      cashierToken,
    )
  ).json.order;

  const refund = await req('POST', `/orders/${order.id}/refund`, null, adminToken);
  assert.equal(refund.json.order.status, 'refunded');

  const after = (await req('GET', '/products/lookup?code=SNK-001', null, cashierToken)).json.product;
  assert.equal(after.stock, product.stock);
});

test('blocks cashiers from refunding', async () => {
  const orders = (await req('GET', '/orders', null, adminToken)).json.orders;
  const completed = orders.find((o) => o.status === 'completed');
  assert.equal((await req('POST', `/orders/${completed.id}/refund`, null, cashierToken)).status, 403);
});

/* -------------------------------------------------------- dual currency */

test('settings expose a default rate that cashiers can read', async () => {
  const res = await req('GET', '/settings', null, cashierToken);
  assert.equal(res.status, 200);
  assert.ok(res.json.settings.exchange_rate > 0);
  assert.ok(res.json.settings.lbp_rounding >= 1);
});

test('only admins can change the rate', async () => {
  assert.equal((await req('PUT', '/settings', { exchange_rate: 90000 }, cashierToken)).status, 403);
});

test('rejects a nonsensical rate', async () => {
  assert.equal((await req('PUT', '/settings', { exchange_rate: 0 }, adminToken)).status, 400);
  assert.equal((await req('PUT', '/settings', { exchange_rate: -5 }, adminToken)).status, 400);
  assert.equal((await req('PUT', '/settings', { exchange_rate: 'abc' }, adminToken)).status, 400);
});

test('changing the rate records history, and a no-op change does not', async () => {
  const changed = await req('PUT', '/settings', { exchange_rate: 90500, lbp_rounding: 1000 }, adminToken);
  assert.equal(changed.json.settings.exchange_rate, 90500);

  let history = (await req('GET', '/settings/rate-history', null, adminToken)).json.history;
  assert.equal(history[0].rate, 90500);
  assert.equal(history[0].user_name, 'Store Owner');
  const countAfterChange = history.length;

  // Re-submitting the same rate is not a rate change and must not add noise.
  await req('PUT', '/settings', { exchange_rate: 90500 }, adminToken);
  history = (await req('GET', '/settings/rate-history', null, adminToken)).json.history;
  assert.equal(history.length, countAfterChange);

  // Restore the rate the rest of the suite prices against.
  await req('PUT', '/settings', { exchange_rate: 89000 }, adminToken);
  assert.equal((await req('GET', '/settings', null, adminToken)).json.settings.exchange_rate, 89000);
});

test('paying entirely in LBP settles a USD-priced sale', async () => {
  const product = (await req('GET', '/products/lookup?code=SNK-003', null, cashierToken)).json.product;
  // 2 × 2.25 = 4.50 USD, +8% tax = 4.86 USD → 432,540 LBP at 89,000.
  const res = await req(
    'POST',
    '/orders',
    {
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: 'cash',
      payments: [{ currency: 'LBP', amount: 500000 }],
      changeCurrency: 'LBP',
    },
    cashierToken,
  );

  assert.equal(res.status, 201);
  const order = res.json.order;
  assert.equal(order.total, 4.86);
  assert.equal(order.paid_lbp, 500000);
  assert.equal(order.paid_usd, 0);
  assert.equal(order.exchange_rate, 89000, 'the rate in force is recorded on the order');
  // 500,000 LBP ≈ 5.62 USD, so change ≈ 0.76 USD ≈ 67,640 LBP → 68,000.
  assert.equal(order.change_lbp, 68000);
  assert.equal(order.change_usd, 0);
  assert.equal(order.change_currency, 'LBP');
});

test('a split USD + LBP tender settles and returns change in USD', async () => {
  const product = (await req('GET', '/products/lookup?code=SNK-003', null, cashierToken)).json.product;
  const res = await req(
    'POST',
    '/orders',
    {
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: 'cash',
      payments: [
        { currency: 'USD', amount: 3 },
        { currency: 'LBP', amount: 200000 },
      ],
      changeCurrency: 'USD',
    },
    cashierToken,
  );

  assert.equal(res.status, 201);
  const order = res.json.order;
  assert.equal(order.paid_usd, 3);
  assert.equal(order.paid_lbp, 200000);
  // 3 USD + 200,000 LBP (2.25 USD) = 5.25 USD against a 4.86 total.
  assert.equal(order.amount_tendered, 5.25);
  assert.equal(order.change_usd, 0.39);
  assert.equal(order.change_lbp, 0);
});

test('refuses a tender that falls short across both currencies', async () => {
  const product = (await req('GET', '/products/lookup?code=SNK-003', null, cashierToken)).json.product;
  const res = await req(
    'POST',
    '/orders',
    {
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: 'cash',
      payments: [
        { currency: 'USD', amount: 1 },
        { currency: 'LBP', amount: 100000 },
      ],
    },
    cashierToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /less than/i);
});

test('rejects an unknown tender currency', async () => {
  const product = (await req('GET', '/products/lookup?code=SNK-003', null, cashierToken)).json.product;
  const res = await req(
    'POST',
    '/orders',
    {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      payments: [{ currency: 'EUR', amount: 50 }],
    },
    cashierToken,
  );
  assert.equal(res.status, 400);
});

test('a rate change does not alter already-recorded orders', async () => {
  const product = (await req('GET', '/products/lookup?code=SNK-003', null, cashierToken)).json.product;
  const before = (
    await req(
      'POST',
      '/orders',
      {
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        payments: [{ currency: 'LBP', amount: 500000 }],
        changeCurrency: 'LBP',
      },
      cashierToken,
    )
  ).json.order;

  await req('PUT', '/settings', { exchange_rate: 100000 }, adminToken);
  const reread = (await req('GET', `/orders/${before.id}`, null, cashierToken)).json.order;
  assert.equal(reread.exchange_rate, 89000, 'historical order keeps the rate it was sold at');
  assert.equal(reread.change_lbp, before.change_lbp);

  await req('PUT', '/settings', { exchange_rate: 89000 }, adminToken);
});

test('card sales record no tender and no change', async () => {
  const product = (await req('GET', '/products/lookup?code=SNK-003', null, cashierToken)).json.product;
  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'card' },
    cashierToken,
  );
  assert.equal(res.status, 201);
  assert.equal(res.json.order.paid_usd, 0);
  assert.equal(res.json.order.paid_lbp, 0);
  assert.equal(res.json.order.change_currency, null);
});

/* -------------------------------------------------------------- inventory */

test('inventory overview is admin only', async () => {
  assert.equal((await req('GET', '/inventory', null, cashierToken)).status, 403);
  assert.equal((await req('GET', '/inventory', null, adminToken)).status, 200);
});

test('inventory flags out-of-stock and low-stock items', async () => {
  const res = await req('GET', '/inventory', null, adminToken);
  assert.ok(res.json.totals.outOfStock >= 1);
  assert.ok(res.json.totals.lowStock >= 1);
  assert.ok(res.json.totals.retailValue > 0);
});

test('applies a stock adjustment and writes the ledger', async () => {
  const product = (await req('GET', '/products/lookup?code=APP-004', null, adminToken)).json.product;
  const res = await req(
    'POST',
    '/inventory/adjust',
    { productId: product.id, delta: 25, reason: 'received', note: 'PO #1042' },
    adminToken,
  );
  assert.equal(res.json.resultingStock, product.stock + 25);

  const moves = (await req('GET', `/inventory/movements?productId=${product.id}`, null, adminToken)).json
    .movements;
  assert.equal(moves[0].delta, 25);
  assert.equal(moves[0].reason, 'received');
  assert.equal(moves[0].note, 'PO #1042');
  assert.equal(moves[0].user_name, 'Store Owner');
});

test('refuses an adjustment that would go below zero', async () => {
  const product = (await req('GET', '/products/lookup?code=APP-004', null, adminToken)).json.product;
  const res = await req(
    'POST',
    '/inventory/adjust',
    { productId: product.id, delta: -99999, reason: 'damaged' },
    adminToken,
  );
  assert.equal(res.status, 400);
});

test('rejects an unknown adjustment reason', async () => {
  const product = (await req('GET', '/products/lookup?code=APP-004', null, adminToken)).json.product;
  const res = await req(
    'POST',
    '/inventory/adjust',
    { productId: product.id, delta: 1, reason: 'nonsense' },
    adminToken,
  );
  assert.equal(res.status, 400);
});

/* ----------------------------------------------------------------- import */

const SHOPIFY_CSV = [
  'Handle,Title,Vendor,Type,Variant SKU,Variant Price,Variant Inventory Qty,Cost per item,Variant Barcode,Image Src',
  'flat-white,Flat White,Blue Bottle,Beverages,BEV-910,"4,50",30,1.60,5012345000202,',
  'espresso,Espresso Refreshed,Blue Bottle,Beverages,BEV-001,$3.95,140,1.10,5012345000011,',
  'bad-row,,NoVendor,Beverages,,notanumber,5,,,',
].join('\n');

test('import preview detects format, maps columns and classifies rows', async () => {
  const res = await req('POST', '/imports/preview', { csv: SHOPIFY_CSV }, adminToken);
  assert.equal(res.json.detectedFormat, 'shopify');
  assert.equal(res.json.mapping.name, 'Title');
  assert.equal(res.json.summary.create, 1);
  assert.equal(res.json.summary.update, 1);
  assert.equal(res.json.summary.error, 1);
  assert.equal(res.json.rows[0].data.price, 4.5, 'comma decimal parsed');
  assert.equal(res.json.rows[1].data.price, 3.95, 'currency symbol stripped');
  assert.ok(res.json.rows[2].errors.length >= 2);
});

test('import commit creates, updates and reports errors', async () => {
  const res = await req('POST', '/imports/commit', { csv: SHOPIFY_CSV }, adminToken);
  assert.equal(res.json.created, 1);
  assert.equal(res.json.updated, 1);
  assert.equal(res.json.errors.length, 1);

  const created = (await req('GET', '/products/lookup?code=BEV-910', null, adminToken)).json.product;
  assert.equal(created.name, 'Flat White');
  assert.equal(created.price, 4.5);
  assert.equal(created.supplier, 'Blue Bottle');

  const updated = (await req('GET', '/products/lookup?code=BEV-001', null, adminToken)).json.product;
  assert.equal(updated.name, 'Espresso Refreshed');
  assert.equal(updated.stock, 140);
});

test('import writes stock changes to the inventory ledger', async () => {
  const moves = (await req('GET', '/inventory/movements?limit=200', null, adminToken)).json.movements;
  assert.ok(moves.some((m) => (m.note || '').includes('CSV import')));
});

test('import handles semicolon-delimited generic CSVs and new categories', async () => {
  const csv = 'Product Name;Code;Sale Price;Quantity;Department\nDesk Lamp;HOM-901;24,99;12;Home Goods';
  const preview = await req('POST', '/imports/preview', { csv }, adminToken);
  assert.equal(preview.json.rows[0].data.name, 'Desk Lamp');
  assert.equal(preview.json.rows[0].data.price, 24.99);

  const commit = await req('POST', '/imports/commit', { csv }, adminToken);
  assert.equal(commit.json.created, 1);
  assert.equal(commit.json.categoriesCreated, 1);
});

test('import flags duplicate SKUs within one file', async () => {
  const csv = 'name,sku,price\nA,DUP-1,1\nB,DUP-1,2';
  const res = await req('POST', '/imports/preview', { csv }, adminToken);
  assert.ok(res.json.rows[1].errors.some((e) => /Duplicate/i.test(e)));
});

test('import is admin only', async () => {
  const res = await req('POST', '/imports/preview', { csv: 'name,sku,price\nA,A-1,1' }, cashierToken);
  assert.equal(res.status, 403);
});

/* --------------------------------------------------- customers & accounts */

let customerId;
let supplierId;

test('creates a customer with a credit limit', async () => {
  const res = await req(
    'POST',
    '/customers',
    { name: 'Rami Haddad', phone: '03 111 222', credit_limit: 100 },
    adminToken,
  );
  assert.equal(res.status, 201);
  assert.equal(res.json.party.balance, 0);
  assert.equal(res.json.party.credit_limit, 100);
  customerId = res.json.party.id;
});

test('creates a customer with an opening balance', async () => {
  const res = await req(
    'POST',
    '/customers',
    { name: 'Carried Over', credit_limit: 500, opening_balance: 75 },
    adminToken,
  );
  assert.equal(res.json.party.balance, 75, 'opening balance lands in the ledger');
});

test('rejects a nameless party and a negative credit limit', async () => {
  assert.equal((await req('POST', '/customers', { name: '   ' }, adminToken)).status, 400);
  assert.equal((await req('POST', '/customers', { name: 'X', credit_limit: -5 }, adminToken)).status, 400);
});

test('cashiers can list customers but not create them', async () => {
  assert.equal((await req('GET', '/customers', null, cashierToken)).status, 200);
  assert.equal((await req('POST', '/customers', { name: 'Nope' }, cashierToken)).status, 403);
});

test('an account sale increases what the customer owes', async () => {
  const product = (await req('GET', '/products/lookup?code=BAK-002', null, cashierToken)).json.product;
  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: product.id, quantity: 2 }], paymentMethod: 'account', customerId },
    cashierToken,
  );
  assert.equal(res.status, 201);
  assert.equal(res.json.order.payment_method, 'account');
  assert.equal(res.json.order.customer_id, customerId);

  const detail = await req('GET', `/customers/${customerId}`, null, adminToken);
  assert.equal(detail.json.party.balance, res.json.order.total);
  assert.equal(detail.json.entries[0].kind, 'sale');
});

test('an account sale requires a customer', async () => {
  const product = (await req('GET', '/products/lookup?code=BAK-002', null, cashierToken)).json.product;
  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'account' },
    cashierToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /customer is required/i);
});

test('the credit limit is enforced', async () => {
  const tight = (
    await req('POST', '/customers', { name: 'Tight Limit', credit_limit: 5 }, adminToken)
  ).json.party;
  const product = (await req('GET', '/products/lookup?code=APP-001', null, cashierToken)).json.product;

  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'account', customerId: tight.id },
    cashierToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /credit limit/i);

  // The failed sale must not have moved stock or the balance.
  const after = (await req('GET', '/products/lookup?code=APP-001', null, cashierToken)).json.product;
  assert.equal(after.stock, product.stock);
  assert.equal((await req('GET', `/customers/${tight.id}`, null, adminToken)).json.party.balance, 0);
});

test('a payment in mixed currency reduces the balance', async () => {
  const before = (await req('GET', `/customers/${customerId}`, null, adminToken)).json.party.balance;

  const res = await req(
    'POST',
    `/customers/${customerId}/payments`,
    {
      payments: [
        { currency: 'USD', amount: 2 },
        { currency: 'LBP', amount: 178000 },
      ],
      note: 'Part payment',
    },
    adminToken,
  );

  assert.equal(res.status, 201);
  assert.equal(res.json.amountUsd, 4, '2 USD + 178,000 LL = 4 USD at 89,000');
  assert.equal(res.json.balance, Math.round((before - 4) * 100) / 100);
});

test('rejects an empty or zero payment', async () => {
  assert.equal(
    (await req('POST', `/customers/${customerId}/payments`, { payments: [] }, adminToken)).status,
    400,
  );
  assert.equal(
    (
      await req(
        'POST',
        `/customers/${customerId}/payments`,
        { payments: [{ currency: 'USD', amount: 0 }] },
        adminToken,
      )
    ).status,
    400,
  );
});

test('refunding an account sale credits the customer back', async () => {
  const fresh = (
    await req('POST', '/customers', { name: 'Refund Me', credit_limit: 200 }, adminToken)
  ).json.party;
  const product = (await req('GET', '/products/lookup?code=BAK-002', null, cashierToken)).json.product;

  const order = (
    await req(
      'POST',
      '/orders',
      { items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'account', customerId: fresh.id },
      cashierToken,
    )
  ).json.order;

  assert.equal((await req('GET', `/customers/${fresh.id}`, null, adminToken)).json.party.balance, order.total);

  await req('POST', `/orders/${order.id}/refund`, null, adminToken);
  assert.equal(
    (await req('GET', `/customers/${fresh.id}`, null, adminToken)).json.party.balance,
    0,
    'refund clears what the sale added',
  );
});

test('a customer with a balance cannot be archived', async () => {
  const res = await req('DELETE', `/customers/${customerId}`, null, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /outstanding balance/i);
});

test('a settled customer can be archived', async () => {
  const settled = (await req('POST', '/customers', { name: 'Settled' }, adminToken)).json.party;
  assert.equal((await req('DELETE', `/customers/${settled.id}`, null, adminToken)).status, 200);
  const list = (await req('GET', '/customers', null, adminToken)).json.parties;
  assert.ok(!list.some((p) => p.id === settled.id), 'archived customers drop out of the default list');
});

test('supplier bills and payments move the payable', async () => {
  const supplier = (
    await req('POST', '/suppliers', { name: 'Corner Bakehouse', phone: '01 555 666' }, adminToken)
  ).json.party;
  supplierId = supplier.id;

  await req('POST', `/suppliers/${supplierId}/charges`, { amount: 250, note: 'Invoice 88' }, adminToken);
  assert.equal((await req('GET', `/suppliers/${supplierId}`, null, adminToken)).json.party.balance, 250);

  await req(
    'POST',
    `/suppliers/${supplierId}/payments`,
    { payments: [{ currency: 'USD', amount: 100 }] },
    adminToken,
  );
  assert.equal((await req('GET', `/suppliers/${supplierId}`, null, adminToken)).json.party.balance, 150);
});

test('suppliers have no credit limit field', async () => {
  const res = await req('POST', '/suppliers', { name: 'No Limit Co', credit_limit: 999 }, adminToken);
  assert.equal(res.status, 201);
  assert.equal(res.json.party.credit_limit, undefined);
});

test('the accounts summary reports both sides of the book', async () => {
  const res = await req('GET', '/accounts/summary', null, adminToken);
  assert.equal(res.status, 200);
  assert.ok(res.json.receivable > 0, 'customers owe something');
  assert.equal(res.json.payable, 150, 'the supplier is still owed 150');
  assert.equal(res.json.net, Math.round((res.json.receivable - res.json.payable) * 100) / 100);
  assert.ok(Array.isArray(res.json.topDebtors));
});

test('the accounts feed is admin only', async () => {
  assert.equal((await req('GET', '/accounts/summary', null, cashierToken)).status, 403);
  assert.equal((await req('GET', '/accounts/entries', null, cashierToken)).status, 403);
  assert.equal((await req('GET', '/accounts/entries', null, adminToken)).status, 200);
});

test('the cash-flow feed names the party and the order', async () => {
  const entries = (await req('GET', '/accounts/entries', null, adminToken)).json.entries;
  assert.ok(entries.length > 0);
  assert.ok(entries.some((e) => e.party_name && e.kind === 'payment'));
  assert.ok(entries.some((e) => e.order_number));
});

/* -------------------------------------------------------------- documents */

async function product(sku, token = adminToken) {
  return (await req('GET', `/products/lookup?code=${sku}`, null, token)).json.product;
}

test('a purchase invoice receives stock and creates a payable', async () => {
  const supplier = (await req('POST', '/suppliers', { name: 'Stock Source' }, adminToken)).json.party;
  const item = await product('SNK-002');

  const created = await req(
    'POST',
    '/documents',
    {
      docType: 'purchase_invoice',
      partyId: supplier.id,
      items: [{ productId: item.id, quantity: 24, price: 1.2 }],
    },
    adminToken,
  );
  assert.equal(created.status, 201);
  assert.equal(created.json.document.status, 'draft');
  assert.match(created.json.document.doc_number, /^PI-\d{4}$/);
  assert.equal(created.json.document.subtotal, 28.8, '24 × 1.20');

  // A draft is inert.
  assert.equal((await product('SNK-002')).stock, item.stock);
  assert.equal((await req('GET', `/suppliers/${supplier.id}`, null, adminToken)).json.party.balance, 0);

  const confirmed = await req('POST', `/documents/${created.json.document.id}/confirm`, null, adminToken);
  assert.equal(confirmed.json.document.status, 'confirmed');
  assert.ok(confirmed.json.document.confirmed_at);

  assert.equal((await product('SNK-002')).stock, item.stock + 24, 'stock came in');
  assert.equal(
    (await req('GET', `/suppliers/${supplier.id}`, null, adminToken)).json.party.balance,
    confirmed.json.document.total,
    'the supplier is now owed the invoice total',
  );
});

test('a purchase invoice defaults its prices to product cost', async () => {
  const supplier = (await req('POST', '/suppliers', { name: 'Cost Default' }, adminToken)).json.party;
  const item = await product('SNK-001');
  const created = await req(
    'POST',
    '/documents',
    { docType: 'purchase_invoice', partyId: supplier.id, items: [{ productId: item.id, quantity: 2 }] },
    adminToken,
  );
  assert.equal(created.json.items[0].price, item.cost);
});

test('confirming a purchase invoice writes the stock ledger', async () => {
  const moves = (await req('GET', '/inventory/movements?limit=200', null, adminToken)).json.movements;
  assert.ok(moves.some((m) => /^PI-/.test(m.note || '') && m.reason === 'received'));
});

test('a sales invoice deducts stock and bills the customer', async () => {
  const customer = (
    await req('POST', '/customers', { name: 'Invoice Buyer', credit_limit: 1000 }, adminToken)
  ).json.party;
  const item = await product('BEV-004');

  const doc = (
    await req(
      'POST',
      '/documents',
      {
        docType: 'sales_invoice',
        partyId: customer.id,
        items: [{ productId: item.id, quantity: 3 }],
      },
      adminToken,
    )
  ).json.document;

  await req('POST', `/documents/${doc.id}/confirm`, null, adminToken);

  assert.equal((await product('BEV-004')).stock, item.stock - 3, 'stock went out');
  assert.equal(
    (await req('GET', `/customers/${customer.id}`, null, adminToken)).json.party.balance,
    doc.total,
  );
});

test('a sales invoice cannot oversell', async () => {
  const customer = (
    await req('POST', '/customers', { name: 'Greedy', credit_limit: 100000 }, adminToken)
  ).json.party;
  const item = await product('BEV-004');

  const doc = (
    await req(
      'POST',
      '/documents',
      {
        docType: 'sales_invoice',
        partyId: customer.id,
        items: [{ productId: item.id, quantity: item.stock + 50 }],
      },
      adminToken,
    )
  ).json.document;

  const res = await req('POST', `/documents/${doc.id}/confirm`, null, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /not enough stock/i);

  assert.equal((await product('BEV-004')).stock, item.stock, 'nothing moved');
  assert.equal((await req('GET', `/customers/${customer.id}`, null, adminToken)).json.party.balance, 0);
  assert.equal(
    (await req('GET', `/documents/${doc.id}`, null, adminToken)).json.document.status,
    'draft',
    'a failed confirm leaves it a draft',
  );
});

test('a sales invoice respects the credit limit', async () => {
  const customer = (
    await req('POST', '/customers', { name: 'Small Limit', credit_limit: 1 }, adminToken)
  ).json.party;
  const item = await product('APP-002');

  const doc = (
    await req(
      'POST',
      '/documents',
      { docType: 'sales_invoice', partyId: customer.id, items: [{ productId: item.id, quantity: 1 }] },
      adminToken,
    )
  ).json.document;

  const res = await req('POST', `/documents/${doc.id}/confirm`, null, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /credit limit/i);
  assert.equal((await product('APP-002')).stock, item.stock, 'stock is not moved when credit fails');
});

test('an invoice marked not-on-account moves stock but leaves no balance', async () => {
  const customer = (await req('POST', '/customers', { name: 'Paid Now' }, adminToken)).json.party;
  const item = await product('SNK-003');

  const doc = (
    await req(
      'POST',
      '/documents',
      {
        docType: 'sales_invoice',
        partyId: customer.id,
        onAccount: false,
        items: [{ productId: item.id, quantity: 2 }],
      },
      adminToken,
    )
  ).json.document;

  await req('POST', `/documents/${doc.id}/confirm`, null, adminToken);
  assert.equal((await product('SNK-003')).stock, item.stock - 2);
  assert.equal(
    (await req('GET', `/customers/${customer.id}`, null, adminToken)).json.party.balance,
    0,
    'a paid invoice does not go on the account',
  );
});

test('a quotation moves nothing when confirmed', async () => {
  const customer = (await req('POST', '/customers', { name: 'Just Asking' }, adminToken)).json.party;
  const item = await product('BAK-004');

  const doc = (
    await req(
      'POST',
      '/documents',
      { docType: 'quotation', partyId: customer.id, items: [{ productId: item.id, quantity: 5 }] },
      adminToken,
    )
  ).json.document;
  assert.match(doc.doc_number, /^QT-\d{4}$/);

  await req('POST', `/documents/${doc.id}/confirm`, null, adminToken);
  assert.equal((await product('BAK-004')).stock, item.stock, 'a quotation is not a commitment');
  assert.equal((await req('GET', `/customers/${customer.id}`, null, adminToken)).json.party.balance, 0);
});

test('a quotation converts to an order and then an invoice', async () => {
  const customer = (
    await req('POST', '/customers', { name: 'Converts Well', credit_limit: 500 }, adminToken)
  ).json.party;
  const item = await product('BAK-001');

  const quote = (
    await req(
      'POST',
      '/documents',
      { docType: 'quotation', partyId: customer.id, items: [{ productId: item.id, quantity: 2 }] },
      adminToken,
    )
  ).json.document;

  const order = (
    await req('POST', `/documents/${quote.id}/convert`, { docType: 'sales_order' }, adminToken)
  ).json.document;
  assert.match(order.doc_number, /^SO-\d{4}$/);
  assert.equal(order.converted_from_id, quote.id);
  assert.equal(order.total, quote.total, 'the figures carry over');

  const invoice = (
    await req('POST', `/documents/${order.id}/convert`, { docType: 'sales_invoice' }, adminToken)
  ).json.document;
  assert.match(invoice.doc_number, /^SI-\d{4}$/);

  const detail = await req('GET', `/documents/${quote.id}`, null, adminToken);
  assert.equal(detail.json.convertedTo[0].doc_number, order.doc_number);
});

test('refuses an impossible conversion and a repeat conversion', async () => {
  const customer = (await req('POST', '/customers', { name: 'Convert Twice' }, adminToken)).json.party;
  const item = await product('BAK-001');
  const quote = (
    await req(
      'POST',
      '/documents',
      { docType: 'quotation', partyId: customer.id, items: [{ productId: item.id, quantity: 1 }] },
      adminToken,
    )
  ).json.document;

  assert.equal(
    (await req('POST', `/documents/${quote.id}/convert`, { docType: 'purchase_invoice' }, adminToken)).status,
    400,
  );

  await req('POST', `/documents/${quote.id}/convert`, { docType: 'sales_order' }, adminToken);
  const second = await req('POST', `/documents/${quote.id}/convert`, { docType: 'sales_order' }, adminToken);
  assert.equal(second.status, 400);
  assert.match(second.json.error, /already converted/i);
});

test('cancelling a confirmed purchase invoice reverses stock and the payable', async () => {
  const supplier = (await req('POST', '/suppliers', { name: 'Returns Co' }, adminToken)).json.party;
  const item = await product('APP-004');

  const doc = (
    await req(
      'POST',
      '/documents',
      {
        docType: 'purchase_invoice',
        partyId: supplier.id,
        items: [{ productId: item.id, quantity: 10, price: 4 }],
      },
      adminToken,
    )
  ).json.document;

  await req('POST', `/documents/${doc.id}/confirm`, null, adminToken);
  assert.equal((await product('APP-004')).stock, item.stock + 10);

  const cancelled = await req('POST', `/documents/${doc.id}/cancel`, null, adminToken);
  assert.equal(cancelled.json.document.status, 'cancelled');
  assert.equal((await product('APP-004')).stock, item.stock, 'stock is back where it started');
  assert.equal((await req('GET', `/suppliers/${supplier.id}`, null, adminToken)).json.party.balance, 0);
});

test('a confirmed document cannot be edited or deleted', async () => {
  const supplier = (await req('POST', '/suppliers', { name: 'Locked' }, adminToken)).json.party;
  const item = await product('SNK-001');
  const doc = (
    await req(
      'POST',
      '/documents',
      { docType: 'purchase_invoice', partyId: supplier.id, items: [{ productId: item.id, quantity: 1 }] },
      adminToken,
    )
  ).json.document;

  await req('POST', `/documents/${doc.id}/confirm`, null, adminToken);

  assert.equal((await req('PUT', `/documents/${doc.id}`, { discountPercent: 50 }, adminToken)).status, 400);
  assert.equal((await req('DELETE', `/documents/${doc.id}`, null, adminToken)).status, 400);
  assert.equal((await req('POST', `/documents/${doc.id}/confirm`, null, adminToken)).status, 400);
});

test('a draft can be edited and deleted', async () => {
  const supplier = (await req('POST', '/suppliers', { name: 'Editable' }, adminToken)).json.party;
  const item = await product('SNK-001');
  const doc = (
    await req(
      'POST',
      '/documents',
      { docType: 'purchase_invoice', partyId: supplier.id, items: [{ productId: item.id, quantity: 1, price: 10 }] },
      adminToken,
    )
  ).json.document;

  const edited = await req(
    'PUT',
    `/documents/${doc.id}`,
    { items: [{ productId: item.id, quantity: 3, price: 10 }], discountPercent: 10 },
    adminToken,
  );
  assert.equal(edited.json.document.subtotal, 30);
  assert.equal(edited.json.document.discount, 3);
  assert.equal(edited.json.items.length, 1);
  assert.equal(edited.json.items[0].quantity, 3);

  assert.equal((await req('DELETE', `/documents/${doc.id}`, null, adminToken)).status, 200);
  assert.equal((await req('GET', `/documents/${doc.id}`, null, adminToken)).status, 404);
});

test('validates lines and party', async () => {
  const supplier = (await req('POST', '/suppliers', { name: 'Validation' }, adminToken)).json.party;

  assert.equal(
    (await req('POST', '/documents', { docType: 'nonsense', partyId: supplier.id, items: [] }, adminToken))
      .status,
    400,
  );
  assert.equal(
    (await req('POST', '/documents', { docType: 'purchase_invoice', partyId: supplier.id, items: [] }, adminToken))
      .status,
    400,
  );
  assert.equal(
    (
      await req(
        'POST',
        '/documents',
        { docType: 'purchase_invoice', partyId: supplier.id, items: [{ name: 'Thing', quantity: 0, price: 1 }] },
        adminToken,
      )
    ).status,
    400,
  );
  assert.equal(
    (await req('POST', '/documents', { docType: 'sales_invoice', items: [{ name: 'X', quantity: 1, price: 1 }] }, adminToken))
      .status,
    400,
    'an invoice needs a party',
  );
});

test('supports free-text lines with no product', async () => {
  const supplier = (await req('POST', '/suppliers', { name: 'Services Ltd' }, adminToken)).json.party;
  const doc = (
    await req(
      'POST',
      '/documents',
      {
        docType: 'purchase_invoice',
        partyId: supplier.id,
        items: [{ name: 'Delivery charge', quantity: 1, price: 15 }],
      },
      adminToken,
    )
  ).json.document;

  const res = await req('POST', `/documents/${doc.id}/confirm`, null, adminToken);
  assert.equal(res.status, 200, 'a line with no product confirms without touching stock');
  assert.equal(res.json.document.subtotal, 15);
});

test('documents are admin only', async () => {
  assert.equal((await req('GET', '/documents', null, cashierToken)).status, 403);
  assert.equal(
    (await req('POST', '/documents', { docType: 'quotation', items: [] }, cashierToken)).status,
    403,
  );
});

test('documents can be filtered by type and status', async () => {
  const all = (await req('GET', '/documents', null, adminToken)).json.documents;
  const pis = (await req('GET', '/documents?type=purchase_invoice', null, adminToken)).json.documents;
  assert.ok(pis.length > 0);
  assert.ok(pis.every((d) => d.doc_type === 'purchase_invoice'));
  assert.ok(pis.length < all.length);

  const drafts = (await req('GET', '/documents?status=draft', null, adminToken)).json.documents;
  assert.ok(drafts.every((d) => d.status === 'draft'));
});

/* ---------------------------------------------------------------- reports */

test('summary reports revenue, payment mix and reorder-based low stock', async () => {
  const res = await req('GET', '/reports/summary', null, adminToken);
  assert.equal((await req('GET', '/reports/summary', null, cashierToken)).status, 403);
  assert.ok(res.json.revenue > 0);
  assert.ok(res.json.byDay.length >= 1);
  assert.ok(res.json.paymentMix.length >= 1);
  assert.ok(res.json.lowStock.every((p) => p.stock <= p.reorder_point));
});

/* ------------------------------------------------------------------ scope */

test('cashiers only see their own orders', async () => {
  const mine = (await req('GET', '/orders', null, cashierToken)).json.orders;
  assert.ok(mine.length > 0);
  assert.ok(mine.every((o) => o.cashier_name === 'Front Register'));
});

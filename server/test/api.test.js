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

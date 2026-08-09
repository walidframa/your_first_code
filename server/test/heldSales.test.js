/**
 * Sales put to one side.
 *
 * The one thing that makes this dangerous is what it deliberately does not do:
 * a hold reserves nothing. So the tests that matter are the ones that check the
 * shop is told what changed underneath a parked sale, and that two people
 * cannot both pick the same one up.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4603;
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
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready in time');
}

const product = async (sku) =>
  (await req('GET', `/products/lookup?code=${sku}`, null, adminToken)).json.product;

/** A cart line shaped the way the register builds one. */
const line = (item, quantity = 1) => ({
  lineKey: String(item.id),
  productId: item.id,
  unitId: null,
  name: item.name,
  sku: item.sku,
  price: item.price,
  stock: item.stock,
  quantity,
});

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-held-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'held.sqlite'),
    JWT_SECRET: 'held-test-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  cashierToken = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' })).json
    .token;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a sale is held with everything that was on the screen', async () => {
  const item = await product('BEV-001');
  const res = await req(
    'POST',
    '/held-sales',
    {
      label: 'Rami · 03 123 456',
      note: 'gone to the ATM',
      cart: [line(item, 3)],
      context: { discountPercent: 10, buyer: { name: 'Rami', phone: '03123456' }, accounts: [] },
    },
    cashierToken,
  );

  assert.equal(res.status, 201);
  assert.equal(res.json.held.label, 'Rami · 03 123 456');
  assert.equal(res.json.held.itemCount, 3);
  assert.match(res.json.held.reference, /^HOLD-\d{4}$/);
  assert.equal(res.json.count, 1, 'the button on the register counts what is waiting');

  // The discount was agreed with the customer, so it is part of the total the
  // shelf shows — otherwise a held sale reads as dearer than it is.
  assert.equal(res.json.held.total, Math.round(item.price * 3 * 0.9 * 100) / 100);
});

test('an empty cart is not a sale to hold', async () => {
  const res = await req('POST', '/held-sales', { cart: [] }, cashierToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /nothing on this sale/i);
});

test('the total is the shop’s arithmetic, not the browser’s', async () => {
  const item = await product('BEV-001');
  const res = await req(
    'POST',
    '/held-sales',
    { label: 'liar', cart: [{ ...line(item, 2), price: item.price }], context: {}, total: 0.01 },
    cashierToken,
  );
  assert.equal(res.json.held.total, Math.round(item.price * 2 * 100) / 100);
});

test('picking one back up hands the cart back exactly as it was left', async () => {
  const item = await product('BEV-001');
  const held = await req(
    'POST',
    '/held-sales',
    {
      label: 'the blue case',
      cart: [{ ...line(item, 2), price: 4.25 }],
      context: { discountPercent: 5, customer: { id: null, name: 'walk-in' } },
    },
    cashierToken,
  );

  const res = await req('POST', `/held-sales/${held.json.held.id}/resume`, null, cashierToken);
  assert.equal(res.status, 200);
  assert.equal(res.json.held.cart[0].price, 4.25, 'a negotiated price is not re-fetched from the catalogue');
  assert.equal(res.json.held.context.discountPercent, 5);
  assert.equal(res.json.held.context.customer.name, 'walk-in');
  assert.deepEqual(res.json.issues, [], 'nothing moved, so nothing to report');
});

test('two cashiers cannot both put the same sale on their screen', async () => {
  const item = await product('BEV-001');
  const held = await req('POST', '/held-sales', { cart: [line(item)] }, cashierToken);

  const first = await req('POST', `/held-sales/${held.json.held.id}/resume`, null, cashierToken);
  assert.equal(first.status, 200);

  const second = await req('POST', `/held-sales/${held.json.held.id}/resume`, null, adminToken);
  assert.equal(second.status, 400);
  assert.match(second.json.error, /already picked/i);
});

test('a held sale drops off the shelf once it is picked up', async () => {
  const item = await product('BEV-001');
  const before = (await req('GET', '/held-sales', null, cashierToken)).json.count;
  const held = await req('POST', '/held-sales', { cart: [line(item)] }, cashierToken);
  assert.equal(held.json.count, before + 1);

  const resumed = await req('POST', `/held-sales/${held.json.held.id}/resume`, null, cashierToken);
  assert.equal(resumed.json.count, before, 'back to where it was');

  const list = (await req('GET', '/held-sales', null, cashierToken)).json.held;
  assert.equal(list.some((h) => h.id === held.json.held.id), false);
});

test('stock sold meanwhile is reported, not silently corrected', async () => {
  const item = await product('BEV-001');
  const held = await req('POST', '/held-sales', { cart: [line(item, 4)] }, cashierToken);

  // Somebody else buys the shelf down to one while the sale sits there.
  await req(
    'POST',
    '/inventory/adjust',
    { productId: item.id, delta: -(item.stock - 1), reason: 'damaged', note: 'sold elsewhere' },
    adminToken,
  );

  const res = await req('POST', `/held-sales/${held.json.held.id}/resume`, null, cashierToken);
  assert.equal(res.json.issues.length, 1);
  assert.equal(res.json.issues[0].severity, 'short');
  assert.match(res.json.issues[0].message, /only 1 left, 4 on this sale/);
  assert.equal(res.json.held.cart[0].quantity, 4, 'the line comes back as it was; the cashier decides');
});

test('a handset sold meanwhile comes back as gone', async () => {
  const made = await req(
    'POST',
    '/products',
    { name: 'iPhone 15', sku: 'PH-15-HOLD', price: 899, cost: 700, stock: 0, tracks_units: true },
    adminToken,
  );
  const phone = made.json.product;

  await req(
    'POST',
    `/units/product/${phone.id}`,
    { units: [{ imei: '350000000000017', cost: 700 }] },
    adminToken,
  );
  const unitId = (await req('GET', `/units/product/${phone.id}`, null, adminToken)).json.units[0].id;

  const held = await req(
    'POST',
    '/held-sales',
    { cart: [{ ...line(phone, 1), unitId, imei: '350000000000017' }] },
    cashierToken,
  );

  // Somebody else walks in and buys that exact handset.
  await req(
    'POST',
    '/orders',
    { items: [{ productId: phone.id, quantity: 1, unitId }], paymentMethod: 'card' },
    cashierToken,
  );

  const res = await req('POST', `/held-sales/${held.json.held.id}/resume`, null, cashierToken);
  assert.equal(res.json.issues.length, 1);
  assert.equal(res.json.issues[0].severity, 'gone');
  assert.match(res.json.issues[0].message, /350000000000017 has been sold/);
});

test('a held sale can be thrown away, and stays as a record that it was', async () => {
  const item = await product('BEV-001');
  const held = await req('POST', '/held-sales', { cart: [line(item)] }, cashierToken);

  const res = await req('DELETE', `/held-sales/${held.json.held.id}`, null, cashierToken);
  assert.equal(res.status, 200);
  assert.equal(res.json.held.status, 'voided');

  const again = await req('DELETE', `/held-sales/${held.json.held.id}`, null, cashierToken);
  assert.equal(again.status, 400, 'discarding twice is a mistake worth reporting');

  const all = (await req('GET', '/held-sales?status=all', null, cashierToken)).json.held;
  assert.ok(all.some((h) => h.id === held.json.held.id), 'a cart that simply vanished is a question');
});

test('somebody with no register permission cannot park or read sales', async () => {
  const made = await req(
    'POST',
    '/users',
    { username: 'porter', password: 'porter12345', name: 'Porter', role: 'cashier', permissions: [] },
    adminToken,
  );
  assert.equal(made.status, 201);

  const token = (await req('POST', '/auth/login', { username: 'porter', password: 'porter12345' })).json
    .token;

  assert.equal((await req('GET', '/held-sales', null, token)).status, 403);
  assert.equal((await req('POST', '/held-sales', { cart: [] }, token)).status, 403);
});

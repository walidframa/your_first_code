/**
 * Individually identified stock.
 *
 * A phone shop's stock is not a number, it is a drawer of specific handsets.
 * These tests hold the one invariant everything depends on: what the register
 * believes is on the shelf equals the units that are actually there.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/*
 * Its own port. `node --test` runs these files in parallel, so two suites
 * sharing one means the second server cannot bind and the first suite's tests
 * start talking to a stranger — or, worse, still pass locally when the
 * scheduler happens to keep them apart. Taken: 4596 profit, 4598 cash,
 * 4599 api.
 */
const PORT = 4595;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let cashierToken;
let phone;

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

const stockOf = async (id) => (await req('GET', `/products/${id}`, null, adminToken)).json.product.stock;

/*
 * Book in a handset of its own.
 *
 * Tests that need something on the shelf bring their own rather than picking
 * over what earlier tests left, so one of them selling the last phone cannot
 * make the next look broken.
 */
let imeiCounter = 0;
async function freshUnit(cost = 400) {
  const imei = `86000000000${String(++imeiCounter).padStart(4, '0')}`;
  const res = await req('POST', `/units/product/${phone.id}`, { units: [{ imei, cost }] }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return (await req('GET', `/units/lookup?imei=${imei}`, null, adminToken)).json.unit;
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-units-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'units.sqlite'),
    JWT_SECRET: 'units-test-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
    REQUIRE_CASH_SESSION: 'false',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  cashierToken = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' })).json
    .token;

  const created = await req(
    'POST',
    '/products',
    { name: 'iPhone 13', sku: 'PH-13', price: 499, cost: 400, stock: 0, tracks_units: true },
    adminToken,
  );
  assert.equal(created.status, 201, JSON.stringify(created.json));
  phone = created.json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('booking handsets in puts them on the shelf', async () => {
  const res = await req(
    'POST',
    `/units/product/${phone.id}`,
    {
      units: [
        { imei: '35 1234 5678 9012 3', cost: 400 },
        { imei: '351234567890124', cost: 415, condition: 'used' },
      ],
    },
    adminToken,
  );

  assert.equal(res.status, 201);
  assert.equal(res.json.added, 2);
  assert.equal(res.json.stock, 2, 'stock follows the units, it is not typed separately');
  assert.equal(await stockOf(phone.id), 2);

  const list = await req('GET', `/units/product/${phone.id}`, null, adminToken);
  const imeis = list.json.units.map((u) => u.imei);
  assert.ok(imeis.includes('351234567890123'), 'spaces typed off the box are stripped');
});

test('the same IMEI cannot be booked in twice', async () => {
  const res = await req(
    'POST',
    `/units/product/${phone.id}`,
    { units: [{ imei: '351234567890123' }] },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /already in stock or sold/i);
});

test('a batch with one bad IMEI is refused whole', async () => {
  const before = await stockOf(phone.id);
  const res = await req(
    'POST',
    `/units/product/${phone.id}`,
    { units: [{ imei: '999000111222333' }, { imei: '351234567890123' }] },
    adminToken,
  );

  assert.equal(res.status, 400);
  assert.equal(await stockOf(phone.id), before, 'the good one was not kept');
});

test('selling takes the named handset, and its own cost', async () => {
  const list = await req('GET', `/units/product/${phone.id}?status=in_stock`, null, adminToken);
  // The 415 unit, so the line cost cannot have come from the product's 400.
  const unit = list.json.units.find((u) => u.cost === 415);
  const before = await stockOf(phone.id);

  const sale = await req(
    'POST',
    '/orders',
    {
      items: [{ productId: phone.id, quantity: 1, unitId: unit.id }],
      paymentMethod: 'card',
    },
    cashierToken,
  );

  assert.equal(sale.status, 201);
  assert.equal(sale.json.items[0].unit_id, unit.id);
  assert.equal(sale.json.items[0].cost, 415, 'the handset that left, not the shelf average');
  assert.equal(await stockOf(phone.id), before - 1);

  const after = await req('GET', `/units/lookup?imei=${unit.imei}`, null, cashierToken);
  assert.equal(after.json.unit.status, 'sold');
  assert.equal(after.json.available, false);
  assert.equal(after.json.unit.order_number, sale.json.order.order_number, 'traceable to the sale');
});

test('a sold handset cannot be sold again', async () => {
  const sold = (await req('GET', `/units/product/${phone.id}?status=sold`, null, adminToken)).json.units[0];
  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: phone.id, quantity: 1, unitId: sold.id }], paymentMethod: 'card' },
    cashierToken,
  );

  assert.equal(res.status, 400);
  assert.match(res.json.error, /already sold/i);
});

test('a serialised product cannot be sold without naming the handset', async () => {
  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: phone.id, quantity: 1 }], paymentMethod: 'card' },
    cashierToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /tracked by IMEI/i);
});

test('one handset cannot appear twice on the same sale', async () => {
  const unit = await freshUnit();
  const res = await req(
    'POST',
    '/orders',
    {
      items: [
        { productId: phone.id, quantity: 1, unitId: unit.id },
        { productId: phone.id, quantity: 1, unitId: unit.id },
      ],
      paymentMethod: 'card',
    },
    cashierToken,
  );

  assert.equal(res.status, 400);
  assert.match(res.json.error, /twice/i);
  assert.equal(
    (await req('GET', `/units/lookup?imei=${unit.imei}`, null, adminToken)).json.unit.status,
    'in_stock',
    'the failed sale left the handset where it was',
  );
});

test('refunding brings the handset back, marked as returned', async () => {
  const unit = await freshUnit();
  const sale = await req(
    'POST',
    '/orders',
    { items: [{ productId: phone.id, quantity: 1, unitId: unit.id }], paymentMethod: 'card' },
    cashierToken,
  );
  const afterSale = await stockOf(phone.id);

  const refund = await req('POST', `/orders/${sale.json.order.id}/refund`, null, adminToken);
  assert.equal(refund.status, 200);

  const back = await req('GET', `/units/lookup?imei=${unit.imei}`, null, adminToken);
  assert.equal(back.json.unit.status, 'returned');
  assert.equal(back.json.available, true, 'it is in the cabinet and can be sold again');
  assert.equal(await stockOf(phone.id), afterSale + 1, 'counted once, not twice');
});

test('a returned handset can go out again', async () => {
  const unit = (await req('GET', `/units/product/${phone.id}?status=returned`, null, adminToken)).json
    .units[0];
  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: phone.id, quantity: 1, unitId: unit.id }], paymentMethod: 'card' },
    cashierToken,
  );
  assert.equal(res.status, 201);
});

test('a unit of another product is refused', async () => {
  const other = (await req('GET', '/products/lookup?code=SNK-001', null, adminToken)).json.product;
  const unit = await freshUnit();

  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: other.id, quantity: 1, unitId: unit.id }], paymentMethod: 'card' },
    cashierToken,
  );
  assert.equal(res.status, 400);
});

test('scrapping a handset takes it off the shelf', async () => {
  const unit = await freshUnit();
  const before = await stockOf(phone.id);

  const res = await req('PATCH', `/units/${unit.id}`, { status: 'scrapped' }, adminToken);
  assert.equal(res.status, 200);
  assert.equal(await stockOf(phone.id), before - 1);
});

test('a unit cannot be marked sold by editing it', async () => {
  const unit = await freshUnit();
  const res = await req('PATCH', `/units/${unit.id}`, { status: 'sold' }, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /by selling it/i);
});

test('a sold handset cannot be deleted out of its sale', async () => {
  const sold = (await req('GET', `/units/product/${phone.id}?status=sold`, null, adminToken)).json.units[0];
  const res = await req('DELETE', `/units/${sold.id}`, null, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /refund the order/i);
});

test('looking up an unknown IMEI says so plainly', async () => {
  const res = await req('GET', '/units/lookup?imei=000000000000000', null, cashierToken);
  assert.equal(res.status, 404);
  assert.match(res.json.error, /nothing in the shop's records/i);
});

test('quantity-tracked products are untouched by any of this', async () => {
  const snack = (await req('GET', '/products/lookup?code=SNK-001', null, adminToken)).json.product;
  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: snack.id, quantity: 2 }], paymentMethod: 'card' },
    cashierToken,
  );
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.items[0].unit_id, null);
  assert.equal(await stockOf(snack.id), snack.stock - 2);
});

/* ------------------------------------------------- dual-SIM: two IMEIs each */

test('a dual-SIM handset is booked in with both numbers', async () => {
  const res = await req(
    'POST',
    `/units/product/${phone.id}`,
    { units: [{ imei: '35 7777 1111 2222 1, 357777111122229', cost: 430 }] },
    adminToken,
  );
  assert.equal(res.status, 201);

  const unit = (await req('GET', '/units/lookup?imei=357777111122221', null, adminToken)).json.unit;
  assert.equal(unit.imei, '357777111122221');
  assert.equal(unit.imei2, '357777111122229');
});

test('either number finds the same handset', async () => {
  const first = (await req('GET', '/units/lookup?imei=357777111122221', null, cashierToken)).json.unit;
  const second = (await req('GET', '/units/lookup?imei=357777111122229', null, cashierToken)).json.unit;
  assert.equal(first.id, second.id, 'the customer reads whichever number they can see');
});

test('a second IMEI can be given as its own field', async () => {
  const res = await req(
    'POST',
    `/units/product/${phone.id}`,
    { units: [{ imei: '357777111133331', imei2: '357777111133339' }] },
    adminToken,
  );
  assert.equal(res.status, 201);
  assert.equal(
    (await req('GET', '/units/lookup?imei=357777111133339', null, adminToken)).json.unit.imei,
    '357777111133331',
  );
});

test('a number already used as another handset’s second IMEI is refused', async () => {
  const res = await req(
    'POST',
    `/units/product/${phone.id}`,
    { units: [{ imei: '357777111122229' }] },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /already in stock or sold/i);
});

test('the same number cannot fill both slots of one handset', async () => {
  const res = await req(
    'POST',
    `/units/product/${phone.id}`,
    { units: [{ imei: '357777111144441', imei2: '357777111144441' }] },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /twice on the same handset/i);
});

test('a single-SIM handset still books in with one number', async () => {
  const res = await req(
    'POST',
    `/units/product/${phone.id}`,
    { units: [{ imei: '357777111155551' }] },
    adminToken,
  );
  assert.equal(res.status, 201);
  assert.equal(
    (await req('GET', '/units/lookup?imei=357777111155551', null, adminToken)).json.unit.imei2,
    null,
  );
});

test('a dual-SIM handset sells and stays findable by both numbers', async () => {
  const unit = (await req('GET', '/units/lookup?imei=357777111133331', null, adminToken)).json.unit;
  const sale = await req(
    'POST',
    '/orders',
    { items: [{ productId: phone.id, quantity: 1, unitId: unit.id }], paymentMethod: 'card' },
    cashierToken,
  );
  assert.equal(sale.status, 201);

  for (const number of ['357777111133331', '357777111133339']) {
    const found = (await req('GET', `/units/lookup?imei=${number}`, null, cashierToken)).json;
    assert.equal(found.unit.status, 'sold');
    assert.equal(found.unit.order_number, sale.json.order.order_number);
  }
});

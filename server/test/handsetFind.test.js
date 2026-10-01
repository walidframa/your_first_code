/**
 * Where is this handset?
 *
 * One number, one answer: the unit, its shelf, the sale it left on and who
 * took it, the delivery it came in on, the repairs it has been through. The
 * question used to need five screens.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4702;
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
    /* Some responses carry no body. */
  }
  return { status: res.status, json };
}

let phone;
let customer;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-handset-find-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'handset-find-secret-long-enough-for-the-production-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
    REQUIRE_CASH_SESSION: 'false',
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
  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  await req('PUT', '/settings', { tax_enabled: 'false' });
  customer = (await req('POST', '/customers', { name: 'Rami Haddad', phone: '03 111 222', credit_limit: 5000 })).json.party;
  phone = (
    await req('POST', '/products', { name: 'Galaxy A55', sku: 'HF-A55', price: 300, cost: 200, tracks_units: true })
  ).json.product;
  const booked = await req('POST', `/units/product/${phone.id}`, {
    units: [
      { imei: '356938035643809', cost: 200 },
      { imei: '490154203237518', cost: 205 },
    ],
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.json));
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a handset on the shelf is found, with the number typed any way at all', async () => {
  const found = await req('GET', '/units/find?imei=' + encodeURIComponent('3569 3803 5643-809'));
  assert.equal(found.status, 200, JSON.stringify(found.json));
  assert.equal(found.json.unit.imei, '356938035643809');
  assert.equal(found.json.unit.product_name, 'Galaxy A55');
  assert.equal(found.json.unit.status, 'in_stock');
  assert.equal(found.json.available, true);
  assert.equal(found.json.here, true, 'on this counter’s shelf');
  assert.equal(found.json.sale, null);
  assert.deepEqual(found.json.repairs, []);
});

test('once sold, it says on which sale, when, and to whom', async () => {
  const units = (await req('GET', `/units/product/${phone.id}?status=in_stock`)).json.units;
  const unit = units.find((u) => u.imei === '490154203237518');
  const sale = await req('POST', '/orders', {
    items: [{ productId: phone.id, quantity: 1, unitId: unit.id }],
    paymentMethod: 'card',
    customerId: customer.id,
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const found = await req('GET', '/units/find?imei=490154203237518');
  assert.equal(found.status, 200);
  assert.equal(found.json.unit.status, 'sold');
  assert.equal(found.json.available, false);
  assert.equal(found.json.sale.kind, 'order');
  assert.equal(found.json.sale.number, sale.json.order.order_number);
  assert.equal(found.json.sale.customer_name, 'Rami Haddad');
});

test('its repairs come with it, and a phone that was only ever repaired is still an answer', async () => {
  const ticket = await req('POST', '/repairs', {
    customerName: 'Rami Haddad',
    customerPhone: '03 111 222',
    device: 'Galaxy A55',
    fault: 'Battery',
    imei: '490154203237518',
    quoted: 40,
  });
  assert.equal(ticket.status, 201, JSON.stringify(ticket.json));

  const ours = await req('GET', '/units/find?imei=490154203237518');
  assert.equal(ours.json.repairs.length, 1);
  assert.equal(ours.json.repairs[0].ticket_number, ticket.json.ticket.ticket_number);

  const walkIn = await req('POST', '/repairs', {
    customerName: 'Somebody Else',
    device: 'iPhone 11',
    fault: 'Screen',
    imei: '013456789012345',
  });
  assert.equal(walkIn.status, 201);
  const theirs = await req('GET', '/units/find?imei=013456789012345');
  assert.equal(theirs.status, 200);
  assert.equal(theirs.json.unit, null, 'never on our shelf');
  assert.equal(theirs.json.repairs.length, 1);
});

test('a number the shop has never seen says so', async () => {
  const none = await req('GET', '/units/find?imei=999999999999999');
  assert.equal(none.status, 404);
  assert.match(none.json.error, /999999999999999/);
  assert.equal((await req('GET', '/units/find')).status, 404);
});

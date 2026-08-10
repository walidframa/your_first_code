/**
 * Warranty, repair jobs and handsets bought back.
 *
 * The thread through all three: a phone the shop is responsible for, and money
 * that has to end up in the right place.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Taken: 4595 units, 4596 profit, 4598 cash, 4599 api.
const PORT = 4594;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let cashierToken;
let phone;
let part;

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

let n = 0;
async function sellOne(warrantyMonths) {
  const imei = `35990000000${String(++n).padStart(4, '0')}`;
  await req('POST', `/units/product/${phone.id}`, { units: [{ imei, cost: 300 }] }, adminToken);
  const unit = (await req('GET', `/units/lookup?imei=${imei}`, null, adminToken)).json.unit;
  if (warrantyMonths !== undefined) {
    await req('PUT', `/products/${phone.id}`, { warranty_months: warrantyMonths }, adminToken);
  }
  const sale = await req(
    'POST',
    '/orders',
    {
      items: [{ productId: phone.id, quantity: 1, unitId: unit.id }],
      paymentMethod: 'card',
      buyerName: 'Nadia Khoury',
      buyerPhone: '03 111 222',
    },
    cashierToken,
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  return imei;
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-repairs-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'repairs.sqlite'),
    JWT_SECRET: 'repairs-test-secret-long-enough-for-guard',
    ACCOUNT_SECRET: 'repairs-account-secret-long-enough-32',
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

  phone = (
    await req(
      'POST',
      '/products',
      { name: 'Galaxy S22', sku: 'PH-S22', price: 550, cost: 300, tracks_units: true, warranty_months: 6 },
      adminToken,
    )
  ).json.product;

  part = (
    await req(
      'POST',
      '/products',
      { name: 'S22 Screen', sku: 'PART-S22-SCR', price: 90, cost: 55, stock: 4 },
      adminToken,
    )
  ).json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------- warranty */

test('selling a phone starts its warranty, from the shop’s policy', async () => {
  const imei = await sellOne();
  const res = await req('GET', `/repairs/warranty/${imei}`, null, cashierToken);

  assert.equal(res.status, 200);
  assert.equal(res.json.warranty.months, 6);
  assert.equal(res.json.warranty.active, true);
  assert.ok(res.json.warranty.ends > res.json.warranty.starts, 'it ends after it starts');
});

test('changing the policy does not shorten a warranty already given', async () => {
  const imei = await sellOne();
  await req('PUT', `/products/${phone.id}`, { warranty_months: 1 }, adminToken);

  const res = await req('GET', `/repairs/warranty/${imei}`, null, cashierToken);
  assert.equal(res.json.warranty.months, 6, 'the figure was copied onto the handset when it sold');

  await req('PUT', `/products/${phone.id}`, { warranty_months: 6 }, adminToken);
});

test('a phone sold with no warranty has none, which is not the same as expired', async () => {
  await req('PUT', `/products/${phone.id}`, { warranty_months: 0 }, adminToken);
  const imei = await sellOne();
  const res = await req('GET', `/repairs/warranty/${imei}`, null, cashierToken);

  assert.equal(res.json.warranty.months, 0);
  assert.equal(res.json.warranty.ends, null);
  assert.equal(res.json.warranty.active, false);

  await req('PUT', `/products/${phone.id}`, { warranty_months: 6 }, adminToken);
});

/* --------------------------------------------------------------- repairs */

test('taking a phone in links it to the handset the shop sold', async () => {
  const imei = await sellOne();
  const res = await req(
    'POST',
    '/repairs',
    {
      imei,
      customerName: 'Nadia Khoury',
      customerPhone: '03 111 222',
      fault: 'Screen cracked',
      conditionNote: 'Back glass fine, small scuff on frame',
      passcode: '4471',
    },
    cashierToken,
  );

  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.match(res.json.ticket.ticket_number, /^REP-\d{5}$/);
  assert.ok(res.json.ticket.unit_id, 'it is one of ours');
  assert.equal(res.json.ticket.under_warranty, 1, 'and still covered');
  assert.equal(res.json.ticket.device, 'Galaxy S22', 'the device names itself from the record');
  assert.equal(res.json.events.length, 1, 'intake is on the history');
});

test('a phone the shop never sold is still taken in, by description', async () => {
  const res = await req(
    'POST',
    '/repairs',
    { customerName: 'Walk-in', device: 'Huawei P30', fault: 'Will not charge' },
    cashierToken,
  );

  assert.equal(res.status, 201);
  assert.equal(res.json.ticket.unit_id, null);
  assert.equal(res.json.ticket.under_warranty, 0);
});

test('a ticket needs a name, a device and a fault', async () => {
  for (const body of [
    { device: 'X', fault: 'Y' },
    { customerName: 'A', fault: 'Y' },
    { customerName: 'A', device: 'X' },
  ]) {
    const res = await req('POST', '/repairs', body, cashierToken);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('a ticket taken in at the counter keeps everything the slip needs', async () => {
  // Exactly the fields the register's form collects, and nothing else.
  const res = await req(
    'POST',
    '/repairs',
    {
      customerName: 'Rami Haddad',
      customerPhone: '03 123 456',
      device: 'iPhone 12 Pro, black',
      fault: 'Screen cracked, touch dead at the top',
      passcode: '4417',
      quoted: 85,
    },
    cashierToken,
  );

  assert.equal(res.status, 201);
  const { ticket } = res.json;
  assert.match(ticket.ticket_number, /^REP-\d+/, 'the number is what the customer comes back with');
  assert.equal(ticket.customer_name, 'Rami Haddad');
  assert.equal(ticket.customer_phone, '03 123 456');
  assert.equal(ticket.device, 'iPhone 12 Pro, black');
  assert.equal(ticket.quoted, 85);
  assert.equal(ticket.status, 'received');

  // The passcode is a credential: stored, but never handed back with the ticket
  // that gets printed and put in a customer's pocket.
  assert.equal(ticket.passcode, undefined);
  assert.ok(ticket.branch_id, 'and it belongs to the shop that has the phone');
});

test('the passcode is kept back from the list and shown only to an admin', async () => {
  const ticket = (await req('GET', '/repairs?status=open', null, cashierToken)).json.tickets.find(
    (t) => t.fault === 'Screen cracked',
  );
  assert.equal(ticket.passcode, undefined);

  const asCashier = await req('GET', `/repairs/${ticket.id}/passcode`, null, cashierToken);
  assert.equal(asCashier.status, 403);

  const asAdmin = await req('GET', `/repairs/${ticket.id}/passcode`, null, adminToken);
  assert.equal(asAdmin.json.passcode, '4471');
});

test('fitting a part takes it out of stock there and then', async () => {
  const ticket = (await req('GET', '/repairs?status=open', null, adminToken)).json.tickets.find(
    (t) => t.fault === 'Screen cracked',
  );
  const before = (await req('GET', `/products/${part.id}`, null, adminToken)).json.product.stock;

  const res = await req('POST', `/repairs/${ticket.id}/parts`, { productId: part.id }, adminToken);
  assert.equal(res.status, 201);
  assert.equal(res.json.partsTotal, 90);

  const after = (await req('GET', `/products/${part.id}`, null, adminToken)).json.product.stock;
  assert.equal(after, before - 1, 'the screen left the drawer when it was fitted');
});

test('taking a part back off the job returns it to stock', async () => {
  const ticket = (await req('GET', '/repairs?status=open', null, adminToken)).json.tickets.find(
    (t) => t.fault === 'Screen cracked',
  );
  const detail = (await req('GET', `/repairs/${ticket.id}`, null, adminToken)).json;
  const before = (await req('GET', `/products/${part.id}`, null, adminToken)).json.product.stock;

  const res = await req('DELETE', `/repairs/parts/${detail.parts[0].id}`, null, adminToken);
  assert.equal(res.status, 200);

  const after = (await req('GET', `/products/${part.id}`, null, adminToken)).json.product.stock;
  assert.equal(after, before + 1);
});

test('a whole handset is not a spare part', async () => {
  const ticket = (await req('GET', '/repairs?status=open', null, adminToken)).json.tickets[0];
  const res = await req('POST', `/repairs/${ticket.id}/parts`, { productId: phone.id }, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /not a spare part/i);
});

test('the job moves through statuses, and each move is on the record', async () => {
  const ticket = (await req('GET', '/repairs?status=open', null, adminToken)).json.tickets.find(
    (t) => t.fault === 'Screen cracked',
  );

  for (const status of ['diagnosed', 'awaiting_parts', 'repairing', 'ready']) {
    const res = await req('PATCH', `/repairs/${ticket.id}`, { status, note: `now ${status}` }, adminToken);
    assert.equal(res.status, 200, `${status}: ${JSON.stringify(res.json)}`);
  }

  const detail = (await req('GET', `/repairs/${ticket.id}`, null, adminToken)).json;
  assert.equal(detail.ticket.status, 'ready');
  assert.equal(detail.events.length, 5, 'intake plus four moves');
});

test('a repair is collected from the register, not by editing its status', async () => {
  const ticket = (await req('GET', '/repairs?status=ready', null, adminToken)).json.tickets[0];
  const res = await req('PATCH', `/repairs/${ticket.id}`, { status: 'collected' }, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /from the register/i);
});

test('a warranty job is collected at nothing to pay', async () => {
  const ticket = (await req('GET', '/repairs?status=ready', null, adminToken)).json.tickets[0];
  assert.equal(ticket.under_warranty, 1);

  const charged = await req('POST', `/repairs/${ticket.id}/collect`, { charged: 40 }, adminToken);
  assert.equal(charged.status, 400);
  assert.match(charged.json.error, /under warranty/i);

  const free = await req('POST', `/repairs/${ticket.id}/collect`, { charged: 0 }, adminToken);
  assert.equal(free.status, 200);
  assert.equal(free.json.ticket.status, 'collected');
  assert.equal(free.json.ticket.charged, 0);
});

test('a collected ticket cannot be reopened', async () => {
  const collected = (await req('GET', '/repairs?status=collected', null, adminToken)).json.tickets[0];
  const res = await req('PATCH', `/repairs/${collected.id}`, { status: 'repairing' }, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /already collected/i);
});

test('a paid repair puts the money in the drawer', async () => {
  const opened = await req('POST', '/cash/open', { openingUsd: 50 }, adminToken);
  assert.ok([201, 400].includes(opened.status));

  const t = (
    await req(
      'POST',
      '/repairs',
      { customerName: 'Paid Job', device: 'Redmi 9', fault: 'Battery' },
      cashierToken,
    )
  ).json.ticket;
  await req('PATCH', `/repairs/${t.id}`, { status: 'ready' }, adminToken);

  const before = (await req('GET', '/cash/current', null, adminToken)).json.expected;
  const res = await req(
    'POST',
    `/repairs/${t.id}/collect`,
    { charged: 35, payments: [{ currency: 'USD', amount: 35 }] },
    adminToken,
  );

  assert.equal(res.status, 200);
  const after = (await req('GET', '/cash/current', null, adminToken)).json.expected;
  assert.equal(after.usd, before.usd + 35, 'the repair was paid into the till');
});

/* ------------------------------------------------------------- trade-ins */

test('buying a phone puts it on the shelf and takes cash out of the drawer', async () => {
  const before = (await req('GET', '/cash/current', null, adminToken)).json.expected;

  const res = await req(
    'POST',
    '/repairs/trade-ins',
    {
      productId: phone.id,
      imei: '35 8800 1111 2222 1',
      condition: 'used',
      paidUsd: 120,
      sellerName: 'Karim',
      sellerPhone: '70 999 888',
    },
    adminToken,
  );

  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.cost, 120, 'the handset cost what was paid for it');
  assert.equal(res.json.unit.condition, 'used');

  const after = (await req('GET', '/cash/current', null, adminToken)).json.expected;
  assert.equal(after.usd, before.usd - 120, 'the money left the till');

  const found = await req('GET', '/units/lookup?imei=358800111122221', null, adminToken);
  assert.equal(found.json.available, true, 'and it can be sold on');
});

test('a traded-in phone sells like any other, at its own cost', async () => {
  const unit = (await req('GET', '/units/lookup?imei=358800111122221', null, adminToken)).json.unit;
  const sale = await req(
    'POST',
    '/orders',
    { items: [{ productId: phone.id, quantity: 1, unitId: unit.id }], paymentMethod: 'card' },
    cashierToken,
  );

  assert.equal(sale.status, 201);
  assert.equal(sale.json.items[0].cost, 120, 'margin is against what the shop actually paid');
});

test('a trade-in of an IMEI already known is refused', async () => {
  const res = await req(
    'POST',
    '/repairs/trade-ins',
    { productId: phone.id, imei: '358800111122221', paidUsd: 50 },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /already in stock or sold/i);
});

test('a trade-in against a quantity product is refused', async () => {
  const res = await req(
    'POST',
    '/repairs/trade-ins',
    { productId: part.id, imei: '358800111133331', paidUsd: 10 },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /not tracked by IMEI/i);
});

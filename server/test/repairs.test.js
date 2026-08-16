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

test('handing the phone back is its own action, not a status to type', async () => {
  const ticket = (await req('GET', '/repairs?status=ready', null, adminToken)).json.tickets[0];
  const res = await req('PATCH', `/repairs/${ticket.id}`, { status: 'collected' }, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /hand it back/i);
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

/*
 * The phone that comes straight back through the door.
 *
 * Collected used to be the end of the line, which made sense while collecting
 * and paying were the same act. They are not, and a job that cannot be moved
 * once the money is in is a job the shop has to re-take-in under a new number.
 */
test('a collected ticket goes back on the bench, and the date it left is cleared', async () => {
  const collected = (await req('GET', '/repairs?status=collected', null, adminToken)).json.tickets[0];
  assert.ok(collected.collected_at, 'it left the shop at some point');

  const res = await req('PATCH', `/repairs/${collected.id}`, { status: 'repairing' }, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.ticket.status, 'repairing');
  assert.equal(res.json.ticket.collected_at, null, 'it is not collected any more');

  const back = res.json.events.at(-1);
  assert.match(back.note, /back on the bench/i);
});

/*
 * The case the shop actually asked for: paid at the counter on the way in, and
 * worked on for the rest of the week.
 */
test('money can be taken while the phone is still on the bench', async () => {
  const opened = await req('POST', '/cash/open', { openingUsd: 50 }, adminToken);
  assert.ok([201, 400].includes(opened.status));

  const ticket = (
    await req(
      'POST',
      '/repairs',
      { customerName: 'Pays Up Front', device: 'Nokia G21', fault: 'Charging port', quoted: 30 },
      adminToken,
    )
  ).json.ticket;

  const before = (await req('GET', '/cash/current', null, adminToken)).json.expected;

  const paid = await req(
    'POST',
    `/repairs/${ticket.id}/payment`,
    { charged: 30, payments: [{ currency: 'USD', amount: 30 }] },
    adminToken,
  );
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  assert.equal(paid.json.ticket.paid_usd, 30);
  assert.equal(paid.json.outstanding, 0, 'nothing left to pay');
  // The money is in, and the phone has not moved an inch.
  assert.equal(paid.json.ticket.status, 'received');
  assert.equal(paid.json.ticket.collected_at, null);

  const after = (await req('GET', '/cash/current', null, adminToken)).json.expected;
  assert.equal(Math.round((after.usd - before.usd) * 100) / 100, 30);

  // And the job carries on being a job.
  for (const status of ['awaiting_parts', 'repairing', 'ready']) {
    const moved = await req('PATCH', `/repairs/${ticket.id}`, { status }, adminToken);
    assert.equal(moved.status, 200, `${status}: ${JSON.stringify(moved.json)}`);
    assert.equal(moved.json.ticket.paid_usd, 30, 'the money stays paid');
  }

  // Handed back with nothing owing — and the drawer must not take the 30 twice.
  const drawerBefore = (await req('GET', '/cash/current', null, adminToken)).json.expected;
  const handed = await req('POST', `/repairs/${ticket.id}/collect`, { charged: 30 }, adminToken);
  assert.equal(handed.status, 200, JSON.stringify(handed.json));
  assert.equal(handed.json.ticket.status, 'collected');
  assert.equal(handed.json.ticket.paid_usd, 30);

  const drawerAfter = (await req('GET', '/cash/current', null, adminToken)).json.expected;
  assert.equal(drawerAfter.usd, drawerBefore.usd, 'paid once, not twice');
});

test('a repair can be put on a customer from the list', async () => {
  const created = await req(
    'POST',
    '/customers',
    { name: 'Repair Regular', phone: '03 999 111' },
    adminToken,
  );
  assert.equal(created.status, 201);
  const customer = created.json.party;

  // Only the id: the name and the phone come off the account, which is the
  // point of picking one rather than typing it again.
  const res = await req(
    'POST',
    '/repairs',
    { customerId: customer.id, device: 'iPhone 13', fault: 'Back glass' },
    adminToken,
  );
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.ticket.customer_id, customer.id);
  assert.equal(res.json.ticket.customer_name, 'Repair Regular');
  assert.equal(res.json.ticket.customer_phone, '03 999 111');

  const unknown = await req(
    'POST',
    '/repairs',
    { customerId: 999_999, device: 'iPhone 13', fault: 'Back glass' },
    adminToken,
  );
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /does not exist/i);
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

/* ---------------------------------------------------------- the seller's ID */

/*
 * A real 2×2 PNG. Small enough to keep the test honest about the plumbing
 * rather than about image encoding, and genuinely decodable so nothing here
 * passes on a string that only looks like a picture.
 */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';

let idTradeIn;

test('a phone bought in can have the seller’s ID photographed with it', async () => {
  const res = await req(
    'POST',
    '/repairs/trade-ins',
    {
      productId: phone.id,
      imei: '358800111144441',
      paidUsd: 60,
      sellerName: 'Nadim',
      idPhoto: TINY_PNG,
    },
    adminToken,
  );

  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.hasIdPhoto, true);
  idTradeIn = res.json.tradeInId;
  assert.ok(idTradeIn, 'and the purchase says which row to find it under');
});

test('the list says which purchases are documented, without sending the photos', async () => {
  const res = await req('GET', '/repairs/trade-ins/list', null, adminToken);
  assert.equal(res.status, 200);

  const documented = res.json.tradeIns.find((t) => t.id === idTradeIn);
  assert.equal(documented.has_id_photo, 1);
  assert.ok(
    res.json.tradeIns.some((t) => !t.has_id_photo),
    'and the ones without an ID are visible as such — that is the row worth finding',
  );

  /*
   * The point of keeping the bytes in a table of their own. A shop with two
   * hundred purchases should not download two hundred photographs to draw a
   * list of names and prices.
   */
  const serialised = JSON.stringify(res.json);
  assert.ok(!serialised.includes('iVBOR'), 'no image data anywhere in the list');
  assert.ok(serialised.length < 60_000, 'and the list stays small');
});

test('the ID comes back as an image to whoever may reveal saved passwords', async () => {
  const res = await fetch(`${BASE}/repairs/trade-ins/${idTradeIn}/id-photo`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  // Never in a shared cache: it is somebody's identity document.
  assert.match(res.headers.get('cache-control'), /no-store/);

  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(
    bytes,
    Buffer.from(TINY_PNG.split(',')[1], 'base64'),
    'byte for byte what was photographed',
  );
});

test('a cashier can take an ID but cannot open one', async () => {
  // Taking one is counter work, and the cashier is who is at the counter.
  const taken = await req(
    'POST',
    '/repairs/trade-ins',
    { productId: phone.id, imei: '358800111155551', paidUsd: 10, idPhoto: TINY_PNG },
    cashierToken,
  );
  assert.equal(taken.status, 201, JSON.stringify(taken.json));

  // Reading one back is not. Nobody needs to page through a year of other
  // people's identity documents because they once had the till open.
  const peek = await req('GET', `/repairs/trade-ins/${taken.json.tradeInId}/id-photo`, null, cashierToken);
  assert.equal(peek.status, 403);

  // And destroying the record that a purchase was documented is not either.
  const wipe = await req(
    'DELETE',
    `/repairs/trade-ins/${taken.json.tradeInId}/id-photo`,
    null,
    cashierToken,
  );
  assert.equal(wipe.status, 403);
});

test('an ID can be attached after the fact, because the queue does not wait', async () => {
  const taken = await req(
    'POST',
    '/repairs/trade-ins',
    { productId: phone.id, imei: '358800111166661', paidUsd: 15 },
    adminToken,
  );
  assert.equal(taken.json.hasIdPhoto, false);

  const attached = await req(
    'POST',
    `/repairs/trade-ins/${taken.json.tradeInId}/id-photo`,
    { idPhoto: TINY_PNG },
    adminToken,
  );
  assert.equal(attached.status, 201);

  const list = (await req('GET', '/repairs/trade-ins/list', null, adminToken)).json.tradeIns;
  assert.equal(list.find((t) => t.id === taken.json.tradeInId).has_id_photo, 1);
});

test('a second photo replaces the first rather than piling up', async () => {
  const other =
    'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

  await req('POST', `/repairs/trade-ins/${idTradeIn}/id-photo`, { idPhoto: other }, adminToken);

  const res = await fetch(`${BASE}/repairs/trade-ins/${idTradeIn}/id-photo`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.headers.get('content-type'), 'image/jpeg', 'the newer one is what is on file');
});

test('anything that is not a photograph is refused', async () => {
  for (const junk of [
    'not a data url',
    'data:application/pdf;base64,JVBERi0xLjQK',
    'data:text/html;base64,PGgxPmhpPC9oMT4=',
  ]) {
    const res = await req(
      'POST',
      `/repairs/trade-ins/${idTradeIn}/id-photo`,
      { idPhoto: junk },
      adminToken,
    );
    assert.equal(res.status, 400, `${junk} should be refused`);
  }
});

test('a photo too big to be worth keeping is refused, with the size in the message', async () => {
  // Just over the 2MB cap. Base64 is 4 bytes per 3, hence the ratio.
  const huge = `data:image/jpeg;base64,${'A'.repeat(Math.ceil((2 * 1024 * 1024 + 1024) / 3) * 4)}`;
  const res = await req(
    'POST',
    `/repairs/trade-ins/${idTradeIn}/id-photo`,
    { idPhoto: huge },
    adminToken,
  );

  assert.equal(res.status, 400);
  assert.match(res.json.error, /under 2MB/i);
});

test('a rejected photo takes the whole purchase with it', async () => {
  const before = (await req('GET', '/cash/current', null, adminToken)).json.expected.usd;

  const res = await req(
    'POST',
    '/repairs/trade-ins',
    { productId: phone.id, imei: '358800111177771', paidUsd: 40, idPhoto: 'data:text/plain;base64,aGk=' },
    adminToken,
  );
  assert.equal(res.status, 400);

  /*
   * The situation this avoids: a shop holding a handset it has no record of
   * buying, which is exactly what the ID exists to prevent.
   */
  const found = await req('GET', '/units/lookup?imei=358800111177771', null, adminToken);
  assert.notEqual(found.status, 200, 'the handset never joined the shelf');
  assert.equal(
    (await req('GET', '/cash/current', null, adminToken)).json.expected.usd,
    before,
    'and the money never left the till',
  );
});

test('the ID can be deleted, and the purchase stays', async () => {
  const gone = await req('DELETE', `/repairs/trade-ins/${idTradeIn}/id-photo`, null, adminToken);
  assert.equal(gone.status, 200);

  const again = await req('GET', `/repairs/trade-ins/${idTradeIn}/id-photo`, null, adminToken);
  assert.equal(again.status, 404);

  const list = (await req('GET', '/repairs/trade-ins/list', null, adminToken)).json.tradeIns;
  assert.ok(list.find((t) => t.id === idTradeIn), 'the purchase itself is untouched');
});

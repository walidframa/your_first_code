/**
 * Serialised stock on paper: sold by invoice, back by return, and the number
 * on it called what it is.
 *
 * A product tracked one at a time was sold only at the register, and every
 * screen called its number an IMEI. Here a laptop with a serial is booked in,
 * sold on a sales invoice by naming which one, taken back on a return raised
 * against that invoice, and the invoice and the return are each cancelled —
 * with the unit ending up exactly where each step says it is.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4703;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;

async function req(method, route, body) {
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
    /* Some responses carry no body. */
  }
  return { status: res.status, json };
}

const stockOf = async (id) => (await req('GET', `/products/${id}`)).json.product.stock;
const unitOf = async (number) => (await req('GET', `/units/lookup?imei=${encodeURIComponent(number)}`)).json;

async function draft(docType, partyId, items, extra = {}) {
  const res = await req('POST', '/documents', { docType, partyId, items, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.document;
}
const confirm = (id, body = null) => req('POST', `/documents/${id}/confirm`, body);

let customer;
let laptop;
let phone;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-unit-sales-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'unit-sales-secret-long-enough-for-the-production-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
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
  customer = (await req('POST', '/customers', { name: 'Trade Buyer', credit_limit: 10000 })).json.party;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ the number */

test('a product says whether its units carry an IMEI or a serial number', async () => {
  const made = await req('POST', '/products', {
    name: 'Workbook 14',
    sku: 'LAP-14',
    price: 900,
    cost: 700,
    tracks_units: true,
    unit_kind: 'serial',
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  laptop = made.json.product;
  assert.equal(laptop.unit_kind, 'serial');
  assert.equal(laptop.tracks_units, 1);

  // The default is a phone, which is what the shelf was built for.
  const handset = await req('POST', '/products', {
    name: 'Galaxy A55',
    sku: 'PH-A55',
    price: 400,
    cost: 300,
    tracks_units: true,
  });
  phone = handset.json.product;
  assert.equal(phone.unit_kind, 'imei');

  const nonsense = await req('PUT', `/products/${laptop.id}`, { unit_kind: 'barcode' });
  assert.equal(nonsense.status, 400);
  assert.match(nonsense.json.error, /imei, serial/);

  const flipped = await req('PUT', `/products/${laptop.id}`, { unit_kind: 'imei' });
  assert.equal(flipped.json.product.unit_kind, 'imei');
  await req('PUT', `/products/${laptop.id}`, { unit_kind: 'serial' });
  assert.equal((await req('GET', `/products/${laptop.id}`)).json.product.unit_kind, 'serial');
});

test('serial numbers with letters book in and are found again, case and spacing aside', async () => {
  const res = await req('POST', `/units/product/${laptop.id}`, {
    units: [{ imei: 'wb14-a0001', cost: 690 }, { imei: 'WB14 A0002', cost: 710 }, 'WB14A0003'],
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.added, 3);
  assert.equal(await stockOf(laptop.id), 3);

  const found = await unitOf('wb14 a0002');
  assert.equal(found.unit.imei, 'WB14A0002');
  assert.equal(found.unit.unit_kind, 'serial', 'the lookup says what kind of number it is');
  assert.equal(found.unit.cost, 710);
});

/* ------------------------------------------------------------- selling */

let invoice;

test('a sales invoice sells a serialised product by naming which units', async () => {
  // Two on the line and nobody named: refused by count, in the product's own words.
  const vague = await draft('sales_invoice', customer.id, [{ productId: laptop.id, quantity: 2, price: 900 }]);
  const refused = await confirm(vague.id);
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /2 on the line but 0 serial numbers given/);
  assert.equal(await stockOf(laptop.id), 3, 'nothing moved');

  invoice = await draft('sales_invoice', customer.id, [
    { productId: laptop.id, quantity: 2, price: 900, imeis: 'WB14A0001\nWB14A0002' },
  ]);
  const done = await confirm(invoice.id);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(await stockOf(laptop.id), 1, 'two left the shelf');

  const sold = await unitOf('WB14A0001');
  assert.equal(sold.unit.status, 'sold');
  assert.equal(sold.available, false);
  const still = await unitOf('WB14A0003');
  assert.equal(still.available, true, 'the one not named is still for sale');

  // The line cost is what those two units cost, not the catalogue's figure.
  const saved = (await req('GET', `/documents/${invoice.id}`)).json;
  const docNumber = saved.document.doc_number;
  assert.equal(saved.items[0].cost, 700, '(690 + 710) / 2');

  // The finder knows which paper it left on.
  const where = (await req('GET', '/units/find?imei=WB14A0002')).json;
  assert.equal(where.sale?.kind, 'document');
  assert.equal(where.sale?.number, docNumber);
});

test('a unit already sold, or of another product, is refused by name', async () => {
  const twice = await draft('sales_invoice', customer.id, [
    { productId: laptop.id, quantity: 1, price: 900, imeis: 'WB14A0001' },
  ]);
  const res = await confirm(twice.id);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /WB14A0001 is already sold/);

  await req('POST', `/units/product/${phone.id}`, { units: ['358800111100001'] });
  const wrong = await draft('sales_invoice', customer.id, [
    { productId: laptop.id, quantity: 1, price: 900, imeis: '358800111100001' },
  ]);
  const mixed = await confirm(wrong.id);
  assert.equal(mixed.status, 400);
  assert.match(mixed.json.error, /is not a Workbook 14/);
});

test('a phone sells on an invoice the same way, and the warranty starts that day', async () => {
  await req('PUT', `/products/${phone.id}`, { warranty_months: 6 });
  const doc = await draft('sales_invoice', customer.id, [
    { productId: phone.id, quantity: 1, price: 400, imeis: '358800111100001' },
  ]);
  const done = await confirm(doc.id);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  const unit = (await unitOf('358800111100001')).unit;
  assert.equal(unit.status, 'sold');
  assert.equal(unit.warranty_months, 6);
  assert.ok(unit.warranty_starts, 'the shop’s promise is dated');

  const cancelled = await req('POST', `/documents/${doc.id}/cancel`);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.equal((await unitOf('358800111100001')).unit.status, 'in_stock');
});

/* ---------------------------------------------------------- coming back */

let ret;

test('a return raised against the invoice starts from its units and takes back the ones named', async () => {
  const converted = await req('POST', `/documents/${invoice.id}/convert`, { docType: 'sales_return' });
  assert.equal(converted.status, 201, JSON.stringify(converted.json));
  ret = converted.json.document;
  const drafted = (await req('GET', `/documents/${ret.id}`)).json;
  assert.match(drafted.items[0].imeis || '', /WB14A0001/, 'the draft names what went out');

  // One of the two comes back.
  await req('PUT', `/documents/${ret.id}`, {
    items: [{ productId: laptop.id, quantity: 1, price: 900, imeis: 'WB14A0002' }],
  });
  const done = await confirm(ret.id);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(await stockOf(laptop.id), 2, 'back on the shelf');
  const back = await unitOf('WB14A0002');
  assert.equal(back.unit.status, 'returned');
  assert.equal(back.available, true, 'and it can be sold again');
  assert.equal((await unitOf('WB14A0001')).unit.status, 'sold', 'its box-mate is still out');
});

test('a return cannot take back what did not go out on that invoice, or what is not out at all', async () => {
  const other = await draft('sales_invoice', customer.id, [
    { productId: laptop.id, quantity: 1, price: 900, imeis: 'WB14A0003' },
  ]);
  assert.equal((await confirm(other.id)).status, 200);

  const against = (await req('POST', `/documents/${invoice.id}/convert`, { docType: 'sales_return' })).json.document;
  await req('PUT', `/documents/${against.id}`, {
    items: [{ productId: laptop.id, quantity: 1, price: 900, imeis: 'WB14A0003' }],
  });
  const elsewhere = await confirm(against.id);
  assert.equal(elsewhere.status, 400);
  assert.match(elsewhere.json.error, /WB14A0003 did not go out on/);

  await req('PUT', `/documents/${against.id}`, {
    items: [{ productId: laptop.id, quantity: 1, price: 900, imeis: 'WB14A0002' }],
  });
  const onShelf = await confirm(against.id);
  assert.equal(onShelf.status, 400);
  assert.match(onShelf.json.error, /WB14A0002 is not out with a customer/);
  await req('DELETE', `/documents/${against.id}`);

  // Undo the other invoice so the shelf reads as before.
  assert.equal((await req('POST', `/documents/${other.id}/cancel`)).status, 200);
  assert.equal((await unitOf('WB14A0003')).unit.status, 'in_stock');
});

test('cancelling the return sends the unit out again — unless it has sold on since', async () => {
  // Sold on at the register in the meantime: the return cannot be undone.
  const back = (await unitOf('WB14A0002')).unit;
  const resold = await req('POST', '/orders', {
    items: [{ productId: laptop.id, quantity: 1, unitId: back.id }],
    paymentMethod: 'card',
  });
  assert.equal(resold.status, 201, JSON.stringify(resold.json));
  const stuck = await req('POST', `/documents/${ret.id}/cancel`);
  assert.equal(stuck.status, 400);
  assert.match(stuck.json.error, /WB14A0002 has been sold since it came back/);

  // Refunded at the register, it is on the shelf again and the return can be undone.
  const refund = await req('POST', `/orders/${resold.json.order.id}/refund`, { reason: 'changed mind' });
  assert.equal(refund.status, 200, JSON.stringify(refund.json));
  assert.equal((await unitOf('WB14A0002')).unit.status, 'returned');

  const undone = await req('POST', `/documents/${ret.id}/cancel`);
  assert.equal(undone.status, 200, JSON.stringify(undone.json));
  assert.equal((await unitOf('WB14A0002')).unit.status, 'sold', 'out with the customer again');
  assert.equal(await stockOf(laptop.id), 1);
});

test('cancelling the invoice puts its units back, and leaves one already returned where it is', async () => {
  // Take A0002 back again, this time on a return that stands.
  const again = (await req('POST', `/documents/${invoice.id}/convert`, { docType: 'sales_return' })).json.document;
  await req('PUT', `/documents/${again.id}`, {
    items: [{ productId: laptop.id, quantity: 1, price: 900, imeis: 'WB14A0002' }],
  });
  assert.equal((await confirm(again.id)).status, 200);
  assert.equal((await unitOf('WB14A0002')).unit.status, 'returned');

  // The invoice cannot go while a return stands against it; once that is
  // cancelled, undoing the invoice frees A0001 and does not touch A0002.
  assert.equal((await req('POST', `/documents/${again.id}/cancel`)).status, 200);
  const cancelled = await req('POST', `/documents/${invoice.id}/cancel`);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.equal((await unitOf('WB14A0001')).unit.status, 'in_stock');
  assert.equal(await stockOf(laptop.id), 3, 'all three on the shelf');
});

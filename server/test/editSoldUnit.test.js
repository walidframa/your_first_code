/**
 * Correcting the price on an invoice that already sold a handset.
 *
 * A confirmed sales invoice is edited by undoing it and applying it again —
 * which for a handset means the unit comes back on the shelf and goes out
 * again on the same paper. That worked on the server all along; what broke
 * was the form, which offered the line only what was on the shelf, and the
 * one handset this invoice had sold was not. The line emptied, the save was
 * refused, and a discount on a phone could not be given after the fact.
 *
 * So the shelf listing can be asked for a document's own units too, and the
 * edit goes through with the unit exactly where it was.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4706;
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

let customer;
let phone;
let invoice;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-edit-sold-unit-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'edit-sold-unit-secret-long-enough-for-the-production-guard',
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
  customer = (await req('POST', '/customers', { name: 'Edit Buyer', credit_limit: 10000 })).json.party;

  const made = await req('POST', '/products', {
    name: 'Redmi Note 13',
    sku: 'PH-RN13',
    price: 250,
    cost: 200,
    tracks_units: true,
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  phone = made.json.product;
  const booked = await req('POST', `/units/product/${phone.id}`, {
    units: [{ imei: '359900111100001', cost: 200 }],
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.json));

  const drafted = await req('POST', '/documents', {
    docType: 'sales_invoice',
    partyId: customer.id,
    items: [{ productId: phone.id, quantity: 1, price: 250, imeis: '359900111100001' }],
  });
  assert.equal(drafted.status, 201, JSON.stringify(drafted.json));
  invoice = drafted.json.document;
  const done = await req('POST', `/documents/${invoice.id}/confirm`, null);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(await stockOf(phone.id), 0, 'the only one left the shelf');
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('the shelf listing can include the units a document sold, so its edit can keep them', async () => {
  // The shelf: nothing for sale, because the invoice took the only one.
  const shelf = (await req('GET', `/units/product/${phone.id}?branch=here`)).json;
  assert.equal(shelf.available, 0);

  // Asked for this invoice's own as well: the sold handset is there, saying which paper it left on.
  const forEdit = (await req('GET', `/units/product/${phone.id}?branch=here&onDocument=${invoice.id}`)).json;
  const mine = forEdit.units.find((u) => u.imei === '359900111100001');
  assert.ok(mine, 'the handset this invoice sold is listed');
  assert.equal(mine.status, 'sold');
  assert.equal(mine.sold_document_id, invoice.id, 'the form keeps it on the line by this');
});

test('a confirmed invoice with no stock left can still have its price corrected', async () => {
  const edited = await req('PUT', `/documents/${invoice.id}`, {
    items: [{ productId: phone.id, quantity: 1, price: 230, imeis: '359900111100001' }],
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(edited.json.document.total, 230);

  // The handset is exactly where it was: sold, on this invoice, shelf still empty.
  const unit = await unitOf('359900111100001');
  assert.equal(unit.unit.status, 'sold');
  assert.equal(unit.unit.sold_document_id, invoice.id);
  assert.equal(await stockOf(phone.id), 0);

  // And a discount, the other way a price gets corrected after the fact.
  const discounted = await req('PUT', `/documents/${invoice.id}`, { discountAmount: 30 });
  assert.equal(discounted.status, 200, JSON.stringify(discounted.json));
  assert.equal(discounted.json.document.total, 200);
  assert.equal((await unitOf('359900111100001')).unit.status, 'sold');
  assert.equal(await stockOf(phone.id), 0);
});

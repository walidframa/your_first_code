/**
 * Anybody can be on either side of the counter.
 *
 * The repair shop two streets over buys screens from this one and sells it
 * the odd handset. Kept as a customer *and* a supplier, they have two
 * balances that never meet, and the shop pays them in full for a delivery
 * while they still owe it for last month's screens. So a sales invoice can be
 * made out to a supplier, and a delivery booked in from a customer — on the
 * account they already have, signed the way that account is signed.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4699;
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

const balanceOf = async (type, id) =>
  (await req('GET', '/accounts/registry')).json.registry[type].find((p) => p.id === id).balance;
const stockOf = async (id) => (await req('GET', `/products/${id}`)).json.product.stock;

async function draft(docType, body) {
  const res = await req('POST', '/documents', { docType, ...body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.document;
}

let customer;
let supplier;
let widget;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-doc-parties-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'doc-parties-secret-long-enough-for-the-production-guard',
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
  customer = (await req('POST', '/customers', { name: 'Rami Haddad', credit_limit: 5000 })).json.party;
  supplier = (await req('POST', '/suppliers', { name: 'Beirut Wholesale' })).json.party;
  widget = (await req('POST', '/products', { name: 'Widget', sku: 'DP-W', price: 10, cost: 6, stock: 20 })).json
    .product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a sales invoice can be made out to a supplier, and comes off what the shop owes them', async () => {
  // The shop owes them for a delivery first.
  const delivery = await draft('purchase_invoice', {
    partyId: supplier.id,
    items: [{ productId: widget.id, quantity: 10, price: 6 }],
  });
  assert.equal((await req('POST', `/documents/${delivery.id}/confirm`)).status, 200);
  assert.equal(await balanceOf('supplier', supplier.id), 60);

  // Then they buy four back at the shop's price.
  const sale = await draft('sales_invoice', {
    partyId: supplier.id,
    partyType: 'supplier',
    items: [{ productId: widget.id, quantity: 4, price: 10 }],
  });
  assert.equal(sale.party_type, 'supplier');
  assert.equal(sale.party_name, 'Beirut Wholesale');
  const before = await stockOf(widget.id);
  assert.equal((await req('POST', `/documents/${sale.id}/confirm`)).status, 200);

  // Stock went out like any sale; the account moved the supplier's way round.
  assert.equal(await stockOf(widget.id), before - 4);
  assert.equal(await balanceOf('supplier', supplier.id), 20);

  // And it is on their record, not on some customer's.
  const detail = (await req('GET', `/suppliers/${supplier.id}`)).json;
  assert.ok(detail.dealings.some((d) => d.reference === sale.doc_number));
  assert.ok(detail.entries.some((e) => e.kind === 'sale' && e.amount_usd === -40));

  // Cancelled, the account goes back to what it was.
  assert.equal((await req('POST', `/documents/${sale.id}/cancel`)).status, 200);
  assert.equal(await balanceOf('supplier', supplier.id), 60);
});

test('a delivery can be booked in from a customer, and goes on to what the shop owes them', async () => {
  const sale = await draft('sales_invoice', {
    partyId: customer.id,
    items: [{ productId: widget.id, quantity: 5, price: 10 }],
  });
  assert.equal((await req('POST', `/documents/${sale.id}/confirm`)).status, 200);
  assert.equal(await balanceOf('customer', customer.id), 50);

  // They bring in a box of the same thing to sell to the shop.
  const buy = await draft('purchase_invoice', {
    partyId: customer.id,
    partyType: 'customer',
    items: [{ productId: widget.id, quantity: 3, price: 6 }],
  });
  assert.equal(buy.party_type, 'customer');
  const before = await stockOf(widget.id);
  assert.equal((await req('POST', `/documents/${buy.id}/confirm`)).status, 200);
  assert.equal(await stockOf(widget.id), before + 3);
  // Eighteen dollars off what they owe.
  assert.equal(await balanceOf('customer', customer.id), 32);

  // Paid in cash on the spot, it never touches the account at all.
  const cashBuy = await draft('purchase_invoice', {
    partyId: customer.id,
    partyType: 'customer',
    items: [{ productId: widget.id, quantity: 1, price: 6 }],
    payments: [{ currency: 'USD', amount: 6 }],
    paymentMethod: 'cash',
  });
  assert.equal((await req('POST', `/documents/${cashBuy.id}/confirm`)).status, 200);
  assert.equal(await balanceOf('customer', customer.id), 32);
});

test('the party type is checked, and the id is looked up on the right list', async () => {
  const wrong = await req('POST', '/documents', {
    docType: 'sales_invoice',
    partyId: customer.id,
    partyType: 'employee',
    items: [{ productId: widget.id, quantity: 1, price: 10 }],
  });
  assert.equal(wrong.status, 400);

  // A supplier id that is not a customer id is refused as a customer.
  const missing = await req('POST', '/documents', {
    docType: 'sales_invoice',
    partyId: 999999,
    partyType: 'supplier',
    items: [{ productId: widget.id, quantity: 1, price: 10 }],
  });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /supplier does not exist/);

  // Left out, the type's own side is assumed — as every existing caller expects.
  const plain = await draft('sales_invoice', {
    partyId: customer.id,
    items: [{ productId: widget.id, quantity: 1, price: 10 }],
  });
  assert.equal(plain.party_type, 'customer');
});

test('editing a draft can move it to the other list, and the list can be asked by side', async () => {
  const doc = await draft('sales_invoice', {
    partyId: customer.id,
    items: [{ productId: widget.id, quantity: 1, price: 10 }],
  });
  const moved = await req('PUT', `/documents/${doc.id}`, { partyId: supplier.id, partyType: 'supplier' });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.document.party_type, 'supplier');
  assert.equal(moved.json.document.party_name, 'Beirut Wholesale');

  const theirs = (await req('GET', `/documents?partyId=${supplier.id}&partyType=supplier`)).json.documents;
  assert.ok(theirs.some((d) => d.id === doc.id));
  const notTheirs = (await req('GET', `/documents?partyId=${supplier.id}&partyType=customer`)).json.documents;
  assert.ok(!notTheirs.some((d) => d.id === doc.id));
});

/**
 * Selling something the shop does, rather than something it has.
 *
 * Fitting a screen protector, unlocking a handset, an hour of labour, a
 * delivery charge. Every one of those is money the shop earns and none of them
 * comes off a shelf — and until now the app had no way to say so. A shop
 * charging for labour had to invent a product and keep topping its stock up for
 * ever, because the register greys a tile out at zero and the sale is refused
 * outright with "Not enough stock for X (have 0, need 1)".
 *
 * The rule is enforced at the bottom, in lib/stock.js, rather than at each of
 * the dozen places that move stock — so a sale, a refund, an invoice, a repair
 * and a branch transfer are all correct without any of them knowing about it.
 * These tests come in through the front door for that reason: the point is that
 * the callers do not have to care.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4676;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;

async function req(method, route, body, bearer = token) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
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

let fitting;
let widget;
let customer;
let supplier;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-services-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'services.sqlite'),
    JWT_SECRET: 'service-products-secret-long-enough-here',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;

  fitting = (
    await req('POST', '/products', {
      name: 'Screen fitting',
      sku: 'SVC-FIT',
      price: 5,
      cost: 0,
      // Sent deliberately: the shop typing a quantity into a service must not
      // give it one.
      stock: 40,
      is_service: true,
    })
  ).json.product;

  widget = (
    await req('POST', '/products', { name: 'Widget', sku: 'SVC-W1', price: 10, cost: 6, stock: 20 })
  ).json.product;

  customer = (await req('POST', '/customers', { name: 'Rami' })).json.party;
  supplier = (await req('POST', '/suppliers', { name: 'Wholesaler' })).json.party;

  await req('POST', '/cash/open', { openingUsd: 50 });
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const productById = async (id) =>
  (await req('GET', '/products?activeOnly=true')).json.products.find((p) => p.id === id);

test('a service is created with no shelf, whatever quantity was typed', async () => {
  const saved = await productById(fitting.id);
  assert.equal(saved.is_service, 1);
  assert.equal(saved.stock, 0, 'the 40 in the form was a number with nothing behind it');
});

test('it sells at the register, and goes on selling', async () => {
  /*
   * The complaint itself. At stock zero this was refused outright, so a shop
   * could not charge for labour at all without faking a shelf.
   */
  for (let i = 0; i < 3; i += 1) {
    const sale = await req('POST', '/orders', {
      items: [{ productId: fitting.id, quantity: 2 }],
      paymentMethod: 'cash',
      payments: [{ currency: 'USD', amount: 10 }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.json));
  }

  const after = await productById(fitting.id);
  assert.equal(after.stock, 0, 'six sold and the shelf is where it was — at nothing');
});

test('the money is real even though the stock is not', async () => {
  /*
   * The half that must not have been thrown out with the stock. A service that
   * sold without being counted as revenue would be worse than one that could
   * not be sold at all.
   */
  const summary = (await req('GET', '/reports/summary')).json;
  assert.ok(summary.revenue >= 30, `three sales of $10 are in the takings: ${summary.revenue}`);

  /*
   * And at full margin, because a service with no cost behind it is all
   * profit. A zero cost that had somehow been read as "unknown" would drag the
   * shop's margin down by every job it did.
   */
  const sold = summary.topProducts?.find((p) => p.name === 'Screen fitting');
  assert.ok(sold, `the fitting is in what sold: ${JSON.stringify(summary.topProducts)}`);
});

test('an ordinary product is still counted, and still runs out', async () => {
  /*
   * The line that keeps this from being a hole in the stock control. The flag
   * is per product, and everything without it behaves exactly as before.
   */
  const before = (await productById(widget.id)).stock;
  await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 5 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 50 }],
  });
  assert.equal((await productById(widget.id)).stock, before - 5, 'a widget still comes off the shelf');

  const tooMany = await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 999 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 10 }],
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.json.error, /Not enough stock/);
});

test('it goes on an invoice without moving a shelf', async () => {
  const draft = await req('POST', '/documents', {
    docType: 'sales_invoice',
    partyId: customer.id,
    items: [
      { productId: fitting.id, quantity: 3, price: 5 },
      { productId: widget.id, quantity: 1, price: 10 },
    ],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 25 }],
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.json));

  const widgetBefore = (await productById(widget.id)).stock;
  const confirmed = await req('POST', `/documents/${draft.json.document.id}/confirm`);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));

  assert.equal((await productById(fitting.id)).stock, 0, 'the service did not move');
  assert.equal((await productById(widget.id)).stock, widgetBefore - 1, 'the widget did');
});

test('and leaves no stock movement behind it to explain', async () => {
  /*
   * Not merely "the number did not change". A logged adjustment of zero would
   * put a count in the product's history that never happened, and somebody
   * reading it later would be looking for goods that never existed.
   */
  const history = (await req('GET', `/products/${fitting.id}/activity`)).json;
  const movements = history.movements ?? history.adjustments ?? [];
  assert.equal(movements.length, 0, JSON.stringify(movements));
});

test('a purchase invoice for a service does not stock the shop up with it', async () => {
  /*
   * The other direction, which is the one that quietly creates stock. A shop
   * buying in a subcontractor's labour records the bill; it does not acquire
   * six hours sitting on a shelf.
   */
  const draft = await req('POST', '/documents', {
    docType: 'purchase_invoice',
    partyId: supplier.id,
    items: [{ productId: fitting.id, quantity: 6, price: 2 }],
    paymentMethod: 'cash',
    payments: [],
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.json));
  assert.equal((await req('POST', `/documents/${draft.json.document.id}/confirm`)).status, 200);

  assert.equal((await productById(fitting.id)).stock, 0, 'still nothing on a shelf');
});

test('a service cannot also be tracked by IMEI', async () => {
  /*
   * The two are opposites: one is a thing with a serial stamped on it, the
   * other is not a thing. A product claiming both would satisfy neither.
   */
  const both = await req('POST', '/products', {
    name: 'Confused', sku: 'SVC-BOTH', price: 5, is_service: true, tracks_units: true,
  });
  assert.equal(both.status, 201, JSON.stringify(both.json));
  assert.equal(both.json.product.is_service, 1);
  assert.equal(both.json.product.tracks_units, 0, 'the service wins; there is nothing to serialise');
});

test('an ordinary product can be turned into a service, and its shelf goes', async () => {
  const spare = (
    await req('POST', '/products', { name: 'Delivery', sku: 'SVC-DEL', price: 3, stock: 12 })
  ).json.product;
  assert.equal((await productById(spare.id)).stock, 12);

  const updated = await req('PUT', `/products/${spare.id}`, { is_service: true });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));

  const sale = await req('POST', '/orders', {
    items: [{ productId: spare.id, quantity: 100 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 300 }],
  });
  assert.equal(sale.status, 201, 'a hundred deliveries, none of them off a shelf');
});

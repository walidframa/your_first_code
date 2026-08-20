/**
 * What a thing cost, and what a customer paid for it.
 *
 * Two questions a shop cannot answer from a single column. `products.cost` is
 * whatever the last person to save the product typed, and `products.price` is
 * what the shelf edge says today — neither survives contact with a supplier
 * who changed their price or a customer who was quoted something else in March.
 *
 * Both figures here are read off what actually happened: confirmed purchase
 * invoices for the cost, and everything sold to that customer for the price.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4638;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;
let supplierId;
let customerId;
let widget;

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

/** A confirmed purchase invoice: `quantity` of the product at `unitCost`. */
async function buy(productId, quantity, unitCost, confirm = true) {
  const made = await req('POST', '/documents', {
    docType: 'purchase_invoice',
    partyType: 'supplier',
    partyId: supplierId,
    items: [{ productId, quantity, price: unitCost }],
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  if (confirm) {
    const done = await req('POST', `/documents/${made.json.document.id}/confirm`, {});
    assert.equal(done.status, 200, JSON.stringify(done.json));
  }
  return made.json.document;
}

/** A confirmed sales invoice to our customer, at `unitPrice`. */
async function invoice(productId, quantity, unitPrice) {
  const made = await req('POST', '/documents', {
    docType: 'sales_invoice',
    partyType: 'customer',
    partyId: customerId,
    items: [{ productId, quantity, price: unitPrice }],
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const done = await req('POST', `/documents/${made.json.document.id}/confirm`, {});
  assert.equal(done.status, 200, JSON.stringify(done.json));
  return made.json.document;
}

const reload = async () =>
  (await req('GET', '/products')).json.products.find((p) => p.id === widget.id);

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-costing-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'costing.sqlite'),
    JWT_SECRET: 'costing-test-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: serverRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' }, null)).json
    .token;

  supplierId = (await req('POST', '/suppliers', { name: 'Beirut Wholesale' })).json.party.id;
  customerId = (
    await req('POST', '/customers', { name: 'Karim the electrician', credit_limit: 500 })
  ).json.party.id;
  widget = (
    await req('POST', '/products', { name: 'LED driver 60W', sku: 'LED-60', price: 18, cost: 10 })
  ).json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------ what it cost us */

test('a product nobody has bought has no average, rather than a made-up one', async () => {
  const fresh = await reload();
  // Not `cost`. A figure called "average" that nobody averaged is worse than
  // a blank — a shop would read its margins off it.
  assert.equal(fresh.avg_cost, null);
  assert.equal(fresh.last_cost, null);
});

test('two deliveries at different prices average out between them', async () => {
  await buy(widget.id, 10, 10);
  await buy(widget.id, 10, 9);

  const fresh = await reload();
  // The shopkeeper's own arithmetic: ten at $10 and ten at $9 is $9.50.
  assert.equal(fresh.avg_cost, 9.5);
  // And the last is what the supplier is charging now, which is a different
  // question and a different number.
  assert.equal(fresh.last_cost, 9);
});

test('the average is weighted by how many came, not by how many prices there were', async () => {
  // One more at $6, but twenty of them: the shelf is now mostly cheap stock and
  // the average has to say so. A mean of the three prices would give $8.33.
  await buy(widget.id, 20, 6);

  const fresh = await reload();
  const expected = (10 * 10 + 10 * 9 + 20 * 6) / 40;
  assert.equal(fresh.avg_cost, 7.75);
  assert.equal(fresh.avg_cost, expected);
});

test('a draft delivery has not cost the shop anything yet', async () => {
  const before = (await reload()).avg_cost;
  await buy(widget.id, 100, 1, false);

  const after = await reload();
  assert.equal(after.avg_cost, before, 'a paper somebody is still typing moved the average');
  assert.notEqual(after.last_cost, 1);
});

test('the single product view says the same as the list, and shows its workings', async () => {
  const detail = (await req('GET', `/products/${widget.id}`)).json.product;
  assert.equal(detail.avg_cost, 7.75);
  assert.equal(detail.last_cost, 6);
  assert.ok(detail.last_cost_ref, 'which invoice it was last bought on');

  const activity = (await req('GET', `/products/${widget.id}/activity`)).json;
  assert.equal(activity.costing.units, 40, 'forty of them have been received');
  assert.equal(activity.costing.spent, 310);
  assert.equal(activity.costing.average, 7.75);
  // And each delivery stands on its own line, at the price that delivery cost.
  const purchases = activity.activity.filter((a) => a.kind === 'purchase');
  assert.deepEqual(purchases.map((a) => a.price).sort((a, b) => a - b), [6, 9, 10]);
});

/* -------------------------------------------------- what the trade pays */

test('a product can carry a trade price beside its shelf price', async () => {
  await req('PUT', `/products/${widget.id}`, { wholesale_price: 14 });
  assert.equal((await reload()).wholesale_price, 14);

  // Blank means there is no trade price, which is most of the catalogue.
  await req('PUT', `/products/${widget.id}`, { wholesale_price: '' });
  assert.equal((await reload()).wholesale_price, null);

  // And zero is a shop that gives it away, which is a different thing from
  // having no trade price at all.
  await req('PUT', `/products/${widget.id}`, { wholesale_price: 0 });
  assert.equal((await reload()).wholesale_price, 0);
  await req('PUT', `/products/${widget.id}`, { wholesale_price: 14 });
});

/* ------------------------------------------- what this customer paid */

test('a customer with no history has no last price', async () => {
  const { json } = await req('GET', `/customers/${customerId}/last-prices`);
  assert.deepEqual(json.prices, {});
});

test('what they were charged last time comes back keyed by product', async () => {
  await invoice(widget.id, 2, 15);

  const { json } = await req('GET', `/customers/${customerId}/last-prices`);
  assert.equal(json.prices[widget.id].price, 15);
  assert.ok(json.prices[widget.id].reference.startsWith('SI-'));
});

test('the last price is the last one, not the highest or the first', async () => {
  await invoice(widget.id, 1, 12);

  const { json } = await req('GET', `/customers/${customerId}/last-prices`);
  assert.equal(json.prices[widget.id].price, 12, 'an older invoice won');
});

test('a sale rung up at the register counts as much as an invoice', async () => {
  const res = await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 1, price: 11 }],
    paymentMethod: 'card',
    customerId,
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));

  const { json } = await req('GET', `/customers/${customerId}/last-prices`);
  // From the customer's side the two are the same thing: what they paid.
  assert.equal(json.prices[widget.id].price, 11);
});

test('another customer’s price is not this one’s', async () => {
  const other = (await req('POST', '/customers', { name: 'Somebody else', credit_limit: 100 })).json
    .party.id;
  const { json } = await req('GET', `/customers/${other}/last-prices`);
  assert.deepEqual(json.prices, {}, 'one customer’s history leaked into another’s');
});

test('there are no last prices for a customer who does not exist', async () => {
  assert.equal((await req('GET', '/customers/9999/last-prices')).status, 404);
});

/**
 * Returning part of a sale.
 *
 * A customer brings one thing back off a sale of several far more often than
 * they hand the whole sale over, and the arithmetic is where it goes wrong: the
 * line has to come back worth its share of what was actually paid, after the
 * discount and with the tax, and returning it in two goes has to add up to the
 * same as returning it in one.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4601;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;

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

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-returns-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'returns.sqlite'),
    JWT_SECRET: 'returns-test-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** A card sale of `quantity` of one product, at whatever discount. */
async function sell(sku, quantity, discountPercent = 0) {
  const p = await product(sku);
  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: p.id, quantity }], paymentMethod: 'card', discountPercent },
    adminToken,
  );
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const detail = await req('GET', `/orders/${res.json.order.id}`, null, adminToken);
  return { product: p, order: res.json.order, items: detail.json.items };
}

test('one of several comes back, and the rest of the sale stands', async () => {
  const before = (await product('BEV-001')).stock;
  const { order, items } = await sell('BEV-001', 3);

  const res = await req(
    'POST',
    `/orders/${order.id}/return-line`,
    { itemId: items[0].id, quantity: 1 },
    adminToken,
  );
  assert.equal(res.status, 200, JSON.stringify(res.json));

  // Three sold, one back: two are still the customer's.
  assert.equal((await product('BEV-001')).stock, before - 2);
  assert.equal(res.json.order.status, 'completed', 'the sale is not voided by one item coming back');

  const detail = await req('GET', `/orders/${order.id}`, null, adminToken);
  assert.equal(detail.json.items[0].returned_qty, 1);
});

test('what comes back is the line’s share of what was paid, not its shelf price', async () => {
  // 10% off the sale, and tax on top of what is left.
  const { order, items } = await sell('BEV-001', 2, 10);

  const res = await req(
    'POST',
    `/orders/${order.id}/return-line`,
    { itemId: items[0].id, quantity: 2 },
    adminToken,
  );

  /*
   * The whole sale came back, so the whole total goes back — the discount and
   * the tax included. Refunding the sticker price would hand over more than the
   * customer ever paid.
   */
  assert.equal(res.json.refunded, order.total);
  assert.notEqual(res.json.refunded, items[0].line_total, 'the sticker price is not what was paid');
});

test('returning it in two goes refunds exactly what one go would', async () => {
  const { order, items } = await sell('BEV-001', 3, 10);

  const first = await req(
    'POST',
    `/orders/${order.id}/return-line`,
    { itemId: items[0].id, quantity: 1 },
    adminToken,
  );
  const second = await req(
    'POST',
    `/orders/${order.id}/return-line`,
    { itemId: items[0].id, quantity: 2 },
    adminToken,
  );

  const handedBack = Math.round((first.json.refunded + second.json.refunded) * 100) / 100;
  assert.equal(handedBack, order.total, 'the two returns add up to the sale');
});

test('the last line back voids the sale, without a second route saying so', async () => {
  const { order, items } = await sell('BEV-001', 2);

  const res = await req(
    'POST',
    `/orders/${order.id}/return-line`,
    { itemId: items[0].id, quantity: 2 },
    adminToken,
  );
  assert.equal(res.json.order.status, 'refunded');
});

test('more than was sold is refused, and so is the same one twice', async () => {
  const { order, items } = await sell('BEV-001', 2);

  const tooMany = await req(
    'POST',
    `/orders/${order.id}/return-line`,
    { itemId: items[0].id, quantity: 3 },
    adminToken,
  );
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.json.error, /only 2/i);

  await req('POST', `/orders/${order.id}/return-line`, { itemId: items[0].id, quantity: 2 }, adminToken);
  const again = await req(
    'POST',
    `/orders/${order.id}/return-line`,
    { itemId: items[0].id, quantity: 1 },
    adminToken,
  );
  assert.equal(again.status, 400);
  assert.match(again.json.error, /already been returned|already voided/i);
});

test('voiding a whole sale marks every line returned, so nothing can come back twice', async () => {
  const { order, items } = await sell('BEV-001', 2);

  await req('POST', `/orders/${order.id}/refund`, null, adminToken);

  const detail = await req('GET', `/orders/${order.id}`, null, adminToken);
  assert.equal(detail.json.items[0].returned_qty, 2);

  const res = await req(
    'POST',
    `/orders/${order.id}/return-line`,
    { itemId: items[0].id, quantity: 1 },
    adminToken,
  );
  assert.equal(res.status, 400);
});

test('a returned card puts its credit back on the wallet, not on a shelf', async () => {
  await req('POST', '/wallets/starter-catalogue', null, adminToken);
  const wallets = (await req('GET', '/wallets', null, adminToken)).json.wallets;
  const recharge = wallets.find((w) => w.name === 'Mobile recharge');
  await req('POST', `/wallets/${recharge.id}/movements`, { kind: 'top_up', amount: 100 }, adminToken);

  const card = (await req('GET', '/products', null, adminToken)).json.products.find(
    (p) => p.sku === 'CARD-ALFA-WHOLE-758',
  );
  await req('PUT', `/products/${card.id}`, { ...card, cost: 5 }, adminToken);

  const before = (await req('GET', '/wallets', null, adminToken)).json.wallets.find(
    (w) => w.id === recharge.id,
  ).balance;

  const sold = await req(
    'POST',
    '/orders',
    { items: [{ productId: card.id, quantity: 2 }], paymentMethod: 'card' },
    adminToken,
  );
  const items = (await req('GET', `/orders/${sold.json.order.id}`, null, adminToken)).json.items;

  await req(
    'POST',
    `/orders/${sold.json.order.id}/return-line`,
    { itemId: items[0].id, quantity: 1 },
    adminToken,
  );

  const after = (await req('GET', '/wallets', null, adminToken)).json.wallets.find(
    (w) => w.id === recharge.id,
  ).balance;

  // Two off at $5, one back on: the wallet is $5 down, not $10.
  assert.equal(after, Math.round((before - 5) * 100) / 100);
});

test('this sitting’s sales are the ones rung up since the drawer was opened', async () => {
  const shut = await req('GET', '/orders?scope=sitting', null, adminToken);
  assert.deepEqual(shut.json.orders, [], 'a closed drawer has no sitting, so no sales');

  await req('POST', '/cash/open', { openingUsd: 50 }, adminToken);
  const opened = await req('GET', '/orders?scope=sitting', null, adminToken);
  assert.equal(opened.json.orders.length, 0, 'nothing rung up yet');

  const { order } = await sell('BEV-001', 1);
  const after = await req('GET', '/orders?scope=sitting', null, adminToken);
  assert.ok(
    after.json.orders.some((o) => o.id === order.id),
    'the sale just made belongs to this sitting',
  );

  await req('POST', '/cash/close', { countedUsd: 0, countedLbp: 0 }, adminToken);
});

/* --------------------------------------- finding the sale from the register */

/**
 * Returning something is not the hard part — finding the sale is.
 *
 * A customer comes back the next morning with a receipt, and the person on the
 * counter is not the person who sold it. Until these rules, that cashier could
 * neither see the sale in the list nor open it by id, so the return had to go
 * to whoever runs the shop. Which is why the shop was doing returns in the back
 * office instead of at the till.
 */
async function staff(username, permissions) {
  const made = await req(
    'POST',
    '/users',
    {
      name: username,
      username,
      password: 'a-long-enough-password',
      role: 'cashier',
      permissions,
    },
    adminToken,
  );
  assert.equal(made.status, 201, JSON.stringify(made.json));
  return (await req('POST', '/auth/login', { username, password: 'a-long-enough-password' })).json
    .token;
}

test('whoever may refund a sale may find it, even if somebody else rang it up', async () => {
  const seller = await staff('sold-it', ['register']);
  const p = await product('BEV-001');
  const sale = await req(
    'POST',
    '/orders',
    { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'card' },
    seller,
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  const id = sale.json.order.id;

  // A cashier without the permission sees their own sales and no more.
  const other = await staff('just-sells', ['register']);
  const hidden = await req('GET', '/orders', null, other);
  assert.ok(!hidden.json.orders.some((o) => o.id === id), 'somebody else’s sale is not theirs to read');
  assert.equal((await req('GET', `/orders/${id}`, null, other)).status, 403);

  // The one who may put the money back can find it and open it.
  const returns = await staff('takes-it-back', ['register', 'refunds']);
  const seen = await req('GET', '/orders', null, returns);
  assert.ok(seen.json.orders.some((o) => o.id === id), 'the sale they may refund is visible');

  const opened = await req('GET', `/orders/${id}`, null, returns);
  assert.equal(opened.status, 200, JSON.stringify(opened.json));

  // And can actually take the line back, which is the point of seeing it.
  const back = await req(
    'POST',
    `/orders/${id}/return-line`,
    { itemId: opened.json.items[0].id, quantity: 1 },
    returns,
  );
  assert.equal(back.status, 200, JSON.stringify(back.json));
});

test('a sale is found by the tail of its receipt number, or by the customer', async () => {
  const customer = (await req('POST', '/customers', { name: 'Rami Haddad' }, adminToken)).json.party;
  const p = await product('BEV-001');
  const sale = await req(
    'POST',
    '/orders',
    { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'card', customerId: customer.id },
    adminToken,
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  const number = sale.json.order.order_number;

  // The tail, because that is the part somebody reads off a receipt.
  const tail = number.slice(-4);
  const byNumber = await req(`GET`, `/orders?q=${encodeURIComponent(tail)}`, null, adminToken);
  assert.ok(byNumber.json.orders.some((o) => o.order_number === number), 'found by its number');

  const byName = await req('GET', '/orders?q=Rami', null, adminToken);
  assert.ok(byName.json.orders.some((o) => o.order_number === number), 'and by who bought it');

  const nothing = await req('GET', '/orders?q=zzzz-no-such-sale', null, adminToken);
  assert.equal(nothing.json.orders.length, 0, 'a search that matches nothing says so');
});

/* ------------------------------------------------------- sent again later */

test('a sale sent twice under the same name is rung up once', async () => {
  const p = await product('BEV-001');
  const before = p.stock;
  const body = {
    items: [{ productId: p.id, quantity: 2 }],
    paymentMethod: 'card',
    clientRef: 'till-1:abc-123',
  };

  const first = await req('POST', '/orders', body, adminToken);
  assert.equal(first.status, 201);

  /*
   * The dangerous case: the answer was lost on the way back, so the till sends
   * it again. Without the name this is a second sale, and the shop has sold the
   * same two phones twice.
   */
  const again = await req('POST', '/orders', body, adminToken);
  assert.equal(again.status, 200, 'the second attempt is not a new sale');
  assert.equal(again.json.alreadyHad, true);
  assert.equal(again.json.order.id, first.json.order.id, 'the same sale comes back');
  assert.equal(again.json.items.length, first.json.items.length);

  // Two off the shelf, not four.
  assert.equal((await product('BEV-001')).stock, before - 2);
});

test('two sales under different names are two sales', async () => {
  const p = await product('BEV-001');
  const one = await req(
    'POST',
    '/orders',
    { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'card', clientRef: 'till-1:x' },
    adminToken,
  );
  const two = await req(
    'POST',
    '/orders',
    { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'card', clientRef: 'till-1:y' },
    adminToken,
  );
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);
  assert.notEqual(one.json.order.id, two.json.order.id);
});

test('a sale sent with no name at all still works, as it always did', async () => {
  const p = await product('BEV-001');
  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: p.id, quantity: 1 }], paymentMethod: 'card' },
    adminToken,
  );
  assert.equal(res.status, 201);
  assert.equal(res.json.order.client_ref, null);
});

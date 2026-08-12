/**
 * A swap, which is what most sales in a phone shop actually are.
 *
 * An old phone in, a newer one out, and some money in one direction or the
 * other. Done as a purchase and then a sale, the arithmetic is the cashier's,
 * the drawer moves twice for one exchange, and the case a shop notices most —
 * the old phone being worth *more* than the new one, so the shop pays — has no
 * flow at all.
 *
 * This is the money path, so the tests are about the till and the shelf rather
 * than the screen: what the drawer holds afterwards, what the handset cost, and
 * what the shop refuses to guess at.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4618;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let workDir;
let token;
let phoneProduct;

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
    // Not everything answers in JSON.
  }
  return { status: res.status, json };
}

/** What is in the drawer right now, in dollars. */
async function drawer() {
  const { json } = await req('GET', '/api/cash/current');
  assert.ok(json.expected, 'the cashbox is not open, so there is nothing to count');
  return json.expected.usd;
}

/** A handset on the shelf to sell, tracked by IMEI so a swap has two sides. */
async function stockAHandset(imei, cost) {
  const res = await req('POST', `/api/units/product/${phoneProduct.id}`, {
    units: [{ imei, cost, condition: 'new' }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));

  const listed = await req('GET', `/api/units/product/${phoneProduct.id}`);
  const unit = listed.json.units.find((u) => u.imei === imei);
  assert.ok(unit, `${imei} did not reach the shelf`);
  return unit;
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-tradein-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'trade-in-test-secret-long-enough-for-the-guard',
    BACKUP_DIR: path.join(workDir, 'backups'),
    PORT: String(PORT),
    NODE_ENV: 'test',
    TAX_RATE: '0',
  };

  assert.equal(spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env }).status, 0);
  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  token = (await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).json
    .token;
  assert.ok(token);

  // A float to pay differences out of, and a model to trade in against.
  await req('POST', '/api/cash/open', { openingUsd: 1000 });
  const made = await req('POST', '/api/products', {
    name: 'Galaxy A55',
    sku: 'PHONE-A55',
    price: 300,
    cost: 0,
    tracks_units: true,
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  phoneProduct = made.json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------- the customer pays the difference */

test('an old phone comes off what the customer owes', async () => {
  const unit = await stockAHandset('350000000000101', 200);
  const before = await drawer();

  const sale = await req('POST', '/api/orders', {
    items: [{ productId: phoneProduct.id, quantity: 1, unitId: unit.id }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 100 }],
    tradeIn: {
      productId: phoneProduct.id,
      imei: '350000000000201',
      condition: 'used',
      value: 200,
      sellerName: 'Rami',
    },
  });

  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  assert.equal(sale.json.order.total, 300, 'the sale is still worth what the phone sells for');
  assert.equal(sale.json.order.trade_in_value, 200);
  // $300 of goods, $200 of it in an old phone, $100 across the counter.
  assert.equal(await drawer(), before + 100);
});

test('the old phone lands on the shelf at what it was worth', async () => {
  // Costing it at nothing would report the whole of its eventual resale as
  // profit, which is the number the shop runs on.
  const { json } = await req('GET', `/api/units/product/${phoneProduct.id}`);
  const unit = json.units.find((u) => u.imei === '350000000000201');
  assert.ok(unit, 'the traded-in handset is not in stock');
  assert.equal(unit.cost, 200);
  assert.equal(unit.status, 'in_stock');
});

test('tendering less than the difference is refused, not the whole price', async () => {
  const unit = await stockAHandset('350000000000102', 200);
  const short = await req('POST', '/api/orders', {
    items: [{ productId: phoneProduct.id, quantity: 1, unitId: unit.id }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 50 }],
    tradeIn: { productId: phoneProduct.id, imei: '350000000000202', value: 200 },
  });
  assert.equal(short.status, 400);
  assert.match(short.json.error, /less than the 100\.00 USD due/);
});

/* ------------------------------------------- the shop pays the difference */

test('when the old phone is worth more, the shop pays out of the drawer', async () => {
  const unit = await stockAHandset('350000000000103', 100);
  const before = await drawer();

  const sale = await req('POST', '/api/orders', {
    items: [{ productId: phoneProduct.id, quantity: 1, unitId: unit.id }],
    paymentMethod: 'cash',
    payments: [],
    tradeIn: {
      productId: phoneProduct.id,
      imei: '350000000000203',
      value: 400,
      sellerName: 'Rami',
    },
  });

  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  assert.equal(sale.json.order.total, 300, 'the sale is still a $300 sale');
  assert.equal(sale.json.order.trade_in_value, 400);
  // A $400 phone in for a $300 one: a hundred dollars leaves the till.
  assert.equal(await drawer(), before - 100);
});

test('an even swap moves no money at all', async () => {
  const unit = await stockAHandset('350000000000104', 100);
  const before = await drawer();

  const sale = await req('POST', '/api/orders', {
    items: [{ productId: phoneProduct.id, quantity: 1, unitId: unit.id }],
    paymentMethod: 'cash',
    payments: [],
    tradeIn: { productId: phoneProduct.id, imei: '350000000000204', value: 300 },
  });

  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  assert.equal(await drawer(), before, 'an even swap touched the drawer');
});

test('the shop cannot pay a customer by card or put it on their tab', async () => {
  /*
   * Paying somebody by card is not a thing, and an account sale that owes the
   * customer money is the shop being lent money by a person who came in to buy
   * a phone. Notes out of the drawer is the only honest settlement, so it is
   * the only one offered.
   */
  for (const paymentMethod of ['card', 'account']) {
    const unit = await stockAHandset(`35000000000011${paymentMethod === 'card' ? 5 : 6}`, 100);
    const res = await req('POST', '/api/orders', {
      items: [{ productId: phoneProduct.id, quantity: 1, unitId: unit.id }],
      paymentMethod,
      customerId: 1,
      tradeIn: {
        productId: phoneProduct.id,
        imei: `3500000000002${paymentMethod === 'card' ? 15 : 16}`,
        value: 400,
      },
    });
    assert.equal(res.status, 400, `${paymentMethod} was allowed to pay a customer`);
    assert.match(res.json.error, /cash/i);
  }
});

/* ------------------------------------------------------- what it refuses */

test('a trade-in worth nothing is a mistake, not a free phone', async () => {
  const unit = await stockAHandset('350000000000107', 100);
  for (const value of [0, -50, 'abc', null]) {
    const res = await req('POST', '/api/orders', {
      items: [{ productId: phoneProduct.id, quantity: 1, unitId: unit.id }],
      paymentMethod: 'cash',
      payments: [{ currency: 'USD', amount: 300 }],
      tradeIn: { productId: phoneProduct.id, imei: '350000000000207', value },
    });
    assert.equal(res.status, 400, `a trade-in worth ${value} was accepted`);
  }
});

test('a swap cannot be undone by pressing refund', async () => {
  /*
   * Reversing one means handing the old phone back, taking the new one off
   * them, and moving the difference the other way — and the old phone may have
   * been sold on this morning. A refusal somebody can act on beats a stock
   * count and a drawer that are both quietly wrong.
   */
  const unit = await stockAHandset('350000000000108', 200);
  const sale = await req('POST', '/api/orders', {
    items: [{ productId: phoneProduct.id, quantity: 1, unitId: unit.id }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 100 }],
    tradeIn: { productId: phoneProduct.id, imei: '350000000000208', value: 200 },
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const refund = await req('POST', `/api/orders/${sale.json.order.id}/refund`);
  assert.equal(refund.status, 400);
  assert.match(refund.json.error, /part-exchange/);
});

test('an ordinary sale still refunds, and is untouched by any of this', async () => {
  const unit = await stockAHandset('350000000000109', 200);
  const sale = await req('POST', '/api/orders', {
    items: [{ productId: phoneProduct.id, quantity: 1, unitId: unit.id }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 300 }],
  });
  assert.equal(sale.status, 201);
  assert.equal(sale.json.order.trade_in_value, 0);
  assert.equal((await req('POST', `/api/orders/${sale.json.order.id}/refund`)).status, 200);
});

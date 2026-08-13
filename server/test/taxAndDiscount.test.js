/**
 * Two numbers the shop was never allowed to set.
 *
 * **Tax** was an environment variable pinned at eight per cent. Every shop this
 * was sold to — most of which charge no tax at all — added eight per cent to
 * every sale, printed it on every receipt, and had nowhere to go and change it.
 *
 * **The discount** could only be a percentage, so "call it fifty dollars" or
 * "knock off two hundred thousand" was arithmetic the cashier did in their head
 * with a customer waiting, and the sale recorded whatever percentage they
 * guessed at.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4619;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let workDir;
let token;
let product;

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

const setTax = (fields) => req('PUT', '/api/settings', fields);

/** One sale of a single $100 item, however the discount was agreed. */
const sell = (discount) =>
  req('POST', '/api/orders', {
    items: [{ productId: product.id, quantity: 1 }],
    paymentMethod: 'card',
    ...(discount ? { discount } : {}),
  });

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-tax-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'tax-test-secret-long-enough-for-the-production-guard',
    BACKUP_DIR: path.join(workDir, 'backups'),
    PORT: String(PORT),
    NODE_ENV: 'test',
    // Deliberately set, and deliberately ignored: the shop's own setting is
    // the authority now, and this proves the old one is really unplugged.
    TAX_RATE: '0.08',
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

  await req('PUT', '/api/settings', { exchange_rate: 90000 });
  const made = await req('POST', '/api/products', {
    name: 'A hundred dollar thing',
    sku: 'HUNDRED-1',
    price: 100,
    cost: 40,
    stock: 500,
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  product = made.json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ tax */

test('a new shop charges no tax at all', async () => {
  // Even with the old environment variable set to eight per cent, which is
  // what every shop sold so far has been quietly running.
  const { json } = await req('GET', '/api/orders/tax-rate');
  assert.equal(json.taxRate, 0);
  assert.equal(json.taxEnabled, false);

  const sale = await sell();
  assert.equal(sale.status, 201);
  assert.equal(sale.json.order.tax, 0);
  assert.equal(sale.json.order.total, 100);
});

test('a shop that does charge it sets its own rate, and it takes effect at once', async () => {
  // Without a restart: nobody restarts the server behind a shop counter.
  await setTax({ tax_enabled: 'true', tax_percent: 11, tax_name: 'VAT' });

  const { json } = await req('GET', '/api/orders/tax-rate');
  assert.equal(json.taxRate, 0.11);
  assert.equal(json.taxName, 'VAT');

  const sale = await sell();
  assert.equal(sale.json.order.tax, 11);
  assert.equal(sale.json.order.total, 111);
});

test('turning it off takes it off the next sale', async () => {
  await setTax({ tax_enabled: 'false' });
  const sale = await sell();
  assert.equal(sale.json.order.tax, 0);
  assert.equal(sale.json.order.total, 100);
});

test('a rate left switched off charges nothing, whatever number is in the box', async () => {
  // The rate is remembered so a shop can turn it back on without retyping it —
  // and remembering it must not mean quietly charging it.
  await setTax({ tax_enabled: 'false', tax_percent: 20 });
  const sale = await sell();
  assert.equal(sale.json.order.tax, 0);
});

test('a nonsense rate is refused, and does not half-apply', async () => {
  /*
   * The switch, the rate and the name arrive together as one form. Applying
   * the switch and then refusing the rate would turn tax *on* at whatever the
   * old rate happened to be — which is the opposite of what was asked for, and
   * the next customer is the one who finds out.
   */
  const refused = await setTax({ tax_enabled: 'true', tax_percent: 900 });
  assert.equal(refused.status, 400);

  const { json } = await req('GET', '/api/orders/tax-rate');
  assert.equal(json.taxEnabled, false, 'a refused save turned tax on anyway');
  assert.equal((await sell()).json.order.total, 100);
});

/* ------------------------------------------------------------- discount */

test('a discount can be a percentage, as it always could', async () => {
  const sale = await sell({ mode: 'percent', value: 10 });
  assert.equal(sale.json.order.discount, 10);
  assert.equal(sale.json.order.total, 90);
});

test('or a number of dollars, without anybody working out the percentage', async () => {
  const sale = await sell({ mode: 'usd', value: 35 });
  assert.equal(sale.json.order.discount, 35);
  assert.equal(sale.json.order.total, 65);
});

test('or an amount in pounds, converted with the shop’s own rate', async () => {
  // The server's rate, not the browser's: what the shop is owed is not the
  // browser's to assert.
  const sale = await sell({ mode: 'lbp', value: 900000 });
  assert.equal(sale.json.order.discount, 10, '900,000 LL at 90,000 is ten dollars');
  assert.equal(sale.json.order.total, 90);
});

test('a discount never exceeds the goods', async () => {
  // A total below zero is a different thing entirely — money owed to the
  // customer — and it has one honest cause, which is a trade-in.
  const sale = await sell({ mode: 'usd', value: 500 });
  assert.equal(sale.json.order.discount, 100);
  assert.equal(sale.json.order.total, 0);
});

test('nonsense is refused rather than recorded', async () => {
  for (const discount of [
    { mode: 'percent', value: 150 },
    { mode: 'usd', value: -20 },
    { mode: 'shekels', value: 5 },
  ]) {
    const res = await sell(discount);
    assert.equal(res.status, 400, `${JSON.stringify(discount)} was accepted`);
  }
});

test('a sale made offline before any of this still rings up', async () => {
  /*
   * A till that sold something while the server was away is holding a payload
   * written in the old shape. It arrives whenever the shop comes back, which
   * may be after this update, and it must not be refused — the money was
   * already taken.
   */
  const res = await req('POST', '/api/orders', {
    items: [{ productId: product.id, quantity: 1 }],
    paymentMethod: 'card',
    discountPercent: 25,
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.order.discount, 25);
  assert.equal(res.json.order.total, 75);
});

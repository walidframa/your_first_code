/**
 * Paying for one sale with more than one thing.
 *
 * A Lebanese counter settles in pieces: some dollars, some pounds, a card, a
 * Whish transfer, and whatever is left on the customer's account until Friday.
 * The app recorded one method per sale, so a cashier had to pick the biggest
 * piece and the rest was never written down — and a customer who was short had
 * to be rung up twice or turned away.
 *
 * What is being checked is where each piece *ends up*: cash in the drawer, an
 * account remainder on the customer's balance, and a card in neither.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 4591-4609 and 4613-4621 are spoken for; 4610/4611 belong to the e2e run.
const PORT = 4622;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let widget;
let customer;

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

const drawer = async () => (await req('GET', '/cash/current', null, adminToken)).json.expected.usd;
const owed = async () =>
  (await req('GET', `/customers/${customer.id}`, null, adminToken)).json.party.balance;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-tenders-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'tenders.sqlite'),
    JWT_SECRET: 'tenders-test-secret-long-enough-for-guard',
    ACCOUNT_SECRET: 'tenders-account-secret-long-enough-32ch',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;

  // Tax off, so every figure below is the one a shopkeeper would say out loud.
  await req('PUT', '/settings', { tax_rate: 0 }, adminToken);
  await req('POST', '/cash/open', { openingUsd: 0 }, adminToken);

  widget = (
    await req('POST', '/products', { name: 'Handset', sku: 'HS-1', price: 100, cost: 60, stock: 50 }, adminToken)
  ).json.product;
  customer = (
    await req('POST', '/customers', { name: 'Rami Haddad', credit_limit: 1000 }, adminToken)
  ).json.party;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const sell = (tenders, extra = {}) =>
  req(
    'POST',
    '/orders',
    { items: [{ productId: widget.id, quantity: 1 }], tenders, ...extra },
    adminToken,
  );

/* ------------------------------------------------------------------ splits */

test('half in cash and half on a card lands in the drawer once', async () => {
  const before = await drawer();

  const sale = await sell([
    { method: 'cash', amountUsd: 40 },
    { method: 'card', amountUsd: 60, label: 'Whish' },
  ]);
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  assert.equal(await drawer(), before + 40, 'only the notes reached the till');
  assert.equal(sale.json.order.change_due, 0);

  // Both pieces are on the record, and the card says which app it came through.
  const paid = sale.json.tenders;
  assert.equal(paid.length, 2);
  assert.equal(paid.find((p) => p.method === 'card').label, 'Whish');
  assert.equal(paid.find((p) => p.method === 'cash').amount_usd, 40);

  // One column still has to describe it for everything written before splits.
  assert.equal(sale.json.order.payment_method, 'cash');
});

test('a customer who is short pays what they can and owes the rest', async () => {
  const cashBefore = await drawer();
  const owedBefore = await owed();

  const sale = await sell(
    [
      { method: 'cash', amountUsd: 30 },
      { method: 'account', amountUsd: 70 },
    ],
    { customerId: customer.id },
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  assert.equal(await drawer(), cashBefore + 30);
  assert.equal(await owed(), owedBefore + 70, 'the rest is on their account');
});

test('the whole sale can go on the account, with nothing handed over', async () => {
  const cashBefore = await drawer();
  const owedBefore = await owed();

  const sale = await sell([{ method: 'account', amountUsd: 100 }], { customerId: customer.id });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  assert.equal(await drawer(), cashBefore, 'the drawer never opened');
  assert.equal(await owed(), owedBefore + 100);
  assert.equal(sale.json.order.payment_method, 'account');
});

test('pounds and dollars in the same hand are one payment', async () => {
  const before = await drawer();
  const { exchange_rate: rate } = (await req('GET', '/settings', null, adminToken)).json.settings;

  // $50 and enough pounds to cover the other $50.
  const sale = await sell([{ method: 'cash', amountUsd: 50, amountLbp: 50 * rate }]);
  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  assert.equal(sale.json.order.change_due, 0);
  assert.equal(await drawer(), before + 50, 'the dollars');
});

/* ------------------------------------------------------------- what is refused */

test('the pieces have to cover the sale', async () => {
  const short = await sell([
    { method: 'cash', amountUsd: 20 },
    { method: 'card', amountUsd: 30 },
  ]);
  assert.equal(short.status, 400);
  assert.match(short.json.error, /less than the 100.00 USD due/);
});

test('an account remainder needs somebody to owe it', async () => {
  const nameless = await sell([
    { method: 'cash', amountUsd: 60 },
    { method: 'account', amountUsd: 40 },
  ]);
  assert.equal(nameless.status, 400);
  assert.match(nameless.json.error, /Name the customer/);
});

test('and it has to fit inside their credit limit', async () => {
  const tight = (
    await req('POST', '/customers', { name: 'Tight Limit', credit_limit: 10 }, adminToken)
  ).json.party;

  const refused = await sell([{ method: 'account', amountUsd: 100 }], { customerId: tight.id });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /credit limit/);
});

test('over-paying in cash gives change, and only out of the cash', async () => {
  const before = await drawer();

  const sale = await sell([
    { method: 'card', amountUsd: 50, label: 'OMT' },
    { method: 'cash', amountUsd: 70 },
  ], { changeCurrency: 'USD' });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  assert.equal(sale.json.order.change_due, 20);
  assert.equal(await drawer(), before + 50, '$70 in, $20 back out');
});

/* --------------------------------------------------- the old shape still works */

test('a till that never heard of splits still checks out', async () => {
  const before = await drawer();

  const sale = await req(
    'POST',
    '/orders',
    {
      items: [{ productId: widget.id, quantity: 1 }],
      paymentMethod: 'cash',
      payments: [{ currency: 'USD', amount: 100 }],
    },
    adminToken,
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  assert.equal(await drawer(), before + 100);
  assert.equal(sale.json.tenders.length, 0, 'nothing invented for a sale that named one method');
});

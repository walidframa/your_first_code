/**
 * One account, on one piece of paper.
 *
 * The thing being checked is arithmetic somebody is going to hold in their hand
 * and argue about: that the statement opens where the last one closed, that the
 * running balance on every line is the sum of everything above it, and that the
 * closing figure is the account's real balance rather than a total of whatever
 * rows happened to be gathered.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4636;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let cashierToken;
let product;
let customer;
let supplier;

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

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-statements-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'statements.sqlite'),
    JWT_SECRET: 'statements-test-secret-long-enough-ok',
    ACCOUNT_SECRET: 'statements-account-secret-long-enough32',
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

  await req('POST', '/cash/open', { openingUsd: 1000 }, adminToken);

  product = (
    await req('POST', '/products', { name: 'Solar panel', sku: 'ST-SP1', price: 200, cost: 120 }, adminToken)
  ).json.product;
  await req('POST', '/inventory/adjust', { productId: product.id, delta: 50, reason: 'received' }, adminToken);

  customer = (
    await req('POST', '/customers', { name: 'Nabil Traders', credit_limit: 10_000 }, adminToken)
  ).json.party;
  supplier = (await req('POST', '/suppliers', { name: 'Beirut Wholesale' }, adminToken)).json.party;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const statement = (type, id, query = '') =>
  req('GET', `/${type}s/${id}/statement${query}`, null, adminToken).then((r) => r.json);

test('a fresh account states plainly that nothing has happened', async () => {
  const s = await statement('customer', customer.id);
  assert.equal(s.opening, 0);
  assert.equal(s.lines.length, 0);
  assert.equal(s.totals.closing, 0);
  assert.equal(s.party.name, 'Nabil Traders');
});

test('a sales invoice on account is a charge, and names the invoice', async () => {
  const doc = await req(
    'POST',
    '/documents',
    {
      docType: 'sales_invoice',
      partyType: 'customer',
      partyId: customer.id,
      items: [{ productId: product.id, quantity: 3, unitPrice: 200 }],
      paymentMethod: 'account',
    },
    adminToken,
  );
  assert.equal(doc.status, 201, JSON.stringify(doc.json));
  const number = doc.json.document.doc_number;
  await req('POST', `/documents/${doc.json.document.id}/confirm`, {}, adminToken);

  const s = await statement('customer', customer.id);
  const line = s.lines.find((l) => l.reference === number);
  assert.ok(line, 'the invoice is on the statement by its own number');
  assert.equal(line.charge, 600);
  assert.equal(line.credit, 0);
  assert.equal(line.balance, 600);
  assert.ok(line.documentId, 'and the row can be opened');
  assert.equal(s.totals.closing, 600);
});

test('a counter sale on account is on it too, by its order number', async () => {
  const sale = await req(
    'POST',
    '/orders',
    {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: 'account',
      customerId: customer.id,
    },
    cashierToken,
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const s = await statement('customer', customer.id);
  const line = s.lines.find((l) => l.reference === sale.json.order.order_number);
  assert.ok(line, 'the register sale is on the statement');
  assert.equal(line.charge, 200);
  assert.equal(line.orderId, sale.json.order.id);
  assert.equal(s.totals.closing, 800);
});

test('a payment voucher is a credit, and carries its PV number', async () => {
  const till = (await req('GET', '/vouchers/meta', null, adminToken)).json.accounts.cash[0];

  const voucher = await req(
    'POST',
    '/vouchers',
    {
      fromType: 'customer',
      fromId: customer.id,
      toType: 'cash',
      toId: till.id,
      amountUsd: 300,
      reason: 'customer',
    },
    adminToken,
  );
  assert.equal(voucher.status, 201, JSON.stringify(voucher.json));

  const s = await statement('customer', customer.id);
  const line = s.lines.find((l) => l.reference === voucher.json.voucher.voucher_number);
  assert.ok(line, 'the receipt is on the statement');
  assert.equal(line.credit, 300);
  assert.equal(line.charge, 0);
  assert.equal(line.voucherId, voucher.json.voucher.id);
  assert.equal(s.totals.closing, 500, '800 charged, 300 paid');
});

test('the running balance on every line is what is above it', async () => {
  const s = await statement('customer', customer.id);
  assert.ok(s.lines.length >= 3);

  let running = s.opening;
  for (const line of s.lines) {
    running = Math.round((running + line.charge - line.credit) * 100) / 100;
    assert.equal(line.balance, running, `line ${line.reference} carries the wrong running total`);
  }
  assert.equal(s.totals.closing, running, 'and the closing figure is the last of them');
});

test('the closing figure is the account’s real balance', async () => {
  const s = await statement('customer', customer.id);
  const party = (await req('GET', `/customers/${customer.id}`, null, adminToken)).json.party;
  assert.equal(s.totals.closing, party.balance);
});

/*
 * The thing a period is actually for: last month agreed and signed, this month
 * argued about. A statement that started at zero every time would say a customer
 * owing five hundred owes nothing.
 */
test('a period opens where the last one closed', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const s = await statement('customer', customer.id, `?from=${today}&to=${today}`);

  // Everything above was written today, so this period holds all of it and
  // opens at nothing.
  assert.equal(s.opening, 0);
  assert.equal(s.totals.closing, 500);

  // A window that starts tomorrow holds nothing, and opens at the full balance.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const later = await statement('customer', customer.id, `?from=${tomorrow}`);
  assert.equal(later.opening, 500, 'brought forward, not lost');
  assert.equal(later.lines.length, 0);
  assert.equal(later.totals.closing, 500);
});

test('a purchase invoice is on the supplier’s statement the same way', async () => {
  const doc = await req(
    'POST',
    '/documents',
    {
      docType: 'purchase_invoice',
      partyType: 'supplier',
      partyId: supplier.id,
      items: [{ productId: product.id, quantity: 10, unitPrice: 120 }],
      paymentMethod: 'account',
    },
    adminToken,
  );
  assert.equal(doc.status, 201, JSON.stringify(doc.json));
  await req('POST', `/documents/${doc.json.document.id}/confirm`, {}, adminToken);

  const s = await statement('supplier', supplier.id);
  const line = s.lines.find((l) => l.reference === doc.json.document.doc_number);
  assert.ok(line, 'the bill is on it');
  assert.equal(line.charge, 1200, 'positive means owed, on both sides of the book');
  assert.equal(s.totals.closing, 1200);
});

/*
 * An invoice paid in cash at the counter never touches the balance — but the
 * customer has it in their folder, so leaving it off the statement invites the
 * question the statement exists to answer.
 */
test('paper that never moved the balance is still on the statement, apart from it', async () => {
  const paid = await req(
    'POST',
    '/documents',
    {
      docType: 'sales_invoice',
      partyType: 'customer',
      partyId: customer.id,
      items: [{ productId: product.id, quantity: 1, unitPrice: 200 }],
      paymentMethod: 'cash',
      payments: [{ currency: 'USD', amount: 200 }],
    },
    adminToken,
  );
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  await req('POST', `/documents/${paid.json.document.id}/confirm`, {}, adminToken);

  const s = await statement('customer', customer.id);
  const closing = s.totals.closing;

  // Whatever it did, it did not change what is owed.
  assert.equal(closing, 500);

  const everywhere = [
    ...s.lines.map((l) => l.reference),
    ...s.alsoOnFile.map((r) => r.reference),
  ];
  assert.ok(
    everywhere.includes(paid.json.document.doc_number),
    'the cash invoice is somewhere on the page',
  );
});

test('a statement is behind the same permission as the account itself', async () => {
  const res = await req('GET', `/customers/${customer.id}/statement`, null, cashierToken);
  assert.equal(res.status, 403);
});

test('an account that does not exist says so', async () => {
  const res = await req('GET', '/customers/999999/statement', null, adminToken);
  assert.equal(res.status, 404);
});

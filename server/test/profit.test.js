/**
 * Profit, expenses and what happened to an item.
 *
 * The arithmetic here is the reason a shopkeeper trusts or distrusts the whole
 * app, so these check the figures against sales they can be traced back to.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4596;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let cashierToken;

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

const today = new Date().toISOString().slice(0, 10);

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-profit-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'profit.sqlite'),
    JWT_SECRET: 'profit-test-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  cashierToken = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' })).json
    .token;

  await req('POST', '/cash/open', { openingUsd: 200 }, adminToken);
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('profit is revenue less what the goods cost', async () => {
  const item = await product('BEV-001'); // $3.50, cost 1.10

  await req(
    'POST',
    '/orders',
    {
      items: [{ productId: item.id, quantity: 10 }],
      paymentMethod: 'card',
    },
    cashierToken,
  );

  const report = (await req('GET', `/expenses/profit?from=${today}&to=${today}`, null, adminToken)).json;

  // 10 × $3.50 = $35 of goods, plus 8% tax on the order.
  assert.ok(report.revenue >= 37.8, `revenue was ${report.revenue}`);
  assert.equal(report.cost, Math.round(item.cost * 10 * 100) / 100, 'cost comes from the line, not today');
  assert.equal(report.grossProfit, Math.round((report.revenue - report.cost) * 100) / 100);
  assert.ok(report.grossMargin > 0);
});

test('the cost on a sold line is the cost at the time, not today’s', async () => {
  const item = await product('SNK-001');
  const originalCost = item.cost;

  await req(
    'POST',
    '/orders',
    { items: [{ productId: item.id, quantity: 4 }], paymentMethod: 'card' },
    cashierToken,
  );

  const before = (await req('GET', `/expenses/profit?from=${today}&to=${today}`, null, adminToken)).json;

  // The supplier doubles their price tomorrow. Today's profit must not move.
  await req('PUT', `/products/${item.id}`, { cost: originalCost * 2 }, adminToken);

  const after = (await req('GET', `/expenses/profit?from=${today}&to=${today}`, null, adminToken)).json;
  assert.equal(after.cost, before.cost, 'a later price rise does not rewrite past profit');
});

test('a refunded order is left out of the takings entirely', async () => {
  const item = await product('BAK-002');
  const before = (await req('GET', `/expenses/profit?from=${today}&to=${today}`, null, adminToken)).json;

  const order = (
    await req(
      'POST',
      '/orders',
      { items: [{ productId: item.id, quantity: 3 }], paymentMethod: 'card' },
      cashierToken,
    )
  ).json.order;

  const withSale = (await req('GET', `/expenses/profit?from=${today}&to=${today}`, null, adminToken)).json;
  assert.ok(withSale.revenue > before.revenue);

  await req('POST', `/orders/${order.id}/refund`, null, adminToken);

  const afterRefund = (await req('GET', `/expenses/profit?from=${today}&to=${today}`, null, adminToken)).json;
  assert.equal(afterRefund.revenue, before.revenue, 'the sale is gone, not counted twice');
  assert.equal(afterRefund.refunds.orders, 1, 'but it is reported as a refund');
});

test('expenses turn gross profit into net profit', async () => {
  const gross = (await req('GET', `/expenses/profit?from=${today}&to=${today}`, null, adminToken)).json;

  await req(
    'POST',
    '/expenses',
    { category: 'rent', amountUsd: 300, paidWith: 'bank', note: 'July' },
    adminToken,
  );
  await req(
    'POST',
    '/expenses',
    { category: 'utilities', amountUsd: 45.5, paidWith: 'bank' },
    adminToken,
  );

  const net = (await req('GET', `/expenses/profit?from=${today}&to=${today}`, null, adminToken)).json;

  assert.equal(net.grossProfit, gross.grossProfit, 'expenses do not touch gross profit');
  assert.equal(net.expenses.total, 345.5);
  assert.equal(net.netProfit, Math.round((net.grossProfit - 345.5) * 100) / 100);

  // And the same report can be asked for without them.
  const without = (
    await req('GET', `/expenses/profit?from=${today}&to=${today}&includeExpenses=false`, null, adminToken)
  ).json;
  assert.equal(without.expenses.total, 0);
  assert.equal(without.netProfit, without.grossProfit);
});

test('spending is grouped by category so it can be compared', async () => {
  const { summary } = (await req('GET', `/expenses?from=${today}&to=${today}`, null, adminToken)).json;
  const rent = summary.byCategory.find((c) => c.category === 'rent');
  assert.equal(rent.total, 300);
  assert.ok(summary.byCategory[0].total >= summary.byCategory[1].total, 'biggest first');
});

test('a made-up category is refused', async () => {
  const res = await req('POST', '/expenses', { category: 'vibes', amountUsd: 10 }, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /category/i);
});

test('an expense paid in cash comes out of the drawer', async () => {
  const before = (await req('GET', '/cash/current', null, adminToken)).json.expected.usd;

  const expense = (
    await req(
      'POST',
      '/expenses',
      { category: 'supplies', amountUsd: 25, paidWith: 'cash', note: 'Bin bags' },
      adminToken,
    )
  ).json.expense;

  const after = (await req('GET', '/cash/current', null, adminToken)).json.expected.usd;
  assert.equal(after, Math.round((before - 25) * 100) / 100, 'the till is lighter by the expense');
  assert.ok(expense.cash_movement_id, 'and the two are linked');
});

test('a cash expense larger than the drawer is refused', async () => {
  const held = (await req('GET', '/cash/current', null, adminToken)).json.expected.usd;

  const res = await req(
    'POST',
    '/expenses',
    { category: 'wages', amountUsd: held + 500, paidWith: 'cash' },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /only holds/i);
  assert.equal(
    (await req('GET', '/cash/current', null, adminToken)).json.expected.usd,
    held,
    'and the drawer is untouched, not driven negative',
  );

  // The same expense is fine once it is not claimed to have come from the till.
  const byBank = await req(
    'POST',
    '/expenses',
    { category: 'wages', amountUsd: held + 500, paidWith: 'bank' },
    adminToken,
  );
  assert.equal(byBank.status, 201);
  await req('DELETE', `/expenses/${byBank.json.expense.id}`, null, adminToken);
});

test('an expense paid by bank leaves the drawer alone', async () => {
  const before = (await req('GET', '/cash/current', null, adminToken)).json.expected.usd;
  await req('POST', '/expenses', { category: 'fees', amountUsd: 12, paidWith: 'bank' }, adminToken);
  const after = (await req('GET', '/cash/current', null, adminToken)).json.expected.usd;
  assert.equal(after, before);
});

test('deleting a cash expense puts the money back in the drawer', async () => {
  const before = (await req('GET', '/cash/current', null, adminToken)).json.expected.usd;

  const expense = (
    await req(
      'POST',
      '/expenses',
      { category: 'transport', amountUsd: 40, paidWith: 'cash' },
      adminToken,
    )
  ).json.expense;
  assert.equal((await req('GET', '/cash/current', null, adminToken)).json.expected.usd, before - 40);

  await req('DELETE', `/expenses/${expense.id}`, null, adminToken);
  assert.equal(
    (await req('GET', '/cash/current', null, adminToken)).json.expected.usd,
    before,
    'the drawer is not left short by an expense the books no longer believe in',
  );
});

test('profit can be asked for one sitting of the till', async () => {
  const { session } = (await req('GET', '/cash/current', null, adminToken)).json;
  const report = (await req('GET', `/expenses/profit?sessionId=${session.id}`, null, adminToken)).json;

  assert.equal(report.session.id, session.id);
  assert.ok(report.revenue > 0, 'the sitting has takings in it');
  assert.equal(report.grossProfit, Math.round((report.revenue - report.cost) * 100) / 100);
});

test('named periods cover the right days', async () => {
  const day = (await req('GET', '/expenses/profit?preset=today', null, adminToken)).json;
  assert.equal(day.period.from, today);
  assert.equal(day.period.to, today);

  const month = (await req('GET', '/expenses/profit?preset=month', null, adminToken)).json;
  assert.equal(month.period.from, `${today.slice(0, 8)}01`);
  assert.ok(month.revenue >= day.revenue, 'a month contains its days');
});

test('a period with no sales reports zero rather than dividing by zero', async () => {
  const report = (await req('GET', '/expenses/profit?from=1999-01-01&to=1999-01-02', null, adminToken)).json;
  assert.equal(report.revenue, 0);
  assert.equal(report.grossMargin, 0);
  assert.equal(report.netMargin, 0);
});

/* ------------------------------------------------------------- item activity */

test('an item’s activity shows what it did and when', async () => {
  const item = await product('BAK-001');

  await req(
    'POST',
    '/orders',
    { items: [{ productId: item.id, quantity: 2 }], paymentMethod: 'card' },
    cashierToken,
  );
  await req(
    'POST',
    '/inventory/adjust',
    { productId: item.id, delta: -1, reason: 'damaged', note: 'Dropped one' },
    adminToken,
  );

  const { activity } = (await req('GET', `/products/${item.id}/activity`, null, adminToken)).json;

  const sale = activity.find((a) => a.kind === 'sale');
  assert.equal(sale.quantity, -2, 'a sale takes stock away');
  assert.ok(sale.reference.startsWith('ORD-'));

  const damaged = activity.find((a) => a.kind === 'adjustment' && a.detail === 'Dropped one');
  assert.equal(damaged.quantity, -1);

  // Newest first, so the last thing that happened is at the top.
  const times = activity.map((a) => a.at);
  assert.deepEqual(times, [...times].sort().reverse());
});

test('receiving a delivery shows as a purchase and moves the cost', async () => {
  const supplier = (await req('POST', '/suppliers', { name: 'Price Riser' }, adminToken)).json.party;
  const item = await product('APP-004');
  const oldCost = item.cost;
  const newCost = Math.round((oldCost + 1.25) * 100) / 100;

  const doc = (
    await req(
      'POST',
      '/documents',
      {
        docType: 'purchase_invoice',
        partyId: supplier.id,
        items: [{ productId: item.id, quantity: 6, price: newCost }],
      },
      adminToken,
    )
  ).json.document;
  await req('POST', `/documents/${doc.id}/confirm`, null, adminToken);

  const { activity, costHistory, product: updated } = (
    await req('GET', `/products/${item.id}/activity`, null, adminToken)
  ).json;

  assert.equal(updated.cost, newCost, 'the delivery sets the new cost');

  const purchase = activity.find((a) => a.kind === 'purchase');
  assert.equal(purchase.quantity, 6);
  assert.equal(purchase.reference, doc.doc_number);

  const change = costHistory[0];
  assert.equal(change.cost, newCost);
  assert.equal(change.previous_cost, oldCost);
  assert.equal(change.source, 'purchase');
  assert.equal(change.doc_number, doc.doc_number);
});

test('editing a cost is recorded, and a save that changes nothing is not', async () => {
  const item = await product('BAK-004');

  await req('PUT', `/products/${item.id}`, { cost: 9.99 }, adminToken);
  await req('PUT', `/products/${item.id}`, { cost: 9.99 }, adminToken);
  await req('PUT', `/products/${item.id}`, { name: item.name }, adminToken);

  const { costHistory } = (await req('GET', `/products/${item.id}/activity`, null, adminToken)).json;
  const edits = costHistory.filter((c) => c.source === 'edited');
  assert.equal(edits.length, 1, 'only the real change is on the record');
  assert.equal(edits[0].cost, 9.99);
});

test('cashiers cannot read an item’s activity or the profit report', async () => {
  const item = await product('BAK-001');
  assert.equal((await req('GET', `/products/${item.id}/activity`, null, cashierToken)).status, 403);
  assert.equal((await req('GET', '/expenses/profit', null, cashierToken)).status, 403);
  assert.equal((await req('GET', '/expenses', null, cashierToken)).status, 403);
});

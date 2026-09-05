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

/** Money compares to the cent, not to the float. */
const round = (n) => Math.round(n * 100) / 100;

/** Today's figures, which is what the shop is looking at when it complains. */
const day = async () => (await req('GET', '/expenses/profit?preset=today', null, adminToken)).json;

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

  /*
   * The figures below are an eight-per-cent shop's. Said out loud, because tax
   * is now the shop's own setting and it is off until somebody turns it on —
   * these tests should assert what they set up rather than lean on a default.
   */
  await req('PUT', '/settings', { tax_enabled: 'true', tax_percent: 8 }, adminToken);

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

/*
 * The bug this pins down was on a live shop's Profit screen: three sales
 * returned, and a profit figure that still counted them. A wholly refunded
 * order was already handled; a *partly* returned one was not, because it keeps
 * status = 'completed' and its original total, and the report summed that
 * total. The shop was being told it had earned money on a phone it had handed
 * back over the counter.
 */
test('a phone handed back comes off the takings, and off the cost with it', async () => {
  const item = await product('BAK-003');
  const before = (await req('GET', `/expenses/profit?from=${today}&to=${today}`, null, adminToken)).json;

  const order = (
    await req(
      'POST',
      '/orders',
      { items: [{ productId: item.id, quantity: 4 }], paymentMethod: 'card' },
      cashierToken,
    )
  ).json.order;

  const withSale = (await req('GET', `/expenses/profit?from=${today}&to=${today}`, null, adminToken)).json;
  const soldRevenue = round(withSale.revenue - before.revenue);
  const soldCost = round(withSale.cost - before.cost);
  assert.ok(soldRevenue > 0 && soldCost > 0, 'the sale registered in the first place');

  // One of the four comes back. The order stays completed — three were sold.
  const { items } = (await req('GET', `/orders/${order.id}`, null, adminToken)).json;
  await req('POST', `/orders/${order.id}/return-line`, { itemId: items[0].id, quantity: 1 }, adminToken);

  const after = (await req('GET', `/expenses/profit?from=${today}&to=${today}`, null, adminToken)).json;
  assert.equal(
    (await req('GET', `/orders/${order.id}`, null, adminToken)).json.order.status,
    'completed',
    'three of the four really were sold, so this is not a refunded order',
  );

  assert.equal(
    round(after.revenue - before.revenue),
    round(soldRevenue * 0.75),
    'a quarter of the sale came back, so a quarter of the revenue goes with it',
  );
  assert.equal(
    round(after.cost - before.cost),
    round(soldCost * 0.75),
    'and the shop no longer counts the cost of a phone it has back on the shelf',
  );

  // Return the rest: now there is nothing left, and it is a refund like any other.
  await req('POST', `/orders/${order.id}/return-line`, { itemId: items[0].id, quantity: 3 }, adminToken);
  const emptied = (await req('GET', `/expenses/profit?from=${today}&to=${today}`, null, adminToken)).json;
  assert.equal(round(emptied.revenue), round(before.revenue), 'nothing left of the sale');
  assert.equal(round(emptied.cost), round(before.cost));
});

test('what came back is reported, so the missing takings are accounted for', async () => {
  const item = await product('SNK-002');
  const order = (
    await req(
      'POST',
      '/orders',
      { items: [{ productId: item.id, quantity: 5 }], paymentMethod: 'card' },
      cashierToken,
    )
  ).json.order;

  const { items } = (await req('GET', `/orders/${order.id}`, null, adminToken)).json;
  await req('POST', `/orders/${order.id}/return-line`, { itemId: items[0].id, quantity: 2 }, adminToken);

  const report = (await req('GET', `/expenses/profit?from=${today}&to=${today}`, null, adminToken)).json;

  /*
   * Revenue quietly drops when part of a sale comes back, which is right — but
   * an owner reading a thinner month is owed the reason on the same screen
   * rather than being left to wonder where the money went.
   */
  assert.ok(report.refunds.partial > 0, 'the returned lines are reported');
  assert.ok(report.refunds.partialOrders >= 1, 'and so is how many sales they came off');
  assert.equal(round(report.refunds.partial), round(items[0].price * 2), 'valued at what it sold for');
});

test('what made the most counts invoiced sales, not only the register', async () => {
  // A limit they can trade inside, or confirming the invoice is refused on
  // credit grounds and this test would be measuring the wrong thing.
  const customer = (
    await req('POST', '/customers', { name: 'Invoice Only Co', credit_limit: 5000 }, adminToken)
  ).json.party;
  const item = await product('APP-002');

  const doc = (
    await req(
      'POST',
      '/documents',
      {
        docType: 'sales_invoice',
        partyId: customer.id,
        items: [{ productId: item.id, quantity: 2, price: 40 }],
      },
      adminToken,
    )
  ).json.document;
  const confirmed = await req('POST', `/documents/${doc.id}/confirm`, null, adminToken);
  assert.equal(confirmed.status, 200, `the invoice must actually confirm: ${confirmed.json?.error}`);

  const report = (await req('GET', `/expenses/profit?from=${today}&to=${today}`, null, adminToken)).json;
  const row = report.topProducts.find((p) => p.id === item.id);

  /*
   * The screen used to say "Nothing sold in this period" underneath a revenue
   * figure it had just printed, because this list only ever read the register.
   */
  assert.ok(row, 'a product sold on an invoice is one of the products that sold');
  assert.ok(row.revenue >= 80, `invoiced revenue is counted: ${row.revenue}`);

  /*
   * And the invoice reaches the totals at all, which is a bigger thing than it
   * looks. Documents were never stamped with the branch they were written at,
   * and every report is scoped to one — so `branch_id IS NULL` matched no
   * branch, and an invoice stayed out of the Profit screen until a restart
   * swept it into the main branch. A shop that invoices its trade customers
   * could read a month's takings and see only the register.
   */
  assert.ok(report.invoices.invoices >= 1, 'the invoice is in the totals, not only in the table');
  assert.ok(report.invoices.revenue >= 80, `invoiced revenue reached the report: ${report.invoices.revenue}`);
});

/* ------------------------------------------- a profit with nothing behind it */

/**
 * The complaint, in the shop's own words: "the profit is not logical."
 *
 * $21 in the drawer and $30.14 of profit beside it. Not a sum going wrong — a
 * product priced in a hurry and never costed. `products.cost` is NOT NULL
 * DEFAULT 0, so such a line sells at a cost of nought, contributes nothing to
 * subtract, and its whole selling price is reported as profit.
 *
 * The warning built for exactly this only counted `cost IS NULL`, which is the
 * rare case — a line from before costs were kept. The ordinary case, a zero,
 * sailed past it, so the shop was shown a wrong figure with nothing beside it
 * saying why.
 */
test('a product sold with no cost is not silently all profit', async () => {
  const made = await req(
    'POST',
    '/products',
    { name: 'Fuse box', sku: 'NOCOST-1', price: 30, stock: 10 },
    adminToken,
  );
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.product.cost, 0, 'a cost nobody typed is stored as nought, not as null');

  const before = await day();
  await req(
    'POST',
    '/orders',
    { items: [{ productId: made.json.product.id, quantity: 1 }], paymentMethod: 'card' },
    adminToken,
  );
  const after = await day();

  // The figure itself is unchanged — it is the shop's own data, and quietly
  // dropping the sale would lose revenue as well.
  // $30 plus this shop's 8%.
  assert.equal(
    round(after.grossProfit - before.grossProfit),
    32.4,
    'with no cost to subtract the whole price still lands in profit',
  );

  // What is new is that it says so, and says how much of the figure it is.
  assert.equal(after.unknownCostLines, before.unknownCostLines + 1);
  /* The goods, not the tax. What is unverified is the margin on the thing
     sold; the tax was never anybody's profit. */
  assert.equal(round(after.unknownCostValue - before.unknownCostValue), 30);
});

test('a properly costed sale raises no such warning', async () => {
  const before = await day();
  const item = await product('BEV-001'); // costs the shop 1.10
  await req(
    'POST',
    '/orders',
    { items: [{ productId: item.id, quantity: 2 }], paymentMethod: 'card' },
    adminToken,
  );
  const after = await day();
  assert.equal(after.unknownCostLines, before.unknownCostLines, 'a known cost is not a warning');
  assert.equal(after.unknownCostValue, before.unknownCostValue);
});

test('an hour of labour is not a missing cost', async () => {
  /*
   * A service has no cost of goods and never will. Counting it would leave a
   * repair shop with a permanent alarm about a figure that is perfectly right,
   * which is the fastest way to teach somebody to ignore a warning.
   */
  const service = await req(
    'POST',
    '/products',
    { name: 'Screen fitting', sku: 'SVC-FIT', price: 15, is_service: true },
    adminToken,
  );
  assert.equal(service.status, 201, JSON.stringify(service.json));

  const before = await day();
  await req(
    'POST',
    '/orders',
    { items: [{ productId: service.json.product.id, quantity: 1 }], paymentMethod: 'card' },
    adminToken,
  );
  const after = await day();
  assert.equal(round(after.grossProfit - before.grossProfit), 16.2, 'the labour is still profit');
  assert.equal(after.unknownCostLines, before.unknownCostLines, 'and it is not a missing cost');
});

test('a gift given away is not a missing cost either', async () => {
  /* It is priced at nothing on purpose, so the "sold for money" half of the
     test never lets it through — no clause of its own is needed, and this is
     here to keep it that way. */
  const item = await product('BEV-001');
  const before = await day();
  await req(
    'POST',
    '/orders',
    {
      items: [{ productId: item.id, quantity: 1, isGift: true }],
      paymentMethod: 'card',
    },
    adminToken,
  );
  const after = await day();
  assert.equal(after.unknownCostLines, before.unknownCostLines, 'priced at nothing on purpose');
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

test('a cash expense larger than the drawer is recorded, and warned about', async () => {
  const held = (await req('GET', '/cash/current', null, adminToken)).json.expected.usd;

  const res = await req(
    'POST',
    '/expenses',
    { category: 'wages', amountUsd: held + 500, paidWith: 'cash' },
    adminToken,
  );
  assert.equal(res.status, 201);
  assert.match(res.json.warning, /more than the drawer holds/i);
  assert.equal(
    (await req('GET', '/cash/current', null, adminToken)).json.expected.usd,
    -500,
    'the money really left, so the till shows it gone',
  );

  // Paid from somewhere else, the drawer is not involved and nothing is amiss.
  const byBank = await req(
    'POST',
    '/expenses',
    { category: 'wages', amountUsd: held + 500, paidWith: 'bank' },
    adminToken,
  );
  assert.equal(byBank.status, 201);
  assert.equal(byBank.json.warning, null);
  await req('DELETE', `/expenses/${byBank.json.expense.id}`, null, adminToken);

  // Put the till back where the rest of this file expects to find it.
  await req('DELETE', `/expenses/${res.json.expense.id}`, null, adminToken);
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

  /*
   * And how many have gone, without anybody adding up the rows.
   *
   * The list answers "when did that go out"; a shopkeeper deciding whether to
   * reorder is asking "do we sell these", which is a different question.
   */
  const { sales } = (await req('GET', `/products/${item.id}/activity`, null, adminToken)).json;
  assert.equal(sales.units, 2);
  assert.equal(sales.atCounter, 2);
  assert.equal(sales.onInvoices, 0);
  assert.ok(sales.firstSoldAt, 'and over what stretch');
  assert.ok(sales.lastSoldAt);
});

test('a return comes off what the item has sold', async () => {
  // Its own product, so the count is this test's and nobody else's.
  const item = (
    await req(
      'POST',
      '/products',
      { name: 'Returnable', sku: 'APP-RET', price: 10, cost: 4, stock: 20 },
      adminToken,
    )
  ).json.product;

  const order = (
    await req(
      'POST',
      '/orders',
      { items: [{ productId: item.id, quantity: 5 }], paymentMethod: 'card' },
      cashierToken,
    )
  ).json.order;

  const before = (await req('GET', `/products/${item.id}/activity`, null, adminToken)).json.sales;
  assert.equal(before.units, 5);

  // Two of the five come back.
  const { items } = (await req('GET', `/orders/${order.id}`, null, adminToken)).json;
  const returned = await req(
    'POST',
    `/orders/${order.id}/return-line`,
    { itemId: items[0].id, quantity: 2 },
    adminToken,
  );
  assert.equal(returned.status, 200, JSON.stringify(returned.json));

  const after = (await req('GET', `/products/${item.id}/activity`, null, adminToken)).json.sales;
  assert.equal(after.units, 3, 'five sold less two brought back is three sold');
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

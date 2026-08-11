/**
 * The cash drawer.
 *
 * The point of a session is that the drawer can be counted at the end and the
 * count checked, so these tests move money the ways a real shift does and then
 * check the arithmetic the close depends on.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4598;
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

/** Shut whatever is open, so each test starts from a known drawer. */
async function reset() {
  const { json } = await req('GET', '/cash/current', null, adminToken);
  if (json.session) {
    await req('POST', '/cash/close', { countedUsd: 0, countedLbp: 0 }, adminToken);
  }
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-cash-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'cash.sqlite'),
    JWT_SECRET: 'cash-test-secret-long-enough-for-the-guard',
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
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

beforeEach(reset);

test('opening records the float as money in the drawer', async () => {
  const res = await req('POST', '/cash/open', { openingUsd: 100, openingLbp: 2_000_000 }, adminToken);
  assert.equal(res.status, 201);
  assert.equal(res.json.session.status, 'open');
  assert.equal(res.json.session.opening_usd, 100);

  const current = await req('GET', '/cash/current', null, adminToken);
  assert.deepEqual(current.json.expected, { usd: 100, lbp: 2_000_000 });
});

test('only one drawer can be open at a time', async () => {
  await req('POST', '/cash/open', { openingUsd: 50 }, adminToken);
  const second = await req('POST', '/cash/open', { openingUsd: 50 }, adminToken);
  assert.equal(second.status, 400);
  assert.match(second.json.error, /already open/i);
});

test('a cash sale cannot be taken with the drawer shut', async () => {
  const item = await product('BEV-001');
  const res = await req(
    'POST',
    '/orders',
    {
      items: [{ productId: item.id, quantity: 1 }],
      paymentMethod: 'cash',
      payments: [{ currency: 'USD', amount: 20 }],
    },
    cashierToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /cashbox is closed/i);
});

test('a card sale is unaffected by a shut drawer', async () => {
  const item = await product('BEV-001');
  const res = await req(
    'POST',
    '/orders',
    { items: [{ productId: item.id, quantity: 1 }], paymentMethod: 'card' },
    cashierToken,
  );
  assert.equal(res.status, 201, 'card takings never touch the till');
});

test('a cash sale adds what stayed in the drawer, not what was handed over', async () => {
  await req('POST', '/cash/open', { openingUsd: 100, openingLbp: 1_000_000 }, adminToken);
  const item = await product('BEV-001');

  // $7.56 due, paid with a $20 note, change given in dollars.
  const sale = await req(
    'POST',
    '/orders',
    {
      items: [{ productId: item.id, quantity: 2 }],
      paymentMethod: 'cash',
      payments: [{ currency: 'USD', amount: 20 }],
      changeCurrency: 'USD',
    },
    cashierToken,
  );
  assert.equal(sale.status, 201);

  const { expected } = (await req('GET', '/cash/current', null, adminToken)).json;
  assert.equal(expected.usd, 107.56, 'the drawer gains the sale, not the note');
  assert.equal(expected.lbp, 1_000_000);
});

test('change given in pounds leaves the drawer heavier in one currency and lighter in the other', async () => {
  const opening = { usd: 100, lbp: 5_000_000 };
  await req('POST', '/cash/open', { openingUsd: opening.usd, openingLbp: opening.lbp }, adminToken);
  const item = await product('BEV-001');

  const sale = (
    await req(
      'POST',
      '/orders',
      {
        items: [{ productId: item.id, quantity: 2 }],
        paymentMethod: 'cash',
        payments: [{ currency: 'USD', amount: 20 }],
        changeCurrency: 'LBP',
      },
      cashierToken,
    )
  ).json.order;

  const { expected } = (await req('GET', '/cash/current', null, adminToken)).json;
  assert.equal(expected.usd, opening.usd + 20, 'the whole note went in');
  assert.equal(expected.lbp, opening.lbp - sale.change_lbp, 'and the change came out in pounds');
});

test('change split across currencies comes out of both piles', async () => {
  const opening = { usd: 100, lbp: 5_000_000 };
  await req('POST', '/cash/open', { openingUsd: opening.usd, openingLbp: opening.lbp }, adminToken);
  const item = await product('BEV-001');

  const sale = (
    await req(
      'POST',
      '/orders',
      {
        items: [{ productId: item.id, quantity: 2 }],
        paymentMethod: 'cash',
        payments: [{ currency: 'USD', amount: 20 }],
        changeCurrency: 'SPLIT',
        changeUsd: 5,
        changeLbp: 500000,
      },
      cashierToken,
    )
  ).json.order;

  assert.equal(sale.change_usd, 5);
  assert.equal(sale.change_lbp, 500000, 'the pounds are the notes the cashier chose');

  const { expected } = (await req('GET', '/cash/current', null, adminToken)).json;
  assert.equal(expected.usd, opening.usd + 20 - 5, 'the note went in, five dollars came back out');
  assert.equal(expected.lbp, opening.lbp - sale.change_lbp, 'and so did the pounds half');
});

test('refunding a cash sale takes the money back out', async () => {
  await req('POST', '/cash/open', { openingUsd: 100 }, adminToken);
  const item = await product('SNK-001');

  const order = (
    await req(
      'POST',
      '/orders',
      {
        items: [{ productId: item.id, quantity: 1 }],
        paymentMethod: 'cash',
        payments: [{ currency: 'USD', amount: 50 }],
        changeCurrency: 'USD',
      },
      cashierToken,
    )
  ).json.order;

  const afterSale = (await req('GET', '/cash/current', null, adminToken)).json.expected.usd;
  await req('POST', `/orders/${order.id}/refund`, null, adminToken);

  const afterRefund = (await req('GET', '/cash/current', null, adminToken)).json.expected.usd;
  assert.equal(afterRefund, 100, 'the drawer is back where it started');
  assert.ok(afterSale > afterRefund);
});

test('money can be put in and taken out by hand, with a reason', async () => {
  await req('POST', '/cash/open', { openingUsd: 50 }, adminToken);

  const topUp = await req(
    'POST',
    '/cash/movements',
    { direction: 'in', amountUsd: 100, reason: 'petty_cash', note: 'Float top-up' },
    adminToken,
  );
  assert.equal(topUp.status, 201);

  const paidOut = await req(
    'POST',
    '/cash/movements',
    { direction: 'out', amountUsd: 30, reason: 'expense', note: 'Milk and cleaning' },
    adminToken,
  );
  assert.equal(paidOut.status, 201);

  assert.equal((await req('GET', '/cash/current', null, adminToken)).json.expected.usd, 120);
});

test('a reason is required, and must be one the reports can add up', async () => {
  await req('POST', '/cash/open', { openingUsd: 50 }, adminToken);

  const noReason = await req('POST', '/cash/movements', { direction: 'out', amountUsd: 5 }, adminToken);
  assert.equal(noReason.status, 400);
  assert.match(noReason.json.error, /reason/i);

  const madeUp = await req(
    'POST',
    '/cash/movements',
    { direction: 'out', amountUsd: 5, reason: 'because' },
    adminToken,
  );
  assert.equal(madeUp.status, 400);
});

test('taking out more than the drawer holds is recorded, and warned about', async () => {
  await req('POST', '/cash/open', { openingUsd: 20 }, adminToken);
  const res = await req(
    'POST',
    '/cash/movements',
    { direction: 'out', amountUsd: 100, reason: 'expense' },
    adminToken,
  );

  assert.equal(res.status, 201, 'the money left, so it is written down');
  assert.match(res.json.warning, /more than the drawer holds/i);
  assert.equal(res.json.expected.usd, -80, 'and the till says so');

  // And it keeps saying so on reload — a warning shown once is a warning missed.
  const current = await req('GET', '/cash/current', null, adminToken);
  assert.equal(current.json.short, true);
});

test('a cashier is told the drawer is short without being told the figure', async () => {
  await req('POST', '/cash/open', { openingUsd: 20 }, adminToken);
  await req('POST', '/cash/movements', { direction: 'out', amountUsd: 100, reason: 'expense' }, cashierToken);

  const current = await req('GET', '/cash/current', null, cashierToken);
  assert.equal(current.json.short, true, 'told that it is short');
  assert.equal(current.json.expected, null, 'but still counts blind');
});

test('closing reports over and short against the count', async () => {
  await req('POST', '/cash/open', { openingUsd: 100, openingLbp: 1_000_000 }, adminToken);
  await req('POST', '/cash/movements', { direction: 'in', amountUsd: 50, reason: 'owner_funds' }, adminToken);

  // $145 counted where $150 was expected: five dollars short.
  const closed = await req(
    'POST',
    '/cash/close',
    { countedUsd: 145, countedLbp: 1_000_000, note: 'End of day' },
    adminToken,
  );
  assert.equal(closed.status, 200);

  const { session } = closed.json;
  assert.equal(session.status, 'closed');
  assert.equal(session.expected_usd, 150);
  assert.equal(session.counted_usd, 145);
  assert.equal(session.over_short_usd, -5);
  assert.equal(session.over_short_lbp, 0);
});

test('an over count is reported as over, not silently ignored', async () => {
  await req('POST', '/cash/open', { openingUsd: 100 }, adminToken);
  const closed = await req('POST', '/cash/close', { countedUsd: 112.5 }, adminToken);
  assert.equal(closed.json.session.over_short_usd, 12.5);
});

test('what is carried forward stays and the rest is banked', async () => {
  await req('POST', '/cash/open', { openingUsd: 500, openingLbp: 10_000_000 }, adminToken);

  const closed = await req(
    'POST',
    '/cash/close',
    { countedUsd: 500, countedLbp: 10_000_000, carriedUsd: 200, carriedLbp: 2_000_000 },
    adminToken,
  );

  const banked = closed.json.movements.find((m) => m.kind === 'bank_drop');
  assert.equal(banked.amount_usd, -300, 'the rest left for the bank');
  assert.equal(banked.amount_lbp, -8_000_000);

  const summary = await req('GET', `/cash/sessions/${closed.json.session.id}`, null, adminToken);
  assert.equal(summary.json.expected.usd, 200, 'and the drawer is left holding the new float');
});

test('more cannot be carried forward than was counted', async () => {
  await req('POST', '/cash/open', { openingUsd: 100 }, adminToken);
  const res = await req('POST', '/cash/close', { countedUsd: 80, carriedUsd: 120 }, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /carry forward/i);
});

test('a cashier counts blind — the expected figure is withheld until it is closed', async () => {
  await req('POST', '/cash/open', { openingUsd: 100 }, adminToken);

  const asCashier = await req('GET', '/cash/current', null, cashierToken);
  assert.equal(asCashier.json.session.status, 'open');
  assert.equal(asCashier.json.expected, null, 'a cashier cannot see what to make the count match');

  const asAdmin = await req('GET', '/cash/current', null, adminToken);
  assert.equal(asAdmin.json.expected.usd, 100);
});

test('the shift report totals sales by how they were paid', async () => {
  await req('POST', '/cash/open', { openingUsd: 100 }, adminToken);
  const item = await product('BAK-002');

  await req(
    'POST',
    '/orders',
    {
      items: [{ productId: item.id, quantity: 1 }],
      paymentMethod: 'cash',
      payments: [{ currency: 'USD', amount: 20 }],
      changeCurrency: 'USD',
    },
    cashierToken,
  );
  await req(
    'POST',
    '/orders',
    { items: [{ productId: item.id, quantity: 2 }], paymentMethod: 'card' },
    cashierToken,
  );

  const closed = await req('POST', '/cash/close', { countedUsd: 0 }, adminToken);
  const summary = (await req('GET', `/cash/sessions/${closed.json.session.id}`, null, adminToken)).json;

  const methods = summary.sales.map((s) => s.payment_method).sort();
  assert.deepEqual(methods, ['card', 'cash']);
  assert.ok(summary.salesTotal > 0);
  assert.ok(summary.byKind.some((k) => k.kind === 'sale'));
});

test('a customer settling their account fills the drawer', async () => {
  await req('POST', '/cash/open', { openingUsd: 0 }, adminToken);
  const customer = (
    await req('POST', '/customers', { name: 'Pays In Cash', credit_limit: 500 }, adminToken)
  ).json.party;
  await req('POST', `/customers/${customer.id}/charges`, { amount: 40, note: 'Old balance' }, adminToken);

  await req(
    'POST',
    `/customers/${customer.id}/payments`,
    { payments: [{ currency: 'USD', amount: 40 }] },
    adminToken,
  );

  assert.equal((await req('GET', '/cash/current', null, adminToken)).json.expected.usd, 40);
});

test('paying a supplier from the till empties it', async () => {
  await req('POST', '/cash/open', { openingUsd: 300 }, adminToken);
  const supplier = (await req('POST', '/suppliers', { name: 'Paid From Till' }, adminToken)).json.party;
  await req('POST', `/suppliers/${supplier.id}/charges`, { amount: 120, note: 'Delivery' }, adminToken);

  await req(
    'POST',
    `/suppliers/${supplier.id}/payments`,
    { payments: [{ currency: 'USD', amount: 120 }] },
    adminToken,
  );

  assert.equal((await req('GET', '/cash/current', null, adminToken)).json.expected.usd, 180);
});

test('a payment that never touched the till is left out of it', async () => {
  await req('POST', '/cash/open', { openingUsd: 300 }, adminToken);
  const supplier = (await req('POST', '/suppliers', { name: 'Paid By Transfer' }, adminToken)).json.party;
  await req('POST', `/suppliers/${supplier.id}/charges`, { amount: 90 }, adminToken);

  await req(
    'POST',
    `/suppliers/${supplier.id}/payments`,
    { payments: [{ currency: 'USD', amount: 90 }], inCash: false },
    adminToken,
  );

  assert.equal((await req('GET', '/cash/current', null, adminToken)).json.expected.usd, 300);
});

test('a purchase invoice paid in cash comes out of the drawer', async () => {
  await req('POST', '/cash/open', { openingUsd: 500 }, adminToken);
  const supplier = (await req('POST', '/suppliers', { name: 'Cash Delivery' }, adminToken)).json.party;
  const item = await product('SNK-001');

  const doc = (
    await req(
      'POST',
      '/documents',
      {
        docType: 'purchase_invoice',
        partyId: supplier.id,
        items: [{ productId: item.id, quantity: 5, price: 2 }],
        payments: [{ currency: 'USD', amount: 10.8 }],
        paymentMethod: 'cash',
      },
      adminToken,
    )
  ).json.document;

  // Nothing leaves the drawer until the document is real.
  assert.equal((await req('GET', '/cash/current', null, adminToken)).json.expected.usd, 500);

  await req('POST', `/documents/${doc.id}/confirm`, null, adminToken);
  assert.equal((await req('GET', '/cash/current', null, adminToken)).json.expected.usd, 489.2);
});

test('deleting a cash-paid document keeps the money it moved on the record', async () => {
  await req('POST', '/cash/open', { openingUsd: 500 }, adminToken);
  const supplier = (await req('POST', '/suppliers', { name: 'Then Deleted' }, adminToken)).json.party;
  const item = await product('SNK-001');

  const doc = (
    await req(
      'POST',
      '/documents',
      {
        docType: 'purchase_invoice',
        partyId: supplier.id,
        items: [{ productId: item.id, quantity: 2, price: 5 }],
        payments: [{ currency: 'USD', amount: 10.8 }],
        paymentMethod: 'cash',
      },
      adminToken,
    )
  ).json.document;
  await req('POST', `/documents/${doc.id}/confirm`, null, adminToken);
  assert.equal((await req('GET', '/cash/current', null, adminToken)).json.expected.usd, 489.2);

  // The document can go; the drawer's history of it cannot.
  const deleted = await req('DELETE', `/documents/${doc.id}`, null, adminToken);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  assert.equal(
    (await req('GET', '/cash/current', null, adminToken)).json.expected.usd,
    500,
    'the cash comes back with the document',
  );

  const { movements } = (await req('GET', '/cash/current', null, adminToken)).json;
  const forDoc = movements.filter((m) => (m.note || '').includes(doc.doc_number));
  assert.equal(forDoc.length, 2, 'both the payment and its reversal are still listed');
});

test('sessions are listed with what each one was out by', async () => {
  await req('POST', '/cash/open', { openingUsd: 100 }, adminToken);
  await req('POST', '/cash/close', { countedUsd: 99 }, adminToken);

  const { sessions } = (await req('GET', '/cash/sessions', null, adminToken)).json;
  assert.ok(sessions.length > 0);
  assert.equal(sessions[0].over_short_usd, -1);
  assert.ok(sessions[0].opened_by_name);
});

test('cashiers cannot read the shift history', async () => {
  assert.equal((await req('GET', '/cash/sessions', null, cashierToken)).status, 403);
});

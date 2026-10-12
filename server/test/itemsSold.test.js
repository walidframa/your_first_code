/**
 * Every line sold, with its cost and the minute it went out.
 *
 * The register's own report: one row per line, across receipts and sales
 * invoices, with the cost for whoever may see it and without it for whoever
 * may not. A refunded sale stays on the list and counts for nothing.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4704;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let cashierToken;

async function req(method, route, body, token = adminToken) {
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
    /* no body */
  }
  return { status: res.status, json };
}

let widget;
let phone;
let customer;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-items-sold-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'items-sold-secret-long-enough-for-the-production-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
    REQUIRE_CASH_SESSION: 'false',
  };
  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);
  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' }, null)).json.token;
  cashierToken = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' }, null)).json.token;
  await req('PUT', '/settings', { tax_enabled: 'false' });

  widget = (await req('POST', '/products', { name: 'Charger', sku: 'IS-CHG', price: 10, cost: 4, stock: 20 })).json.product;
  phone = (
    await req('POST', '/products', { name: 'Galaxy A15', sku: 'IS-A15', price: 150, cost: 110, tracks_units: true })
  ).json.product;
  await req('POST', `/units/product/${phone.id}`, { units: [{ imei: '358800111199001', cost: 112 }] });
  customer = (await req('POST', '/customers', { name: 'Report Reader', credit_limit: 5000 })).json.party;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

let order;
let invoice;

test('what the register and the invoices sold is one list, newest first, with the handset on it', async () => {
  const unit = (await req('GET', `/units/product/${phone.id}?status=in_stock`)).json.units[0];
  const sale = await req(
    'POST',
    '/orders',
    {
      items: [
        { productId: widget.id, quantity: 2 },
        { productId: phone.id, quantity: 1, unitId: unit.id },
      ],
      paymentMethod: 'card',
    },
    cashierToken,
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  order = sale.json.order;

  const drafted = await req('POST', '/documents', {
    docType: 'sales_invoice',
    partyId: customer.id,
    items: [{ productId: widget.id, quantity: 3, price: 9 }],
  });
  assert.equal(drafted.status, 201, JSON.stringify(drafted.json));
  invoice = drafted.json.document;
  assert.equal((await req('POST', `/documents/${invoice.id}/confirm`)).status, 200);

  const res = await req('GET', '/reports/items-sold');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const { rows, totals, seesCost } = res.json;
  assert.equal(seesCost, true, 'the owner sees cost');

  const chargers = rows.filter((r) => r.name === 'Charger');
  assert.equal(chargers.length, 2, 'the receipt line and the invoice line');
  const onReceipt = chargers.find((r) => r.source === 'receipt');
  const onInvoice = chargers.find((r) => r.source === 'invoice');
  assert.equal(onReceipt.number, order.order_number);
  assert.equal(onReceipt.sold_by, 'Front Register');
  assert.equal(onReceipt.quantity, 2);
  assert.equal(onReceipt.cost, 4);
  assert.equal(onReceipt.cost_total, 8);
  assert.equal(onReceipt.profit, 12, '2 × 10 sold, 2 × 4 cost');
  assert.match(String(onReceipt.at), /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/, 'to the second');
  assert.equal(onInvoice.number, invoice.doc_number);
  assert.equal(onInvoice.customer_name, 'Report Reader');
  assert.equal(onInvoice.net_total, 27);

  const handset = rows.find((r) => r.name === 'Galaxy A15');
  assert.equal(handset.imei, '358800111199001');
  assert.equal(handset.unit_kind, 'imei');
  assert.equal(handset.cost, 112, 'the handset that left, not the shelf figure');

  // Newest first across both sources.
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(String(rows[i - 1].at) >= String(rows[i].at), 'rows are newest first');
  }

  assert.equal(totals.quantity, 6);
  assert.equal(totals.sold, 20 + 150 + 27);
  assert.equal(totals.cost, 8 + 112 + 12);
  assert.equal(totals.profit, totals.sold - totals.cost);
});

test('a cashier gets the list without the cost on it', async () => {
  const res = await req('GET', '/reports/items-sold', null, cashierToken);
  assert.equal(res.status, 200);
  assert.equal(res.json.seesCost, false);
  for (const r of res.json.rows) {
    assert.ok(!('cost' in r) && !('cost_total' in r) && !('profit' in r), 'cost left out, not zeroed');
  }
  assert.ok(!('cost' in res.json.totals));
  assert.ok(!('profit' in res.json.totals));
  assert.equal(res.json.totals.sold, 197, 'what it came to is still there');
});

test('the period narrows it, and a day with nothing is an empty list', async () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const twoAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const quiet = await req('GET', `/reports/items-sold?from=${twoAgo}&to=${yesterday}`);
  assert.equal(quiet.status, 200);
  assert.equal(quiet.json.rows.length, 0);
  assert.equal(quiet.json.totals.sold, 0);
});

test('a refunded sale stays on the list and counts for nothing', async () => {
  assert.equal((await req('POST', `/orders/${order.id}/refund`)).status, 200);
  const res = await req('GET', '/reports/items-sold');
  const onReceipt = res.json.rows.find((r) => r.name === 'Charger' && r.source === 'receipt');
  assert.equal(onReceipt.status, 'refunded');
  assert.equal(onReceipt.net_quantity, 0);
  assert.equal(onReceipt.net_total, 0);
  assert.equal(onReceipt.profit, 0);
  assert.equal(res.json.totals.sold, 27, 'only the invoice counts now');
  assert.equal(res.json.totals.quantity, 3);
});

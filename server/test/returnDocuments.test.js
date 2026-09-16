/**
 * Goods going back, on paper.
 *
 * A sales return is a customer bringing back what an invoice sold them; a
 * purchase return is the shop sending back what a delivery brought in. Both
 * are the invoice run backwards — stock the other way, the account the other
 * way, the money the other way — and both are raised against the invoice they
 * undo, capped at what it carried.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4696;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;

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
    /* Some responses carry no body. */
  }
  return { status: res.status, json };
}

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const stockOf = async (id) => (await req('GET', `/products/${id}`)).json.product.stock;
const balanceOf = async (type, id) =>
  (await req('GET', '/accounts/registry')).json.registry[type].find((p) => p.id === id).balance;
const mainCashUsd = async () =>
  (await req('GET', '/accounts/registry')).json.registry.cash.find((a) => a.name === 'Main cash')?.balance ?? 0;

async function draft(docType, partyId, items, extra = {}) {
  const res = await req('POST', '/documents', { docType, partyId, items, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.document;
}
async function confirm(id, body = null) {
  const res = await req('POST', `/documents/${id}/confirm`, body);
  return res;
}

let customer;
let supplier;
let widget;
let gadget;
let phone;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-returns-doc-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'return-docs-secret-long-enough-for-the-production-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
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

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  await req('PUT', '/settings', { tax_enabled: 'false' });
  customer = (await req('POST', '/customers', { name: 'Rami Haddad', credit_limit: 5000 })).json.party;
  supplier = (await req('POST', '/suppliers', { name: 'Beirut Wholesale' })).json.party;
  widget = (await req('POST', '/products', { name: 'Widget', sku: 'RT-W', price: 10, cost: 6, stock: 20 })).json.product;
  gadget = (await req('POST', '/products', { name: 'Gadget', sku: 'RT-G', price: 25, cost: 15, stock: 20 })).json.product;
  phone = (
    await req('POST', '/products', { name: 'Handset', sku: 'RT-P', price: 300, cost: 200, tracks_units: true })
  ).json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------- the kinds */

test('the two returns are document types like any other', async () => {
  const { types } = (await req('GET', '/documents/types')).json;
  const sr = types.find((t) => t.key === 'sales_return');
  const pr = types.find((t) => t.key === 'purchase_return');
  assert.ok(sr && pr, 'both are offered');
  assert.equal(sr.party, 'customer');
  assert.equal(pr.party, 'supplier');
  assert.ok(sr.movesStock && pr.movesStock);
  assert.ok(types.find((t) => t.key === 'sales_invoice').convertsTo.includes('sales_return'));
  assert.ok(types.find((t) => t.key === 'purchase_invoice').convertsTo.includes('purchase_return'));
});

/* ------------------------------------------------------------ sales return */

let invoice;

test('a sales return brings the goods back and takes the money off the customer’s account', async () => {
  invoice = await draft('sales_invoice', customer.id, [
    { productId: widget.id, quantity: 5, price: 10 },
    { productId: gadget.id, quantity: 2, price: 25 },
  ]);
  assert.equal((await confirm(invoice.id)).status, 200);
  assert.equal(await stockOf(widget.id), 15);
  assert.equal(await balanceOf('customer', customer.id), 100, 'the invoice is on the account');

  // Raised against the invoice, and starting from its lines.
  const raised = await req('POST', `/documents/${invoice.id}/convert`, { docType: 'sales_return' });
  assert.equal(raised.status, 201, JSON.stringify(raised.json));
  const ret = raised.json.document;
  assert.equal(ret.doc_type, 'sales_return');
  assert.match(ret.doc_number, /^SR-\d{4}$/);
  assert.equal(ret.converted_from_id, invoice.id);
  assert.equal(raised.json.items.length, 2, 'the invoice’s lines, to be trimmed to what came back');

  // Two widgets came back, nothing else.
  const trimmed = await req('PUT', `/documents/${ret.id}`, {
    items: [{ productId: widget.id, quantity: 2, price: 10 }],
  });
  assert.equal(trimmed.status, 200, JSON.stringify(trimmed.json));
  assert.equal(trimmed.json.document.total, 20);

  const done = await confirm(ret.id);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(await stockOf(widget.id), 17, 'two are back on the shelf');
  assert.equal(await balanceOf('customer', customer.id), 80, 'and $20 is off what they owe');

  const { lines } = (await req('GET', `/customers/${customer.id}/statement`)).json;
  assert.ok(
    lines.some((l) => l.kind === 'refund' && round(l.credit) === 20),
    `a $20 credit is on the statement: ${JSON.stringify(lines.slice(0, 3))}`,
  );
});

test('more than went out on the invoice is refused, counting what already came back', async () => {
  const again = (await req('POST', `/documents/${invoice.id}/convert`, { docType: 'sales_return' })).json.document;
  await req('PUT', `/documents/${again.id}`, { items: [{ productId: widget.id, quantity: 4, price: 10 }] });
  const refused = await confirm(again.id);
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /only had 5 × Widget, and 2 already came back/);

  const notOnIt = (await req('POST', `/documents/${invoice.id}/convert`, { docType: 'sales_return' })).json
    .document;
  const other = (await req('POST', '/products', { name: 'Other thing', sku: 'RT-O', price: 3, cost: 1, stock: 5 }))
    .json.product;
  await req('PUT', `/documents/${notOnIt.id}`, { items: [{ productId: other.id, quantity: 1, price: 3 }] });
  const wrong = await confirm(notOnIt.id);
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /was not on/);
});

test('a return refunded in cash pays the customer out of the main cash', async () => {
  const cashBefore = await mainCashUsd();
  const balanceBefore = await balanceOf('customer', customer.id);

  const ret = await draft(
    'sales_return',
    customer.id,
    [{ productId: gadget.id, quantity: 1, price: 25 }],
    { payments: [{ currency: 'USD', amount: 25 }], paymentMethod: 'cash' },
  );
  assert.equal((await confirm(ret.id)).status, 200);

  assert.equal(await mainCashUsd(), round(cashBefore - 25), 'the money left the main cash');
  assert.equal(await balanceOf('customer', customer.id), balanceBefore, 'refunded in full, so the account is unchanged');

  const { vouchers } = (await req('GET', `/vouchers?search=${ret.doc_number}`)).json;
  assert.equal(vouchers.length, 1, 'one slip, to be signed by the customer');
  assert.equal(vouchers[0].kind, 'payment', 'money going out');
  assert.equal(vouchers[0].to_name, 'Rami Haddad');
});

test('cancelling a confirmed return puts everything back the way it was', async () => {
  const stockBefore = await stockOf(widget.id);
  const balanceBefore = await balanceOf('customer', customer.id);
  const ret = await draft('sales_return', customer.id, [{ productId: widget.id, quantity: 1, price: 10 }]);
  await confirm(ret.id);
  assert.equal(await stockOf(widget.id), stockBefore + 1);
  assert.equal(await balanceOf('customer', customer.id), balanceBefore - 10);

  const cancelled = await req('POST', `/documents/${ret.id}/cancel`);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.equal(await stockOf(widget.id), stockBefore, 'the goods left again');
  assert.equal(await balanceOf('customer', customer.id), balanceBefore, 'and the credit is gone');
});

/* --------------------------------------------------------- purchase return */

test('a purchase return sends goods back and takes them off what the shop owes', async () => {
  const delivery = await draft('purchase_invoice', supplier.id, [{ productId: widget.id, quantity: 10, price: 6 }]);
  assert.equal((await confirm(delivery.id)).status, 200);
  const stockAfter = await stockOf(widget.id);
  assert.equal(await balanceOf('supplier', supplier.id), 60, 'the shop owes the supplier');

  const raised = await req('POST', `/documents/${delivery.id}/convert`, { docType: 'purchase_return' });
  assert.equal(raised.status, 201, JSON.stringify(raised.json));
  const ret = raised.json.document;
  assert.match(ret.doc_number, /^PR-\d{4}$/);
  await req('PUT', `/documents/${ret.id}`, { items: [{ productId: widget.id, quantity: 3, price: 6 }] });

  const done = await confirm(ret.id);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(await stockOf(widget.id), stockAfter - 3, 'three left the shelf');
  assert.equal(await balanceOf('supplier', supplier.id), 42, 'and $18 is off what is owed');
});

test('a supplier refunding in cash puts the money into the main cash', async () => {
  const cashBefore = await mainCashUsd();
  const ret = await draft(
    'purchase_return',
    supplier.id,
    [{ productId: widget.id, quantity: 1, price: 6 }],
    { payments: [{ currency: 'USD', amount: 6 }], paymentMethod: 'cash' },
  );
  assert.equal((await confirm(ret.id)).status, 200);
  assert.equal(await mainCashUsd(), round(cashBefore + 6));
  const { vouchers } = (await req('GET', `/vouchers?search=${ret.doc_number}`)).json;
  assert.equal(vouchers[0].kind, 'receipt', 'money coming in');
});

test('a delivery cannot be deleted while a return stands against it, and a draft cannot be returned against', async () => {
  const delivery = await draft('purchase_invoice', supplier.id, [{ productId: gadget.id, quantity: 2, price: 15 }]);
  const early = await req('POST', `/documents/${delivery.id}/convert`, { docType: 'purchase_return' });
  assert.equal(early.status, 400);
  assert.match(early.json.error, /confirmed before/);

  await confirm(delivery.id);
  const ret = (await req('POST', `/documents/${delivery.id}/convert`, { docType: 'purchase_return' })).json.document;
  await req('PUT', `/documents/${ret.id}`, { items: [{ productId: gadget.id, quantity: 1, price: 15 }] });
  await confirm(ret.id);

  const blocked = await req('DELETE', `/documents/${delivery.id}`);
  assert.equal(blocked.status, 400);
  assert.match(blocked.json.error, new RegExp(ret.doc_number));

  // And a second return against the same delivery is allowed — the first did
  // not "use it up".
  const second = await req('POST', `/documents/${delivery.id}/convert`, { docType: 'purchase_return' });
  assert.equal(second.status, 201, JSON.stringify(second.json));
});

/* ------------------------------------------------------------- the edges */

test('handsets go back to the supplier by IMEI, and come back if the return is cancelled', async () => {
  const delivery = await draft('purchase_invoice', supplier.id, [
    { productId: phone.id, quantity: 2, price: 200, imeis: '358800111100001\n358800111100002' },
  ]);
  assert.equal((await confirm(delivery.id)).status, 200);
  const shelf = await stockOf(phone.id);
  const owed = await balanceOf('supplier', supplier.id);

  const ret = (await req('POST', `/documents/${delivery.id}/convert`, { docType: 'purchase_return' })).json.document;
  const drafted = (await req('GET', `/documents/${ret.id}`)).json;
  assert.match(drafted.items[0].imeis || '', /358800111100001/, 'the draft starts from the handsets that came in');

  // Without naming the handset, the line is refused — by count, not by kind.
  await req('PUT', `/documents/${ret.id}`, { items: [{ productId: phone.id, quantity: 1, price: 200 }] });
  const vague = await confirm(ret.id);
  assert.equal(vague.status, 400);
  assert.match(vague.json.error, /1 on the line but 0 IMEIs/);

  await req('PUT', `/documents/${ret.id}`, {
    items: [{ productId: phone.id, quantity: 1, price: 200, imeis: '358800111100002' }],
  });
  const done = await confirm(ret.id);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(await stockOf(phone.id), shelf - 1, 'one handset left the shelf');
  assert.equal(await balanceOf('supplier', supplier.id), round(owed - 200), 'and its price is off what is owed');

  const gone = (await req('GET', '/units/lookup?imei=358800111100002')).json;
  assert.equal(gone.unit.status, 'sent_back');
  assert.equal(gone.available, false, 'it cannot be sold');
  const kept = (await req('GET', '/units/lookup?imei=358800111100001')).json;
  assert.equal(kept.available, true, 'its box-mate is still for sale');

  // The same phone cannot go back twice.
  const again = (await req('POST', `/documents/${delivery.id}/convert`, { docType: 'purchase_return' })).json.document;
  await req('PUT', `/documents/${again.id}`, {
    items: [{ productId: phone.id, quantity: 1, price: 200, imeis: '358800111100002' }],
  });
  const twice = await confirm(again.id);
  assert.equal(twice.status, 400);
  assert.match(twice.json.error, /already sent back/);

  const cancelled = await req('POST', `/documents/${ret.id}/cancel`);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.equal(await stockOf(phone.id), shelf, 'back on the shelf');
  assert.equal((await req('GET', '/units/lookup?imei=358800111100002')).json.unit.status, 'in_stock');
});

test('a handset that moved between branches can still go back; one on the road cannot', async () => {
  const at = (branch) => async (method, route, body) => {
    const res = await fetch(BASE + route, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Branch-Id': String(branch) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const main = (await req('GET', '/branches')).json.branches.find((b) => b.is_main);
  const saida = (await req('POST', '/branches', { name: 'Saida', code: 'SAI' })).json.branch;

  const delivery = await draft('purchase_invoice', supplier.id, [
    { productId: phone.id, quantity: 2, price: 200, imeis: '358800111100011\n358800111100012' },
  ]);
  assert.equal((await confirm(delivery.id)).status, 200);
  const moved = (await req('GET', '/units/lookup?imei=358800111100011')).json.unit;
  const stuck = (await req('GET', '/units/lookup?imei=358800111100012')).json.unit;

  // One phone goes to Saida and is received there; the other is sent and never arrives.
  const t1 = await at(main.id)('POST', '/stock-transfers', { toBranchId: saida.id, items: [{ productId: phone.id, unitId: moved.id }] });
  assert.equal(t1.status, 201, JSON.stringify(t1.json));
  const received = await at(saida.id)('POST', `/stock-transfers/${t1.json.transfer.id}/receive`);
  assert.equal(received.status, 200, JSON.stringify(received.json));
  const t2 = await at(main.id)('POST', '/stock-transfers', { toBranchId: saida.id, items: [{ productId: phone.id, unitId: stuck.id }] });
  assert.equal(t2.status, 201, JSON.stringify(t2.json));

  const ret = (await at(saida.id)('POST', '/documents', {
    docType: 'purchase_return',
    partyId: supplier.id,
    items: [{ productId: phone.id, quantity: 1, price: 200, imeis: '358800111100011' }],
  })).json.document;
  const done = await at(saida.id)('POST', `/documents/${ret.id}/confirm`);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal((await req('GET', '/units/lookup?imei=358800111100011')).json.unit.status, 'sent_back');

  const onRoad = (await at(main.id)('POST', '/documents', {
    docType: 'purchase_return',
    partyId: supplier.id,
    items: [{ productId: phone.id, quantity: 1, price: 200, imeis: '358800111100012' }],
  })).json.document;
  const refused = await at(main.id)('POST', `/documents/${onRoad.id}/confirm`);
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /still on its way/);
});

test('a handset is not returned on paper', async () => {
  const ret = await draft('sales_return', customer.id, [{ productId: phone.id, quantity: 1, price: 300 }]);
  const refused = await confirm(ret.id);
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /tracked by IMEI/);
  assert.match(refused.json.error, /Sales screen/);
});

test('a sales return comes off the profit, and the days still add up', async () => {
  const before = (await req('GET', '/expenses/profit?branch=all')).json;
  const ret = await draft('sales_return', customer.id, [{ productId: gadget.id, quantity: 1, price: 25 }]);
  await confirm(ret.id);
  const after = (await req('GET', '/expenses/profit?branch=all')).json;

  assert.equal(round(before.revenue - after.revenue), 25, 'the takings are lower by what came back');
  assert.equal(round(before.cost - after.cost), 15, 'and the cost of it is back on the shelf');
  assert.ok(after.invoices.returns > before.invoices.returns, 'and it is counted as a return');
  const days = after.byDay.reduce((n, d) => round(n + d.revenue), 0);
  assert.equal(days, after.revenue);
  const dayCost = after.byDay.reduce((n, d) => round(n + d.cost), 0);
  assert.equal(dayCost, after.cost);
});

test('a product’s history shows what came back and what went back', async () => {
  const { activity } = (await req('GET', `/products/${widget.id}/activity`)).json;
  const back = activity.find((a) => a.kind === 'refund' && /^SR-/.test(a.reference));
  const sent = activity.find((a) => a.kind === 'returned' && /^PR-/.test(a.reference));
  assert.ok(back, 'a sales return is on it');
  assert.ok(back.quantity > 0, 'as stock coming in');
  assert.ok(sent, 'a purchase return is on it');
  assert.ok(sent.quantity < 0, 'as stock going out');
});

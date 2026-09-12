/**
 * What an invoice cost or charged beyond its lines.
 *
 * Shipping, customs, a commission. On a delivery they are part of what the
 * goods cost to put on the shelf, whoever was paid — so they land in the unit
 * cost. On a sale they are either charged to the customer, in the total, or
 * paid by the shop, an expense. Either way they are on the paper that caused
 * them rather than remembered afterwards.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4697;
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
const productOf = async (id) => (await req('GET', `/products/${id}`)).json.product;
const balanceOf = async (type, id) =>
  (await req('GET', '/accounts/registry')).json.registry[type].find((p) => p.id === id).balance;
const mainCashUsd = async () =>
  (await req('GET', '/accounts/registry')).json.registry.cash.find((a) => a.name === 'Main cash')?.balance ?? 0;
const expenses = async () => (await req('GET', '/expenses')).json.expenses;

let customer;
let supplier;
let phone;
let cover;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-charges-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'charges-secret-long-enough-for-the-production-guard',
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
  customer = (await req('POST', '/customers', { name: 'Nour Saad', credit_limit: 5000 })).json.party;
  supplier = (await req('POST', '/suppliers', { name: 'Dubai Imports' })).json.party;
  phone = (await req('POST', '/products', { name: 'Phone X', sku: 'CH-P', price: 300, cost: 0, stock: 0 })).json.product;
  cover = (await req('POST', '/products', { name: 'Cover', sku: 'CH-C', price: 5, cost: 0, stock: 0 })).json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------- purchase invoice */

test('freight on the supplier’s invoice is owed to the supplier and lands in the unit cost', async () => {
  // $900 of phones and $100 of covers, with $100 of shipping on the same bill.
  const made = await req('POST', '/documents', {
    docType: 'purchase_invoice',
    partyId: supplier.id,
    items: [
      { productId: phone.id, quantity: 9, price: 100 },
      { productId: cover.id, quantity: 50, price: 2 },
    ],
    charges: [{ kind: 'shipping', amount: 100 }],
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const doc = made.json.document;
  assert.equal(doc.subtotal, 1000);
  assert.equal(doc.charges, 100, 'the billed charges, summed');
  assert.equal(doc.total, 1100, 'and in the total');
  assert.equal(made.json.charges.length, 1);

  assert.equal((await req('POST', `/documents/${doc.id}/confirm`)).status, 200);
  assert.equal(await balanceOf('supplier', supplier.id), 1100, 'the freight is owed with the goods');

  // $90 of the freight on the phones, $10 on the covers — by value.
  assert.equal((await productOf(phone.id)).cost, 110, 'each phone cost $10 more to land');
  assert.equal((await productOf(cover.id)).cost, 2.2, 'each cover twenty cents more');

  const { items } = (await req('GET', `/documents/${doc.id}`)).json;
  assert.equal(items.find((i) => i.product_id === phone.id).cost, 110, 'written on the line');
  assert.equal(items.find((i) => i.product_id === phone.id).price, 100, 'the price is still what the supplier wrote');

  // And the costing reads the landed figure.
  const costed = (await req('GET', `/products/${phone.id}`)).json.product;
  assert.equal(costed.average_cost ?? costed.cost, 110);
});

test('a commission paid to somebody else is an expense of the shop’s, and still lands in the cost', async () => {
  const cashBefore = await mainCashUsd();
  const spentBefore = (await expenses()).length;

  const made = await req('POST', '/documents', {
    docType: 'purchase_invoice',
    partyId: supplier.id,
    items: [{ productId: phone.id, quantity: 10, price: 100 }],
    charges: [{ kind: 'commission', amount: 50, billed: false, paidWith: 'cash', payee: 'Abu Ali the agent' }],
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const doc = made.json.document;
  assert.equal(doc.total, 1000, 'not on the supplier’s invoice');
  const owedBefore = await balanceOf('supplier', supplier.id);

  assert.equal((await req('POST', `/documents/${doc.id}/confirm`)).status, 200);
  assert.equal(await balanceOf('supplier', supplier.id), owedBefore + 1000, 'the supplier is owed the goods only');
  assert.equal(await mainCashUsd(), round(cashBefore - 50), 'the agent was paid from the main cash');

  const spent = await expenses();
  assert.equal(spent.length, spentBefore + 1, 'one expense, written by the confirm');
  const fee = spent.find((e) => /Commission on PI-/.test(e.note));
  assert.ok(fee, JSON.stringify(spent.slice(0, 2)));
  assert.equal(fee.category, 'fees');
  assert.equal(fee.amount_usd, 50);
  assert.match(fee.note, /Abu Ali/);

  assert.equal((await productOf(phone.id)).cost, 105, '$5 of commission on each phone');

  // Reversed, the expense goes with it — and comes back once on re-confirm, not twice.
  assert.equal((await req('POST', `/documents/${doc.id}/cancel`)).status, 200);
  assert.equal((await expenses()).length, spentBefore, 'the expense is gone');
  assert.equal(await mainCashUsd(), cashBefore, 'and the money is back');
});

test('editing a confirmed delivery’s charges replaces the expense rather than adding another', async () => {
  const spentBefore = (await expenses()).length;
  const made = await req('POST', '/documents', {
    docType: 'purchase_invoice',
    partyId: supplier.id,
    items: [{ productId: cover.id, quantity: 10, price: 2 }],
    charges: [{ kind: 'customs', amount: 10, billed: false, paidWith: 'bank' }],
  });
  const doc = made.json.document;
  await req('POST', `/documents/${doc.id}/confirm`);
  assert.equal((await expenses()).length, spentBefore + 1);

  const edited = await req('PUT', `/documents/${doc.id}`, {
    items: [{ productId: cover.id, quantity: 10, price: 2 }],
    charges: [{ kind: 'customs', amount: 14, billed: false, paidWith: 'bank' }],
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  const after = await expenses();
  assert.equal(after.length, spentBefore + 1, 'still one expense');
  assert.equal(after.find((e) => /Customs on/.test(e.note)).amount_usd, 14, 'at the new figure');
  assert.equal((await productOf(cover.id)).cost, 3.4, 'and the landed cost followed: $2 + $14/10');

  // Charges left unsaid on an edit are kept, like the payment.
  const kept = await req('PUT', `/documents/${doc.id}`, { notes: 'just a note' });
  assert.equal(kept.status, 200);
  assert.equal(kept.json.charges.length, 1);
  assert.equal(kept.json.charges[0].amount_usd, 14);
});

/* ---------------------------------------------------------- sales invoice */

test('delivery charged to the customer is in the total; a courier the shop pays is an expense', async () => {
  const cashBefore = await mainCashUsd();
  const made = await req('POST', '/documents', {
    docType: 'sales_invoice',
    partyId: customer.id,
    items: [{ productId: phone.id, quantity: 1, price: 300 }],
    charges: [
      { kind: 'shipping', label: 'Delivery to Tripoli', amount: 8 },
      { kind: 'commission', amount: 15, billed: false, paidWith: 'cash', payee: 'Sales agent' },
    ],
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const doc = made.json.document;
  assert.equal(doc.total, 308, 'the customer pays for the delivery, not the agent');

  const before = (await req('GET', '/expenses/profit?branch=all')).json;
  assert.equal((await req('POST', `/documents/${doc.id}/confirm`)).status, 200);
  assert.equal(await balanceOf('customer', customer.id), 308);
  assert.equal(await mainCashUsd(), round(cashBefore - 15), 'the agent was paid');

  const after = (await req('GET', '/expenses/profit?branch=all')).json;
  assert.equal(round(after.revenue - before.revenue), 308, 'the delivery charge is takings');
  assert.equal(round(after.expenses.total - before.expenses.total), 15, 'the commission is spending');

  // The customer's message names what they were charged, not what the shop paid.
  const wa = (await req('GET', `/documents/${doc.id}/whatsapp`)).json;
  assert.match(wa.text, /Delivery to Tripoli: \$8\.00/);
  assert.doesNotMatch(wa.text, /Commission/);
});

test('a return raised against an invoice with freight on it starts without the freight', async () => {
  const made = await req('POST', '/documents', {
    docType: 'sales_invoice',
    partyId: customer.id,
    items: [{ productId: cover.id, quantity: 2, price: 5 }],
    charges: [{ kind: 'shipping', amount: 3 }],
  });
  const doc = made.json.document;
  assert.equal(doc.total, 13);
  await req('POST', `/documents/${doc.id}/confirm`);

  const ret = (await req('POST', `/documents/${doc.id}/convert`, { docType: 'sales_return' })).json.document;
  assert.equal(ret.total, 10, 'the goods, not the courier');
  assert.equal(ret.charges, 0);

  const refused = await req('POST', '/documents', {
    docType: 'sales_return',
    partyId: customer.id,
    items: [{ productId: cover.id, quantity: 1, price: 5 }],
    charges: [{ kind: 'shipping', amount: 3 }],
  });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /no extra charges/);
});

test('a charge of nothing is refused, and an unknown kind is just “other”', async () => {
  const nothing = await req('POST', '/documents', {
    docType: 'purchase_invoice',
    partyId: supplier.id,
    items: [{ productId: cover.id, quantity: 1, price: 2 }],
    charges: [{ kind: 'shipping', amount: 0 }],
  });
  assert.equal(nothing.status, 400);
  assert.match(nothing.json.error, /more than nothing/);

  const odd = await req('POST', '/documents', {
    docType: 'purchase_invoice',
    partyId: supplier.id,
    items: [{ productId: cover.id, quantity: 1, price: 2 }],
    charges: [{ kind: 'bribe', amount: 1 }],
  });
  assert.equal(odd.status, 201);
  assert.equal(odd.json.charges[0].kind, 'other');
  assert.equal(odd.json.charges[0].label, 'Other cost');
});

/**
 * Sending a receipt, an invoice or a repair ticket to the customer's WhatsApp.
 *
 * Two things carry the weight here. The number has to survive being written the
 * way a Lebanese shop actually writes it — 03 123 456 is not a number WhatsApp
 * will accept, and the failure is silent — and the message has to contain what
 * the customer needs and nothing they were promised would stay behind the
 * counter. The passcode test is the important one in this file.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waNumber, waLink } from '../src/lib/whatsapp.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4607;
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

/** What the shop's WhatsApp message would say, decoded back out of the link. */
function textOf(payload) {
  return decodeURIComponent(new URL(payload.url).searchParams.get('text'));
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-whatsapp-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'whatsapp.sqlite'),
    JWT_SECRET: 'whatsapp-test-secret-long-enough-for-the-guard',
    ACCOUNT_SECRET: 'whatsapp-test-account-secret-long-enough-here',
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

  await req('PUT', '/settings', { company_name: 'Rami Mobile', company_phone: '03 123 456' }, adminToken);
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ number */

test('a number written the way a shop writes it reaches the right phone', async () => {
  // Every one of these is the same Lebanese mobile.
  for (const written of ['03 123 456', '03/123456', '03-123-456', '+961 3 123 456', '00961 3 123456']) {
    assert.equal(waNumber(written), '9613123456', `${written} should normalise`);
  }
});

test('the trunk zero is dropped, not kept', async () => {
  // Kept, it produces a number that looks plausible and reaches nobody.
  assert.equal(waNumber('03123456'), '9613123456');
  assert.ok(!waNumber('03123456').includes('9610'));
});

test('a foreign number keeps its own country code', async () => {
  assert.equal(waNumber('+33 6 12 34 56 78'), '33612345678');
});

test('the dialling code is a setting, so a shop outside Lebanon can send too', async () => {
  assert.equal(waNumber('050 123 4567', '971'), '971501234567');
});

test('nothing that is not a phone number becomes one', async () => {
  for (const junk of ['', '   ', 'call me', '12', null, undefined]) {
    assert.equal(waNumber(junk), null, `${JSON.stringify(junk)} is not a number`);
  }
});

test('a link without a number still opens WhatsApp, and asks who to send to', async () => {
  const url = new URL(waLink(null, 'hello'));
  assert.equal(url.pathname, '/');
  assert.equal(url.searchParams.get('text'), 'hello');
});

test('the message survives the characters a receipt is full of', async () => {
  const url = new URL(waLink('9613123456', '2× cable — $3.00 & 267,000 LL'));
  assert.equal(url.searchParams.get('text'), '2× cable — $3.00 & 267,000 LL');
});

/* ----------------------------------------------------------------- receipt */

test('a sale can be sent to the customer who made it', async () => {
  const customer = (
    await req('POST', '/customers', { name: 'Ali Hassan', phone: '03 555 111' }, adminToken)
  ).json.party;

  const product = (
    await req(
      'POST',
      '/products',
      { name: 'Braided cable', sku: 'WA-CABLE-1', price: 3, cost: 1, stock: 10 },
      adminToken,
    )
  ).json.product;

  const order = (
    await req(
      'POST',
      '/orders',
      {
        items: [{ productId: product.id, quantity: 2 }],
        paymentMethod: 'card',
        customerId: customer.id,
      },
      adminToken,
    )
  ).json.order;

  const res = await req('GET', `/orders/${order.id}/whatsapp`, null, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.json.to, '9613555111', 'addressed to the customer on the sale');

  const text = textOf(res.json);
  assert.match(text, /Rami Mobile/, 'says who it is from');
  assert.match(text, new RegExp(order.order_number), 'and which sale');
  assert.match(text, /2× Braided cable/, 'what was bought');
  assert.match(text, /\*Total: \$6\.48\*/, 'and what it came to, tax included');
  assert.match(text, /LL/, 'in pounds as well, which is what most people think in');
});

test('the number on file can be overridden by the one the customer gives', async () => {
  const orders = (await req('GET', '/orders', null, adminToken)).json.orders;
  const res = await req('GET', `/orders/${orders[0].id}/whatsapp?phone=70 999 888`, null, adminToken);

  assert.equal(res.json.to, '96170999888');
});

test('a sale with nobody attached still composes — WhatsApp asks who to send it to', async () => {
  const product = (
    await req('POST', '/products', { name: 'Case', sku: 'WA-CASE-1', price: 5, cost: 2, stock: 4 }, adminToken)
  ).json.product;
  const order = (
    await req(
      'POST',
      '/orders',
      { items: [{ productId: product.id, quantity: 1 }], paymentMethod: 'card' },
      adminToken,
    )
  ).json.order;

  const res = await req('GET', `/orders/${order.id}/whatsapp`, null, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.json.to, null);
  assert.match(res.json.url, /^https:\/\/wa\.me\/\?text=/);
});

test('a cashier cannot send somebody else’s sale', async () => {
  const orders = (await req('GET', '/orders', null, adminToken)).json.orders;
  const res = await req('GET', `/orders/${orders[0].id}/whatsapp`, null, cashierToken);
  assert.equal(res.status, 403);
});

/* ----------------------------------------------------------------- invoice */

test('an invoice says what is still owed, because that is the line that matters', async () => {
  const customer = (
    await req('POST', '/customers', { name: 'Nadia Khoury', phone: '71 222 333' }, adminToken)
  ).json.party;

  const doc = (
    await req(
      'POST',
      '/documents',
      {
        docType: 'sales_invoice',
        partyId: customer.id,
        onAccount: true,
        items: [{ name: 'Screen replacement', price: 60, quantity: 2 }],
      },
      adminToken,
    )
  ).json.document;

  const res = await req('GET', `/documents/${doc.id}/whatsapp`, null, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.json.to, '96171222333');

  const text = textOf(res.json);
  assert.match(text, new RegExp(doc.doc_number));
  assert.match(text, /Sales invoice/);
  assert.match(text, /2× Screen replacement/);
  assert.match(text, /\*Outstanding: \$129\.60\*/, 'the line a customer must not have to hunt for');
});

test('reading an invoice to send it needs the documents permission', async () => {
  const docs = (await req('GET', '/documents', null, adminToken)).json.documents;
  const res = await req('GET', `/documents/${docs[0].id}/whatsapp`, null, cashierToken);
  assert.equal(res.status, 403);
});

/* ----------------------------------------------------------- repair ticket */

test('a repair ticket reaches the customer, with the number they must bring back', async () => {
  const detail = (
    await req(
      'POST',
      '/repairs',
      {
        customerName: 'Samir Aoun',
        customerPhone: '03 777 444',
        device: 'iPhone 12 Pro, black',
        fault: 'screen cracked, does not charge',
        passcode: '4821',
        quoted: 45,
      },
      cashierToken,
    )
  ).json;

  const res = await req('GET', `/repairs/${detail.ticket.id}/whatsapp`, null, cashierToken);
  assert.equal(res.status, 200);
  assert.equal(res.json.to, '9613777444');

  const text = textOf(res.json);
  assert.match(text, new RegExp(detail.ticket.ticket_number), 'the number they quote when they return');
  assert.match(text, /iPhone 12 Pro/);
  assert.match(text, /screen cracked/);
  assert.match(text, /Estimate: \$45\.00/);
  assert.match(text, /Status: Received/);
});

test('the passcode never leaves the shop in a message', async () => {
  const detail = (
    await req(
      'POST',
      '/repairs',
      {
        customerName: 'Rita Frem',
        customerPhone: '03 888 555',
        device: 'Galaxy S21',
        fault: 'no sound on calls',
        passcode: '997531',
        quoted: 20,
      },
      cashierToken,
    )
  ).json;

  const text = textOf((await req('GET', `/repairs/${detail.ticket.id}/whatsapp`, null, cashierToken)).json);

  /*
   * The whole reason it is stored encrypted. A WhatsApp message is a copy that
   * lives on two phones and whatever backs either of them up, and it would
   * unlock everything the customer has.
   */
  assert.ok(!text.includes('997531'), 'the passcode is not in the message');
  assert.ok(!/passcode|pin|password/i.test(text), 'and it is not hinted at either');
});

test('a ticket taken in without a number still composes', async () => {
  const detail = (
    await req(
      'POST',
      '/repairs',
      { customerName: 'Walk-in', device: 'Nokia 3310', fault: 'will not switch on' },
      cashierToken,
    )
  ).json;

  const res = await req('GET', `/repairs/${detail.ticket.id}/whatsapp`, null, cashierToken);
  assert.equal(res.status, 200);
  assert.equal(res.json.to, null);
  assert.match(textOf(res.json), /To be quoted/);
});

test('a ticket that does not exist is a 404, not a blank message', async () => {
  const res = await req('GET', '/repairs/99999/whatsapp', null, cashierToken);
  assert.equal(res.status, 404);
});

/* ---------------------------------------------------------------- settings */

test('a dialling code with a plus in it is refused before it breaks every link', async () => {
  const res = await req('PUT', '/settings', { phone_country_code: '+961' }, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /1–4 digits/);
});

test('changing the dialling code changes who local numbers resolve to', async () => {
  await req('PUT', '/settings', { phone_country_code: '971' }, adminToken);

  const detail = (
    await req(
      'POST',
      '/repairs',
      { customerName: 'Dubai branch', customerPhone: '050 123 4567', device: 'iPad', fault: 'cracked' },
      cashierToken,
    )
  ).json;
  const res = await req('GET', `/repairs/${detail.ticket.id}/whatsapp`, null, cashierToken);
  assert.equal(res.json.to, '971501234567');

  await req('PUT', '/settings', { phone_country_code: '961' }, adminToken);
});

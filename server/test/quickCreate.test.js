/**
 * The three small things a shop kept hitting on the way in.
 *
 * A barcode for stock that arrived without one, a credit limit that did not
 * refuse everybody by default, and — the one that sent people back to the
 * catalogue to redo their work — a phone created from a document arriving as
 * ordinary counted stock with no IMEI behind it.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4644;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;

async function req(method, route, body, bearer = token) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
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
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-quick-create-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'quick.sqlite'),
    JWT_SECRET: 'quick-create-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* -------------------------------------------------- a barcode to print on */

/** The modulo-10 check digit, worked out here rather than imported, so the
 *  test is a second opinion rather than an echo of the implementation. */
function checkDigit(twelve) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

test('a generated barcode is a real EAN-13 the shop’s own scanner will believe', async () => {
  const made = await req('GET', '/products/next-barcode');
  assert.equal(made.status, 200, JSON.stringify(made.json));

  const code = made.json.barcode;
  assert.match(code, /^\d{13}$/, 'thirteen digits');
  assert.equal(code[0], '2', 'in the in-store range, so it cannot collide with a real product');
  assert.equal(
    code[12],
    checkDigit(code.slice(0, 12)),
    'the check digit is computed — this app’s reader verifies it before believing a scan',
  );
});

test('two of them are never the same, and neither is already taken', async () => {
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    const code = (await req('GET', '/products/next-barcode')).json.barcode;
    assert.ok(!seen.has(code), 'a generated code repeated within one run');
    seen.add(code);
  }

  // Take one, then prove it is never handed out again.
  const taken = [...seen][0];
  const made = await req('POST', '/products', {
    name: 'Loose cable', sku: 'GEN-001', price: 3, cost: 1, stock: 10, barcodes: [taken],
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));

  for (let i = 0; i < 20; i += 1) {
    assert.notEqual((await req('GET', '/products/next-barcode')).json.barcode, taken);
  }

  // And it really does find that product, which is the whole point.
  const found = await req('GET', `/products/lookup?code=${taken}`);
  assert.equal(found.status, 200);
  assert.equal(found.json.product.name, 'Loose cable');
});

test('a cashier cannot mint barcodes', async () => {
  const cashier = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' }))
    .json.token;
  const tried = await req('GET', '/products/next-barcode', null, cashier);
  assert.equal(tried.status, 403);
});

/* ------------------------------------------------------- the credit limit */

test('a customer created without a limit is not refused their first purchase', async () => {
  /*
   * The quick-create dialog on an invoice asks for a name and a phone and
   * nothing else. That used to mean a limit of zero — so the very next thing
   * the shop put on the new customer's account was refused by a rule nobody
   * had set.
   */
  const made = await req('POST', '/customers', { name: 'Walk-in regular' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.party.credit_limit, 100000);
});

test('a typed zero still means cash only', async () => {
  /* Zero is a real answer, and the fix must not take it away from a shop that
   * means it. */
  const made = await req('POST', '/customers', { name: 'Cash only', credit_limit: 0 });
  assert.equal(made.json.party.credit_limit, 0);

  const doc = await req('POST', '/documents', {
    docType: 'sales_invoice',
    partyId: made.json.party.id,
    items: [{ productId: 1, quantity: 1, price: 50 }],
    paymentMethod: 'account',
  });
  const confirmed = await req('POST', `/documents/${doc.json.document.id}/confirm`);
  assert.equal(confirmed.status, 400, 'a zero limit still refuses credit');
  assert.match(confirmed.json.error, /credit limit/i);
});

test('a limit typed by hand is still what the shop typed', async () => {
  const made = await req('POST', '/customers', { name: 'Small account', credit_limit: 250 });
  assert.equal(made.json.party.credit_limit, 250);
});

/* --------------------------------------------------- a phone from a document */

test('a product created with IMEI tracking is serialised, and has no loose count', async () => {
  /*
   * What the dialog on a document now sends. Before, it could only ever send
   * false, so a phone added while booking in a delivery arrived as ordinary
   * counted stock and had to be redone in the catalogue.
   */
  const made = await req('POST', '/products', {
    name: 'SAMSUNG S26', sku: 'SAMSUNG-S26-451', price: 850, cost: 800,
    stock: 0, tracks_units: true,
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(Boolean(made.json.product.tracks_units), true);
  assert.equal(made.json.product.stock, 0, 'stock comes from the handsets booked in, not a typed number');
});

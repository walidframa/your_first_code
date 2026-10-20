/**
 * A discount given as a figure, not only as a percentage.
 *
 * "Ten percent off" and "call it a hundred" are both said at a counter.
 * The figure is capped at the goods, the percentage it came to is kept
 * beside it, and the document remembers which way it was given so an edit
 * shows the same box.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4705;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;

async function req(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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

let customer;
let widget;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-doc-discount-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'doc-discount-secret-long-enough-for-the-production-guard',
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
  customer = (await req('POST', '/customers', { name: 'Haggler', credit_limit: 5000 })).json.party;
  widget = (await req('POST', '/products', { name: 'Widget', sku: 'DD-W', price: 50, cost: 30, stock: 20 })).json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a quotation takes a discount in dollars, and remembers it was given that way', async () => {
  const res = await req('POST', '/documents', {
    docType: 'quotation',
    partyId: customer.id,
    items: [{ productId: widget.id, quantity: 3, price: 50 }],
    discountAmount: 20,
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const d = res.json.document;
  assert.equal(d.subtotal, 150);
  assert.equal(d.discount, 20);
  assert.equal(d.discount_mode, 'amount');
  assert.equal(d.discount_percent, 13.33, 'the percentage it came to, kept beside it');
  assert.equal(d.total, 130);

  // Edited without a word about the discount: the twenty stays twenty, even
  // as the goods change — a figure is a figure, not a percentage in disguise.
  const edited = await req('PUT', `/documents/${d.id}`, {
    items: [{ productId: widget.id, quantity: 4, price: 50 }],
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(edited.json.document.discount, 20);
  assert.equal(edited.json.document.total, 180);
  assert.equal(edited.json.document.discount_mode, 'amount');

  // Switched back to a percentage.
  const pct = await req('PUT', `/documents/${d.id}`, { discountPercent: 10 });
  assert.equal(pct.json.document.discount_mode, 'percent');
  assert.equal(pct.json.document.discount, 20);
  assert.equal(pct.json.document.discount_percent, 10);
});

test('a sales invoice caps the figure at the goods and refuses less than nothing', async () => {
  const capped = await req('POST', '/documents', {
    docType: 'sales_invoice',
    partyId: customer.id,
    items: [{ productId: widget.id, quantity: 1, price: 50 }],
    discountAmount: 80,
  });
  assert.equal(capped.status, 201, JSON.stringify(capped.json));
  assert.equal(capped.json.document.discount, 50);
  assert.equal(capped.json.document.total, 0);

  const negative = await req('POST', '/documents', {
    docType: 'sales_invoice',
    partyId: customer.id,
    items: [{ productId: widget.id, quantity: 1, price: 50 }],
    discountAmount: -5,
  });
  assert.equal(negative.status, 400);
  assert.match(negative.json.error, /less than nothing/);
});

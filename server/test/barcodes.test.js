/**
 * Many barcodes on one product.
 *
 * The point of this is the scan: whichever number is facing up when the gun
 * goes off has to find the product. So most of these check a lookup, and the
 * rest check the two ways it could go wrong — the same code ending up on two
 * products, and `products.barcode` drifting away from the table that everything
 * else now reads.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4604;
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

const lookup = (code) => req('GET', `/products/lookup?code=${encodeURIComponent(code)}`, null, cashierToken);

let counter = 0;
const make = (body) =>
  req(
    'POST',
    '/products',
    { name: `Thing ${(counter += 1)}`, sku: `BC-${counter}`, price: 5, ...body },
    adminToken,
  );

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-barcodes-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'barcodes.sqlite'),
    JWT_SECRET: 'barcode-test-secret-long-enough-for-the-guard',
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

test('a product created the old way, with one barcode, still works', async () => {
  const made = await make({ barcode: '5099999000011' });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.product.barcodes, ['5099999000011']);
  assert.equal(made.json.product.barcode, '5099999000011', 'the old column still carries the primary');

  const found = await lookup('5099999000011');
  assert.equal(found.json.product.id, made.json.product.id);
});

test('any of a product’s barcodes finds it', async () => {
  const made = await make({ barcodes: ['5099999000028', '0712345678900', 'SHOP-0001'] });
  assert.equal(made.status, 201);

  for (const code of ['5099999000028', '0712345678900', 'SHOP-0001']) {
    const found = await lookup(code);
    assert.equal(found.status, 200, `${code} should find it`);
    assert.equal(found.json.product.id, made.json.product.id);
  }
});

test('the first is the primary, and it is what the old column holds', async () => {
  const made = await make({ barcodes: ['AAA-1', 'BBB-2', 'CCC-3'] });
  assert.equal(made.json.product.barcode, 'AAA-1');
  assert.deepEqual(made.json.product.barcodes, ['AAA-1', 'BBB-2', 'CCC-3']);

  // Promote the third; the column has to follow, or a label prints one number
  // and Shopify gets another.
  const updated = await req(
    'PUT',
    `/products/${made.json.product.id}`,
    { barcodes: ['CCC-3', 'AAA-1', 'BBB-2'] },
    adminToken,
  );
  assert.equal(updated.json.product.barcode, 'CCC-3');
  assert.deepEqual(updated.json.product.barcodes, ['CCC-3', 'AAA-1', 'BBB-2']);
});

test('the scanner’s whitespace is not part of the number', async () => {
  const made = await make({ barcodes: ['  5099999000035\n'] });
  assert.deepEqual(made.json.product.barcodes, ['5099999000035']);
  assert.equal((await lookup('5099999000035')).status, 200);
});

test('scanning the same box twice adds one barcode, not two', async () => {
  const made = await make({ barcodes: ['DUP-1', 'DUP-1', 'DUP-2'] });
  assert.deepEqual(made.json.product.barcodes, ['DUP-1', 'DUP-2']);
});

test('a barcode already on another product is refused, and says which', async () => {
  const first = await make({ barcodes: ['SHARED-9'] });
  assert.equal(first.status, 201);

  const second = await make({ barcodes: ['SHARED-9'] });
  assert.equal(second.status, 409);
  assert.match(second.json.error, /SHARED-9 is already on/);
  assert.match(second.json.error, new RegExp(first.json.product.name));
});

test('and the refused product is not left half-created', async () => {
  const before = (await req('GET', '/products', null, adminToken)).json.products.length;
  const refused = await req(
    'POST',
    '/products',
    { name: 'Doomed', sku: 'BC-DOOMED', price: 1, barcodes: ['SHARED-9'] },
    adminToken,
  );
  assert.equal(refused.status, 409);

  const after = (await req('GET', '/products', null, adminToken)).json.products;
  assert.equal(after.length, before, 'a product that could not take its barcodes should not exist');
  assert.equal(after.some((p) => p.sku === 'BC-DOOMED'), false);
});

test('removing every barcode clears the old column too', async () => {
  const made = await make({ barcodes: ['GONE-1', 'GONE-2'] });
  const updated = await req('PUT', `/products/${made.json.product.id}`, { barcodes: [] }, adminToken);

  assert.deepEqual(updated.json.product.barcodes, []);
  assert.equal(updated.json.product.barcode, null, 'or a label would print a number nothing answers to');
  assert.equal((await lookup('GONE-1')).status, 404);
});

test('an edit that never mentions barcodes leaves them alone', async () => {
  const made = await make({ barcodes: ['KEEP-1', 'KEEP-2'] });
  const updated = await req(
    'PUT',
    `/products/${made.json.product.id}`,
    { price: 99 },
    adminToken,
  );

  assert.equal(updated.json.product.price, 99);
  assert.deepEqual(updated.json.product.barcodes, ['KEEP-1', 'KEEP-2']);
});

test('naming one barcode the old way keeps the ones added by scanning', async () => {
  const made = await make({ barcodes: ['OLD-PRIMARY', 'SCANNED-A', 'SCANNED-B'] });

  // What an older screen, or a CSV, sends: a single barcode and nothing else.
  const updated = await req(
    'PUT',
    `/products/${made.json.product.id}`,
    { barcode: 'NEW-PRIMARY' },
    adminToken,
  );

  assert.equal(updated.json.product.barcodes[0], 'NEW-PRIMARY');
  assert.deepEqual(
    updated.json.product.barcodes.slice(1).sort(),
    ['OLD-PRIMARY', 'SCANNED-A', 'SCANNED-B'],
    'a routine catalogue refresh must not make half the shelf unscannable',
  );
});

test('the seeded catalogue is scannable, so nothing was stranded in the old column', async () => {
  const found = await lookup('5012345000015');
  assert.equal(found.status, 200, 'the migration has to cover products that predate the table');
  assert.ok(found.json.product.barcodes.includes('5012345000015'));
});

test('the product list carries every barcode, for searching', async () => {
  const made = await make({ barcodes: ['LIST-1', 'LIST-2'] });
  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const mine = products.find((p) => p.id === made.json.product.id);
  assert.deepEqual(mine.barcodes, ['LIST-1', 'LIST-2']);
});

test('an unknown code still says so plainly', async () => {
  const missing = await lookup('nothing-like-this');
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /No product matches/);
});

/**
 * The shop that has one drawer and wants nothing else.
 *
 * Splitting the register's till from the shop's standing cash account is the
 * right answer for a shop with a safe in the back. It must be invisible to the
 * shop that never made one: the drawer it started with is both, so the register
 * rings into it, the office pays suppliers out of it, and closing it is still
 * a bank drop — money out of the drawer and out of the shop's records, which
 * for takings actually taken to the bank is the truth.
 *
 * Held as its own file because the point is a shop that has *only* the one
 * account, and a second account created anywhere in the same database would
 * quietly make it a different shop.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4643;
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

let drawer;
let supplier;
let widget;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-one-till-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'one-till.sqlite'),
    JWT_SECRET: 'one-till-secret-long-enough-to-pass-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;

  const registry = (await req('GET', '/accounts/registry')).json.registry;
  assert.equal(registry.cash.length, 1, 'one till, which is the whole point of this file');
  drawer = registry.cash[0];

  supplier = (await req('POST', '/suppliers', { name: 'Wholesaler' })).json.party;
  widget = (await req('POST', '/products', {
    name: 'Widget', sku: 'ONE-001', price: 10, cost: 6, stock: 100,
  })).json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function balance() {
  const registry = (await req('GET', '/accounts/registry')).json.registry;
  return registry.cash.find((a) => a.id === drawer.id).balance;
}

test('the register and the back office are the same drawer', async () => {
  const current = await req('GET', '/cash/current');
  assert.equal(current.json.accountId, drawer.id);

  await req('POST', '/cash/open', { openingUsd: 100 });

  await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 2 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 20 }],
  });
  assert.equal(await balance(), 120, 'the sale is in it');

  await req('POST', `/suppliers/${supplier.id}/payments`, {
    payments: [{ currency: 'USD', amount: 30 }],
  });
  assert.equal(await balance(), 90, 'and the supplier came out of it');
});

test('closing it is still a bank drop, because there is nowhere else for the money to go', async () => {
  const closed = await req('POST', '/cash/close', { countedUsd: 90, carriedUsd: 10 });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));

  const kinds = closed.json.movements.map((m) => m.kind);
  assert.ok(kinds.includes('bank_drop'), 'money out of the drawer, to the bank');
  assert.ok(!kinds.includes('sweep'), 'and not moved to an account that does not exist');
  assert.equal(await balance(), 10, 'the float stays behind');
});

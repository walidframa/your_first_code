/**
 * Which cashbox a purchase invoice comes out of.
 *
 * A shop with more than one place to keep money — a counter drawer and an
 * office safe — made the safe its default and settled a purchase invoice in
 * cash. The supplier's statement said paid. No money left any account.
 *
 * It happened because `recordMovement` returned null when the account it was
 * given had no open sitting, and nothing above it checked. Every other way of
 * moving cash in this app asks first: the register, a transfer, a voucher, a
 * repair. Confirming a document did not, so the failure was silent and the
 * books disagreed with themselves.
 *
 * Two things are held here. The refusal names the account, because with
 * several of them the whole question is *which* one to open. And the money
 * lands in the account the shop chose, not in whichever one happens to be
 * open — that being the thing that was actually asked for.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4641;
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

/** A shop's drawer, its safe, and a supplier to owe money to. */
let drawer;
let safe;
let supplier;
let widget;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-default-account-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'accounts.sqlite'),
    JWT_SECRET: 'default-account-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;

  const registry = (await req('GET', '/accounts/registry')).json.registry;
  drawer = registry.cash.find((a) => a.isDefault);
  assert.ok(drawer, 'a shop starts with one drawer, and it is the default');

  // The office keeps its own float, and the owner makes it the one every
  // screen falls back to.
  safe = (await req('POST', '/accounts/cash', { name: 'Office safe', kind: 'safe' })).json.account;
  await req('PUT', `/accounts/cash/${safe.id}`, { isDefault: true });

  supplier = (await req('POST', '/suppliers', { name: 'Wholesaler' })).json.party;
  widget = (await req('POST', '/products', {
    name: 'Widget', sku: 'WID-001', price: 10, cost: 6, stock: 0,
  })).json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** A purchase invoice for $60, settled in cash on the spot. */
async function cashPurchase() {
  const created = await req('POST', '/documents', {
    docType: 'purchase_invoice',
    partyId: supplier.id,
    items: [{ productId: widget.id, quantity: 10, price: 6 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 60 }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.document;
}

/** What an account holds, as the Accounts screen reads it. */
async function balanceOf(accountId) {
  const registry = (await req('GET', '/accounts/registry')).json.registry;
  return registry.cash.find((a) => a.id === accountId)?.balance ?? null;
}

test('the default is the account the shop chose, not the one it started with', async () => {
  const registry = (await req('GET', '/accounts/registry')).json.registry;
  const chosen = registry.cash.find((a) => a.isDefault);
  assert.equal(chosen.id, safe.id, 'the safe is the default now');
  assert.equal(registry.cash.find((a) => a.id === drawer.id).isDefault, false);
});

test('a purchase invoice comes out of the safe, without the safe being "opened"', async () => {
  /*
   * The bug, exactly as the shop met it.
   *
   * The counter is open for the day. Nobody has opened the safe, because a
   * safe is not something a shop opens and closes per shift — it is where the
   * money lives. Confirming used to write the supplier's ledger entry, write
   * the voucher, and record no cash movement at all: the books said paid and
   * no account was any lighter.
   */
  await req('POST', '/cash/open', { openingUsd: 100, accountId: drawer.id });

  const drawerBefore = await balanceOf(drawer.id);
  const safeBefore = await balanceOf(safe.id);

  const doc = await cashPurchase();
  const confirmed = await req('POST', `/documents/${doc.id}/confirm`);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));

  assert.equal(
    await balanceOf(safe.id),
    safeBefore - 60,
    'the invoice came out of the account the shop made its default',
  );
  assert.equal(
    await balanceOf(drawer.id),
    drawerBefore,
    'and left the counter drawer exactly as it was',
  );
  assert.equal(
    (await req('GET', `/suppliers/${supplier.id}`)).json.party.balance,
    0,
    'the supplier is square: billed and paid',
  );
});

test('a counter drawer still has to be open before cash leaves it', async () => {
  /*
   * The other half, and the reason this is not simply "never ask".
   *
   * A drawer *is* a shift: opened with a float, counted at the end, and the
   * difference is somebody's to explain. Cash out of one nobody opened is a
   * count that can never be reconciled, so it is refused — and the refusal
   * names the account, because with several of them the whole question is
   * which one.
   */
  const shut = (await req('POST', '/accounts/cash', { name: 'Second till', kind: 'drawer' })).json
    .account;

  const doc = await cashPurchase();
  const confirmed = await req('POST', `/documents/${doc.id}/confirm`, { accountId: shut.id });

  assert.equal(confirmed.status, 400, 'it must not go through silently');
  assert.match(confirmed.json.error, /Second till/, 'the refusal says which cashbox to open');

  const still = (await req('GET', `/documents/${doc.id}`)).json.document;
  assert.equal(still.status, 'draft', 'a refused confirm leaves the document alone');
});

test('a document can still name a different cashbox than the default', async () => {
  /*
   * The default is a fallback, not a rule. An invoice actually paid from the
   * counter says so, and the counter is what moves.
   */
  const safeBefore = await balanceOf(safe.id);
  const drawerBefore = await balanceOf(drawer.id);

  const doc = await cashPurchase();
  const confirmed = await req('POST', `/documents/${doc.id}/confirm`, { accountId: drawer.id });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));

  assert.equal(await balanceOf(drawer.id), drawerBefore - 60, 'paid from the counter');
  assert.equal(await balanceOf(safe.id), safeBefore, 'the safe is untouched');
});

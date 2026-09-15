/**
 * One wallet, a balance at each branch.
 *
 * The shops that sell cards each hold their own line with the carrier: Saida
 * tops up Saida's I-Pick and sells Saida's cards out of it, and the main shop
 * does the same with its own. The wallet is the name they share. What is being
 * checked is that nothing one branch does shows up on the other's figure, that
 * the company still has a total, and that credit can be moved between them.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4698;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let main;
let saida;
let wallet;
let card;

async function req(method, route, body, token, branch = null) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(branch ? { 'X-Branch-Id': String(branch) } : {}),
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

/** The wallet as seen from one branch's counter. */
const seenFrom = async (branch) =>
  (await req('GET', '/wallets', null, adminToken, branch)).json.wallets.find((w) => w.id === wallet.id);

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-wallet-branches-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'wallet-branches.sqlite'),
    JWT_SECRET: 'wallet-branches-secret-long-enough-for-guard',
    ACCOUNT_SECRET: 'wallet-branches-account-secret-long-enough',
    PORT: String(PORT),
    NODE_ENV: 'test',
    REQUIRE_CASH_SESSION: 'false',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;

  main = (await req('GET', '/branches', null, adminToken)).json.branches.find((b) => b.is_main);
  saida = (await req('POST', '/branches', { name: 'Saida', code: 'SAI' }, adminToken)).json.branch;

  wallet = (
    await req('POST', '/wallets', { name: 'I-Pick', kind: 'recharge', opening: 100 }, adminToken, main.id)
  ).json.wallet;
  card = (
    await req(
      'POST',
      '/products',
      { name: 'I-Pick 10', sku: 'IPICK-10', price: 10.5, cost: 10, wallet_id: wallet.id },
      adminToken,
    )
  ).json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('an opening balance lands on the branch that opened it', async () => {
  const here = await seenFrom(main.id);
  assert.equal(here.balance, 100, 'the main shop holds it');
  assert.equal(here.total, 100);

  const there = await seenFrom(saida.id);
  assert.equal(there.balance, 0, 'Saida has nothing on its line yet');
  assert.equal(there.total, 100, 'but can see the company holds it');

  const split = Object.fromEntries(there.balances.map((b) => [b.branch_name, b.balance]));
  assert.deepEqual(split, { [main.name]: 100, Saida: 0 });
});

test('each branch tops up its own line', async () => {
  const res = await req('POST', `/wallets/${wallet.id}/movements`, { kind: 'top_up', amount: 40 }, adminToken, saida.id);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.wallet.balance, 40, 'the answer is the branch that asked');
  assert.equal(res.json.wallet.total, 140);

  assert.equal((await seenFrom(main.id)).balance, 100, 'the main shop is untouched');
});

test('a card sold at one branch spends that branch’s credit and nobody else’s', async () => {
  const sale = await req(
    'POST',
    '/orders',
    { items: [{ productId: card.id, quantity: 2 }], paymentMethod: 'card' },
    adminToken,
    saida.id,
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  assert.equal((await seenFrom(saida.id)).balance, 20, 'two at $10 cost, off Saida');
  assert.equal((await seenFrom(main.id)).balance, 100, 'the main shop still has all of its own');

  // And refunding it puts the credit back where it came from.
  const refund = await req('POST', `/orders/${sale.json.order.id}/refund`, {}, adminToken, main.id);
  assert.equal(refund.status, 200, JSON.stringify(refund.json));
  assert.equal((await seenFrom(saida.id)).balance, 40, 'back on Saida, even when refunded from the main shop');
  assert.equal((await seenFrom(main.id)).balance, 100);
});

test('credit can be moved from one branch’s line to another’s', async () => {
  const moved = await req(
    'POST',
    `/wallets/${wallet.id}/transfer`,
    { fromBranchId: main.id, toBranchId: saida.id, amount: 30 },
    adminToken,
    main.id,
  );
  assert.equal(moved.status, 201, JSON.stringify(moved.json));
  assert.equal((await seenFrom(main.id)).balance, 70);
  assert.equal((await seenFrom(saida.id)).balance, 70);
  assert.equal((await seenFrom(main.id)).total, 140, 'nothing was created or lost');

  const same = await req(
    'POST',
    `/wallets/${wallet.id}/transfer`,
    { fromBranchId: main.id, toBranchId: main.id, amount: 5 },
    adminToken,
  );
  assert.equal(same.status, 400);
});

test('the statement can be read for the company, or for one branch', async () => {
  const all = (await req('GET', `/wallets/${wallet.id}/movements`, null, adminToken)).json.movements;
  assert.ok(all.some((m) => m.branch_name === 'Saida') && all.some((m) => m.branch_name === main.name));

  const only = (await req('GET', `/wallets/${wallet.id}/movements?branchId=${saida.id}`, null, adminToken)).json
    .movements;
  assert.ok(only.length > 0);
  assert.ok(only.every((m) => m.branch_name === 'Saida'));
});

test('the register’s carrier list reads its own branch', async () => {
  await req('PUT', `/wallets/${wallet.id}`, { sendsCredit: true }, adminToken);
  const atSaida = (await req('GET', '/credit/carriers', null, adminToken, saida.id)).json.carriers.find(
    (c) => c.id === wallet.id,
  );
  const atMain = (await req('GET', '/credit/carriers', null, adminToken, main.id)).json.carriers.find(
    (c) => c.id === wallet.id,
  );
  assert.equal(atSaida.balance, 70);
  assert.equal(atMain.balance, 70);
});

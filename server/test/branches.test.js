/**
 * Two shops, one company.
 *
 * The line these tests defend: everything that *describes* something is shared —
 * the product, its price, its barcodes — and everything that *is* something is
 * not. A phone on the shelf at one branch cannot be sold at the other, and the
 * catalogue is never duplicated to make that work.
 *
 * The transfer tests are mostly about the gap between sending and receiving,
 * because that is where stock can end up counted twice or not at all.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4606;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let cashierToken;
let mainBranch;
let saida;

/** `branch` sends the X-Branch-Id header, which is how the owner switches shops. */
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

const product = async (sku, branch = null) =>
  (await req('GET', `/products/lookup?code=${sku}`, null, adminToken, branch)).json.product;

let sku = 0;
const makeProduct = async (stock, branch = null) => {
  sku += 1;
  const res = await req(
    'POST',
    '/products',
    { name: `Branch thing ${sku}`, sku: `BR-${sku}`, price: 10, cost: 6, stock },
    adminToken,
    branch,
  );
  return res.json.product;
};

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-branches-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'branches.sqlite'),
    JWT_SECRET: 'branch-test-secret-long-enough-for-the-guard',
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

  const listed = await req('GET', '/branches', null, adminToken);
  mainBranch = listed.json.branches.find((b) => b.is_main);

  const made = await req('POST', '/branches', { name: 'Saida', code: 'SAI', phone: '07 111 222' }, adminToken);
  saida = made.json.branch;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------- the shops */

test('the shop starts with one branch, and everything already there belongs to it', async () => {
  assert.ok(mainBranch, 'a shop that has always had one counter still has a branch');
  assert.equal(mainBranch.is_main, true);

  // The seeded catalogue's stock moved onto the main branch's shelf.
  const espresso = await product('BEV-001');
  assert.ok(espresso.stock > 0, 'the shelf came across in the migration');
  assert.equal(espresso.stock, espresso.total_stock, 'with one branch, here and everywhere are the same');
});

test('a second branch gets a till of its own, or it cannot take a cash sale', async () => {
  const tills = (await req('GET', '/accounts/registry', null, adminToken)).json.registry.cash;
  assert.ok(tills.some((t) => t.name.includes('Saida')), 'opening a branch that cannot take money is not opening');
});

test('two branches cannot share a name', async () => {
  const again = await req('POST', '/branches', { name: 'Saida' }, adminToken);
  assert.equal(again.status, 400);
  assert.match(again.json.error, /already a branch called/i);
});

/* ------------------------------------------------------- the shared parts */

test('the catalogue is shared — a product is not entered twice', async () => {
  const made = await makeProduct(10);

  // The same product, found from the other shop, at the same price.
  const fromSaida = await product(made.sku, saida.id);
  assert.equal(fromSaida.id, made.id, 'one product, one id, both counters');
  assert.equal(fromSaida.price, made.price);
  assert.deepEqual(fromSaida.barcodes, made.barcodes);
});

test('but the shelf is not — stock entered at one branch is only there', async () => {
  const made = await makeProduct(10);

  assert.equal((await product(made.sku, mainBranch.id)).stock, 10, 'ten here');
  assert.equal((await product(made.sku, saida.id)).stock, 0, 'none there');
  assert.equal((await product(made.sku, saida.id)).total_stock, 10, 'ten in the company');
});

test('a sale can only take what is at the counter it is rung up on', async () => {
  const made = await makeProduct(3);

  const refused = await req(
    'POST',
    '/orders',
    { items: [{ productId: made.id, quantity: 1 }], paymentMethod: 'card' },
    adminToken,
    saida.id,
  );

  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /Not enough stock/);
  // And it says where they actually are, which is the next question.
  assert.match(refused.json.error, /3 at Main branch/);
});

test('a sale takes stock off its own branch and leaves the other alone', async () => {
  const made = await makeProduct(8);

  const sold = await req(
    'POST',
    '/orders',
    { items: [{ productId: made.id, quantity: 3 }], paymentMethod: 'card' },
    adminToken,
    mainBranch.id,
  );
  assert.equal(sold.status, 201);

  assert.equal((await product(made.sku, mainBranch.id)).stock, 5);
  assert.equal((await product(made.sku, saida.id)).stock, 0);
  assert.equal((await product(made.sku)).total_stock, 5, 'the company owns five now');
});

/* --------------------------------------------------------- who goes where */

test('a cashier is pinned to their own counter', async () => {
  const made = await makeProduct(5);

  // The cashier has no branch set, so they are at the main one — and asking for
  // another is simply ignored rather than obeyed.
  const seen = await req('GET', `/products/lookup?code=${made.sku}`, null, cashierToken, saida.id);
  assert.equal(seen.json.product.stock, 5, 'still reading their own shelf');
});

test('and cannot open a branch', async () => {
  const refused = await req('POST', '/branches', { name: 'Tripoli' }, cashierToken);
  assert.equal(refused.status, 403);
});

test('the owner can switch, and the branch list says so', async () => {
  const asAdmin = await req('GET', '/branches', null, adminToken);
  assert.equal(asAdmin.json.canSwitch, true);
  assert.ok(asAdmin.json.branches.length >= 2);

  const asCashier = await req('GET', '/branches', null, cashierToken);
  assert.equal(asCashier.json.canSwitch, false);
  assert.equal(asCashier.json.branches.length, 1, 'they see where they are, not a menu');
});

/* ---------------------------------------------------------- the transfers */

test('stock sent to another branch leaves this shelf immediately', async () => {
  const made = await makeProduct(10);

  const sent = await req(
    'POST',
    '/stock-transfers',
    { toBranchId: saida.id, items: [{ productId: made.id, quantity: 4 }], note: 'weekend cover' },
    adminToken,
    mainBranch.id,
  );

  assert.equal(sent.status, 201);
  assert.equal(sent.json.transfer.status, 'sent');
  assert.match(sent.json.transfer.reference, /^TR-\d{4}$/);

  assert.equal((await product(made.sku, mainBranch.id)).stock, 6, 'the box has left');
  assert.equal((await product(made.sku, saida.id)).stock, 0, 'and has not arrived');
  assert.equal(
    (await product(made.sku)).total_stock,
    6,
    'in transit it belongs to nobody — counting it at both ends is how it gets sold twice',
  );
});

test('receiving it puts the stock on the other shelf', async () => {
  const made = await makeProduct(10);
  const sent = await req(
    'POST',
    '/stock-transfers',
    { toBranchId: saida.id, items: [{ productId: made.id, quantity: 4 }] },
    adminToken,
    mainBranch.id,
  );

  const received = await req(
    'POST',
    `/stock-transfers/${sent.json.transfer.id}/receive`,
    {},
    adminToken,
    saida.id,
  );

  assert.equal(received.status, 200);
  assert.equal(received.json.transfer.status, 'received');
  assert.equal((await product(made.sku, mainBranch.id)).stock, 6);
  assert.equal((await product(made.sku, saida.id)).stock, 4);
  assert.equal((await product(made.sku)).total_stock, 10, 'nothing was created or lost');
});

test('and the product was never duplicated to do it', async () => {
  const all = (await req('GET', '/products', null, adminToken)).json.products;
  const names = all.map((p) => p.sku);
  assert.equal(new Set(names).size, names.length, 'one row per product, however many shops it is in');
});

test('the list shows both what this branch sent and what is coming to it', async () => {
  const atMain = await req('GET', '/stock-transfers', null, adminToken, mainBranch.id);
  assert.equal(atMain.status, 200);
  assert.ok(atMain.json.transfers.length > 0);
  assert.ok(
    atMain.json.transfers.every((t) => t.from_branch_id === mainBranch.id || t.to_branch_id === mainBranch.id),
    'a list of every branch’s paperwork is not something anybody reads at a counter',
  );
  assert.ok(atMain.json.transfers[0].created_by_name, 'and it says who sent it');

  const atSaida = await req('GET', '/stock-transfers', null, adminToken, saida.id);
  assert.equal(atSaida.status, 200);
});

test('a transfer has to be received at the branch it was sent to', async () => {
  const made = await makeProduct(5);
  const sent = await req(
    'POST',
    '/stock-transfers',
    { toBranchId: saida.id, items: [{ productId: made.id, quantity: 2 }] },
    adminToken,
    mainBranch.id,
  );

  const wrongEnd = await req(
    'POST',
    `/stock-transfers/${sent.json.transfer.id}/receive`,
    {},
    adminToken,
    mainBranch.id,
  );
  assert.equal(wrongEnd.status, 400);
  assert.match(wrongEnd.json.error, /has to be received there/);
});

test('you cannot send more than is on the shelf', async () => {
  const made = await makeProduct(2);
  const refused = await req(
    'POST',
    '/stock-transfers',
    { toBranchId: saida.id, items: [{ productId: made.id, quantity: 5 }] },
    adminToken,
    mainBranch.id,
  );

  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /Not enough/);
  assert.equal((await product(made.sku, mainBranch.id)).stock, 2, 'and nothing moved');
});

test('a box that arrives short is recorded as short, not quietly written off', async () => {
  const made = await makeProduct(10);
  const sent = await req(
    'POST',
    '/stock-transfers',
    { toBranchId: saida.id, items: [{ productId: made.id, quantity: 6 }] },
    adminToken,
    mainBranch.id,
  );

  const line = sent.json.transfer.items[0];
  const received = await req(
    'POST',
    `/stock-transfers/${sent.json.transfer.id}/receive`,
    { counts: { [line.id]: 4 } },
    adminToken,
    saida.id,
  );

  assert.equal(received.status, 200);
  assert.equal((await product(made.sku, saida.id)).stock, 4, 'four arrived');
  assert.equal((await product(made.sku)).total_stock, 8, 'two never turned up and are not counted as owned');

  const moves = (await req('GET', '/inventory/movements?limit=50', null, adminToken)).json.movements;
  assert.ok(
    moves.some((m) => (m.note || '').includes('sent but never arrived')),
    'somebody has to be able to go and ask about it',
  );
});

test('a transfer still in the car can be called off, and the stock comes back', async () => {
  const made = await makeProduct(7);
  const sent = await req(
    'POST',
    '/stock-transfers',
    { toBranchId: saida.id, items: [{ productId: made.id, quantity: 3 }] },
    adminToken,
    mainBranch.id,
  );
  assert.equal((await product(made.sku, mainBranch.id)).stock, 4);

  const cancelled = await req('POST', `/stock-transfers/${sent.json.transfer.id}/cancel`, {}, adminToken);
  assert.equal(cancelled.json.transfer.status, 'cancelled');
  assert.equal((await product(made.sku, mainBranch.id)).stock, 7, 'back on the shelf it left');
});

test('one already received cannot be cancelled — send it back instead', async () => {
  const made = await makeProduct(4);
  const sent = await req(
    'POST',
    '/stock-transfers',
    { toBranchId: saida.id, items: [{ productId: made.id, quantity: 2 }] },
    adminToken,
    mainBranch.id,
  );
  await req('POST', `/stock-transfers/${sent.json.transfer.id}/receive`, {}, adminToken, saida.id);

  const refused = await req('POST', `/stock-transfers/${sent.json.transfer.id}/cancel`, {}, adminToken);
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /send it back the other way/i);
});

test('a transfer cannot go to the branch it came from', async () => {
  const made = await makeProduct(3);
  const refused = await req(
    'POST',
    '/stock-transfers',
    { toBranchId: mainBranch.id, items: [{ productId: made.id, quantity: 1 }] },
    adminToken,
    mainBranch.id,
  );
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /somewhere else/i);
});

test('a card has no shelf, so there is nothing to transfer', async () => {
  const wallet = await req('POST', '/wallets', { name: 'Alfa credit', currency: 'USD' }, adminToken);
  const card = await req(
    'POST',
    '/products',
    { name: 'Alfa 10', sku: 'CARD-BR-1', price: 10, wallet_id: wallet.json.wallet.id },
    adminToken,
  );

  const refused = await req(
    'POST',
    '/stock-transfers',
    { toBranchId: saida.id, items: [{ productId: card.json.product.id, quantity: 1 }] },
    adminToken,
    mainBranch.id,
  );
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /sold from a wallet/);
});

/* ------------------------------------------------------------- closing up */

test('a branch still holding stock cannot be closed', async () => {
  const made = await makeProduct(6);
  const sent = await req(
    'POST',
    '/stock-transfers',
    { toBranchId: saida.id, items: [{ productId: made.id, quantity: 6 }] },
    adminToken,
    mainBranch.id,
  );
  await req('POST', `/stock-transfers/${sent.json.transfer.id}/receive`, {}, adminToken, saida.id);

  const refused = await req('DELETE', `/branches/${saida.id}`, null, adminToken);
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /still holds/);

  // Send it back, and then it can be.
  const back = await req(
    'POST',
    '/stock-transfers',
    { toBranchId: mainBranch.id, items: [{ productId: made.id, quantity: 6 }] },
    adminToken,
    saida.id,
  );
  await req('POST', `/stock-transfers/${back.json.transfer.id}/receive`, {}, adminToken, mainBranch.id);
});

test('the main branch can never be closed', async () => {
  const refused = await req('DELETE', `/branches/${mainBranch.id}`, null, adminToken);
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /main branch cannot be closed/i);
});

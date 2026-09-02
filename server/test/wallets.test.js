/**
 * Cards sold from credit rather than from stock.
 *
 * The thread through all of it: a recharge card has no shelf, so the thing that
 * must move when one sells is the wallet behind it — and it must move by what
 * the card cost, not by one.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Taken: 4594 repairs, 4595 units, 4596 profit, 4598 cash, 4599 api.
const PORT = 4593;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let cashierToken;
let wallet;
let card;

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

const balanceOf = async (id) =>
  (await req('GET', '/wallets', null, adminToken)).json.wallets.find((w) => w.id === id).balance;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-wallets-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'wallets.sqlite'),
    JWT_SECRET: 'wallets-test-secret-long-enough-for-guard',
    ACCOUNT_SECRET: 'wallets-account-secret-long-enough-32',
    PORT: String(PORT),
    NODE_ENV: 'test',
    REQUIRE_CASH_SESSION: 'false',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  cashierToken = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' })).json
    .token;

  wallet = (
    await req('POST', '/wallets', { name: 'Alfa credit', kind: 'recharge', opening: 100 }, adminToken)
  ).json.wallet;

  card = (
    await req(
      'POST',
      '/products',
      { name: 'ALFA 7.58 · 1 month', sku: 'CARD-TEST-758', price: 3.11, cost: 3, wallet_id: wallet.id },
      adminToken,
    )
  ).json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* --------------------------------------------------------------- wallets */

test('an opening balance is the first movement, not a figure on its own', async () => {
  assert.equal(wallet.balance, 100);

  const statement = await req('GET', `/wallets/${wallet.id}/movements`, null, adminToken);
  assert.equal(statement.json.movements.length, 1);
  assert.equal(statement.json.movements[0].kind, 'top_up');
  assert.equal(statement.json.movements[0].amount, 100);
});

test('the direction belongs to the kind, not to the typist', async () => {
  const w = (await req('POST', '/wallets', { name: 'Signs test' }, adminToken)).json.wallet;

  // A top-up of -40 is a slip, and reading it as money added would be worse.
  await req('POST', `/wallets/${w.id}/movements`, { kind: 'top_up', amount: -40 }, adminToken);
  assert.equal(await balanceOf(w.id), 40);

  await req('POST', `/wallets/${w.id}/movements`, { kind: 'withdrawal', amount: 15 }, adminToken);
  assert.equal(await balanceOf(w.id), 25);

  // A correction is the one place the sign is the shopkeeper's to give.
  await req('POST', `/wallets/${w.id}/movements`, { kind: 'adjustment', amount: -5 }, adminToken);
  assert.equal(await balanceOf(w.id), 20);
});

test('a cashier can see the credit but not move it', async () => {
  assert.equal((await req('GET', '/wallets', null, cashierToken)).status, 200);
  const attempt = await req(
    'POST',
    `/wallets/${wallet.id}/movements`,
    { kind: 'top_up', amount: 500 },
    cashierToken,
  );
  assert.equal(attempt.status, 403);
});

/* ----------------------------------------------------------------- cards */

test('selling a card spends the wallet and leaves stock alone', async () => {
  const before = await balanceOf(wallet.id);

  const sale = await req(
    'POST',
    '/orders',
    { items: [{ productId: card.id, quantity: 3 }], paymentMethod: 'card' },
    cashierToken,
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  // Three at $3 cost, whatever they sold for.
  assert.equal(await balanceOf(wallet.id), Math.round((before - 9) * 100) / 100);

  const product = (await req('GET', `/products/${card.id}`, null, adminToken)).json.product;
  assert.equal(product.stock, 0, 'a card has no stock to decrement');

  // The margin still reaches the books: the line carries the cost that was
  // true when it sold, exactly like any other product.
  assert.equal(sale.json.items[0].cost, 3);
  assert.equal(sale.json.items[0].line_total, 9.33);
});

test('a card is never out of stock, however many are sold', async () => {
  const many = await req(
    'POST',
    '/orders',
    { items: [{ productId: card.id, quantity: 40 }], paymentMethod: 'card' },
    cashierToken,
  );
  assert.equal(many.status, 201, 'nothing to run out of');

  /*
   * And the wallet is allowed to go under. The cards have been handed over;
   * refusing the sale afterwards would not get them back, so what is owed to
   * the supplier is shown rather than hidden behind a failed sale.
   */
  assert.ok((await balanceOf(wallet.id)) < 0, 'the overdraft is visible, not fatal');
});

test('refunding a card sale puts the credit back', async () => {
  const w = (await req('POST', '/wallets', { name: 'Refund test', opening: 50 }, adminToken)).json.wallet;
  const c = (
    await req(
      'POST',
      '/products',
      { name: 'iTunes $10', sku: 'CARD-TEST-ITUNES', price: 11, cost: 10, wallet_id: w.id },
      adminToken,
    )
  ).json.product;

  const sale = await req(
    'POST',
    '/orders',
    { items: [{ productId: c.id, quantity: 2 }], paymentMethod: 'card' },
    cashierToken,
  );
  assert.equal(await balanceOf(w.id), 30);

  await req('POST', `/orders/${sale.json.order.id}/refund`, {}, adminToken);
  assert.equal(await balanceOf(w.id), 50);

  const product = (await req('GET', `/products/${c.id}`, null, adminToken)).json.product;
  assert.equal(product.stock, 0, 'nothing came off a shelf, so nothing goes back on one');
});

test('a card cannot also be tracked by IMEI', async () => {
  const res = await req(
    'POST',
    '/products',
    { name: 'Confused', sku: 'CARD-TEST-BOTH', price: 5, wallet_id: wallet.id, tracks_units: true },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /cannot also be tracked/);
});

test('turning an ordinary product into a card clears its leftover count', async () => {
  const p = (
    await req('POST', '/products', { name: 'Was stock', sku: 'CARD-TEST-WAS', price: 4, stock: 12 }, adminToken)
  ).json.product;

  const updated = await req('PUT', `/products/${p.id}`, { wallet_id: wallet.id }, adminToken);
  assert.equal(updated.status, 200);
  assert.equal(updated.json.product.stock, 0, '"12 left" beside something that cannot run out');
});

test('a card cannot be stock-adjusted — the wallet is its stock', async () => {
  const res = await req(
    'POST',
    '/inventory/adjust',
    { productId: card.id, delta: 5, reason: 'received' },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /top the wallet up/);
});

test('a wallet still funding cards cannot be closed', async () => {
  const res = await req('DELETE', `/wallets/${wallet.id}`, null, adminToken);
  assert.equal(res.status, 409);
  assert.match(res.json.error, /funded by/);
});

/* ------------------------------------------------------- starter catalogue */

test('the starter catalogue installs once and can be pressed twice', async () => {
  const first = await req('POST', '/wallets/starter-catalogue', {}, adminToken);
  assert.equal(first.status, 201);
  assert.ok(first.json.added > 0);
  assert.equal(first.json.skipped, 0);

  const second = await req('POST', '/wallets/starter-catalogue', {}, adminToken);
  assert.equal(second.json.added, 0, 'no duplicates');
  assert.equal(second.json.skipped, first.json.added);

  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const alfa = products.find((p) => p.sku === 'CARD-ALFA-7-58-1M');
  assert.equal(alfa.price, 3.11);
  assert.ok(alfa.wallet_id, 'every seeded card knows what funds it');
  assert.equal(alfa.cost, alfa.price, 'cost starts at the selling price rather than a guessed margin');

  const categories = (await req('GET', '/products/categories', null, adminToken)).json.categories;
  for (const name of ['Recharge', 'Whole Recharge', 'Gift Cards']) {
    assert.ok(categories.some((c) => c.name === name), `${name} section exists`);
  }
});

test('buying cards on a purchase invoice tops the wallet up instead of stock', async () => {
  const w = (await req('POST', '/wallets', { name: 'Invoice test' }, adminToken)).json.wallet;
  const c = (
    await req(
      'POST',
      '/products',
      { name: 'Roblox $10', sku: 'CARD-TEST-ROBLOX', price: 11, cost: 9.5, wallet_id: w.id },
      adminToken,
    )
  ).json.product;

  const supplier = (await req('POST', '/suppliers', { name: 'Card dealer' }, adminToken)).json.party;
  const doc = (
    await req(
      'POST',
      '/documents',
      {
        docType: 'purchase_invoice',
        partyType: 'supplier',
        partyId: supplier.id,
        items: [{ productId: c.id, quantity: 10, price: 9.5 }],
      },
      adminToken,
    )
  ).json.document;

  await req('POST', `/documents/${doc.id}/confirm`, {}, adminToken);
  assert.equal(await balanceOf(w.id), 95, 'ten at $9.50 of credit bought');

  const product = (await req('GET', `/products/${c.id}`, null, adminToken)).json.product;
  assert.equal(product.stock, 0, 'credit is not a shelf');

  // And cancelling takes it back off, or the shop would hold credit twice.
  await req('POST', `/documents/${doc.id}/cancel`, {}, adminToken);
  assert.equal(await balanceOf(w.id), 0);
});

test('a pound wallet is charged in pounds and reported in dollars', async () => {
  const w = (
    await req('POST', '/wallets', { name: 'OMT float', currency: 'LBP', opening: 9000000 }, adminToken)
  ).json.wallet;
  const c = (
    await req(
      'POST',
      '/products',
      { name: 'Pound card', sku: 'CARD-TEST-LBP', price: 12, cost: 10, wallet_id: w.id },
      adminToken,
    )
  ).json.product;

  const rate = (await req('GET', '/settings', null, adminToken)).json.settings.exchange_rate;
  await req(
    'POST',
    '/orders',
    { items: [{ productId: c.id, quantity: 1 }], paymentMethod: 'card' },
    cashierToken,
  );

  assert.equal(await balanceOf(w.id), 9000000 - 10 * rate);

  const movements = (await req('GET', `/wallets/${w.id}/movements`, null, adminToken)).json.movements;
  const spend = movements.find((m) => m.kind === 'sale');
  assert.equal(spend.amount_usd, -10, 'the books stay in dollars whatever the wallet is kept in');
});

/**
 * What the credit cost the shop, and what that makes it worth.
 *
 * A distributor sells $100 of line for $88, and that discount is the entire
 * margin on sending credit to a customer. The column for it has always been
 * here and nothing ever filled it in: every top-up recorded as bought at face
 * value, so every dollar sent was costed at exactly what it was worth and the
 * profit screen reported the credit business earning nothing at all.
 */
test('a top-up can say what it actually cost, and the basis follows', async () => {
  const w = (await req('POST', '/wallets', { name: 'Discounted line' }, adminToken)).json.wallet;

  // Bought at face value until somebody says otherwise, which understates the
  // margin rather than inventing one.
  assert.equal((await req('GET', '/wallets', null, adminToken)).json.wallets.find((x) => x.id === w.id).cost_basis, 1);

  const res = await req(
    'POST',
    `/wallets/${w.id}/movements`,
    { kind: 'top_up', amount: 100, costUsd: 88 },
    adminToken,
  );
  assert.equal(res.status, 201);
  assert.equal(res.json.wallet.balance, 100, 'the balance is what arrived, not what was paid');
  assert.equal(res.json.wallet.cost_basis, 0.88, 'and a dollar of it cost 88 cents');
});

test('two top-ups at different prices average out', async () => {
  const w = (await req('POST', '/wallets', { name: 'Two prices' }, adminToken)).json.wallet;
  await req('POST', `/wallets/${w.id}/movements`, { kind: 'top_up', amount: 100, costUsd: 90 }, adminToken);
  await req('POST', `/wallets/${w.id}/movements`, { kind: 'top_up', amount: 100, costUsd: 80 }, adminToken);

  const wallet2 = (await req('GET', '/wallets', null, adminToken)).json.wallets.find((x) => x.id === w.id);
  assert.equal(wallet2.cost_basis, 0.85);
});

test('a top-up left blank still means face value, and does not drag the average', async () => {
  const w = (await req('POST', '/wallets', { name: 'Blank cost' }, adminToken)).json.wallet;
  await req('POST', `/wallets/${w.id}/movements`, { kind: 'top_up', amount: 100, costUsd: 50 }, adminToken);
  await req('POST', `/wallets/${w.id}/movements`, { kind: 'top_up', amount: 100 }, adminToken);

  // $50 + $100 paid for $200 of line.
  const wallet2 = (await req('GET', '/wallets', null, adminToken)).json.wallets.find((x) => x.id === w.id);
  assert.equal(wallet2.cost_basis, 0.75);
});

test('the cost is a purchase price, so it is ignored on the two that are not purchases', async () => {
  const w = (await req('POST', '/wallets', { name: 'Not a purchase' }, adminToken)).json.wallet;
  await req('POST', `/wallets/${w.id}/movements`, { kind: 'top_up', amount: 100, costUsd: 80 }, adminToken);

  await req('POST', `/wallets/${w.id}/movements`, { kind: 'withdrawal', amount: 10, costUsd: 5 }, adminToken);
  await req('POST', `/wallets/${w.id}/movements`, { kind: 'adjustment', amount: -5, costUsd: 5 }, adminToken);

  const wallet2 = (await req('GET', '/wallets', null, adminToken)).json.wallets.find((x) => x.id === w.id);
  assert.equal(wallet2.balance, 85, 'both moved the balance');
  assert.equal(wallet2.cost_basis, 0.8, 'and neither touched what the credit cost');
});

test('nonsense in the cost is refused rather than stored', async () => {
  const w = (await req('POST', '/wallets', { name: 'Bad cost' }, adminToken)).json.wallet;
  for (const bad of ['abc', -5]) {
    const res = await req(
      'POST',
      `/wallets/${w.id}/movements`,
      { kind: 'top_up', amount: 100, costUsd: bad },
      adminToken,
    );
    assert.equal(res.status, 400, `${bad} should be refused`);
  }
  assert.equal((await req('GET', '/wallets', null, adminToken)).json.wallets.find((x) => x.id === w.id).balance, 0);
});

test('credit sent to a customer is costed at what the credit cost, not at face value', async () => {
  const w = (
    await req('POST', '/wallets', { name: 'Alfa line', kind: 'recharge' }, adminToken)
  ).json.wallet;
  await req(
    'PUT',
    `/wallets/${w.id}`,
    { sendsCredit: true, smsFee: 0.15, creditPriceLbp: 110000 },
    adminToken,
  );
  await req('POST', `/wallets/${w.id}/movements`, { kind: 'top_up', amount: 100, costUsd: 80 }, adminToken);

  const quoted = await req('GET', `/credit/quote?walletId=${w.id}&amount=10`, null, adminToken);
  assert.equal(quoted.status, 200, JSON.stringify(quoted.json));
  assert.equal(quoted.json.costBasis, 0.8);

  /*
   * The whole point. Face value plus fees is what leaves the balance; 80% of it
   * is what the shop is really out of pocket, and the difference is the margin
   * the profit report was missing entirely.
   */
  assert.ok(quoted.json.cost > 10, 'the fees come off the same balance');
  assert.equal(
    Math.round(quoted.json.cost * 0.8 * 100) / 100,
    Math.round(quoted.json.realCost * 100) / 100,
  );
  assert.ok(quoted.json.realCost < quoted.json.cost, 'costed below face value');
});

/**
 * Three things that were settable on the server and on no screen.
 *
 * Whether a wallet can send credit at all, what the carrier charges a message,
 * and what a dollar of credit sells for in pounds. A shop whose carrier charges
 * something other than the built-in 15 cents had no way to say so, and every
 * quote at the counter was out by the difference.
 */
test('the fee the carrier charges is the shop\'s to set, and changes the quote', async () => {
  const w = (await req('POST', '/wallets', { name: 'Own fee', kind: 'recharge' }, adminToken)).json.wallet;
  await req('PUT', `/wallets/${w.id}`, { sendsCredit: true, smsFee: 0.15 }, adminToken);
  const cheap = (await req('GET', `/credit/quote?walletId=${w.id}&amount=10`, null, adminToken)).json;

  await req('PUT', `/wallets/${w.id}`, { smsFee: 0.5 }, adminToken);
  const dear = (await req('GET', `/credit/quote?walletId=${w.id}&amount=10`, null, adminToken)).json;

  assert.ok(dear.cost > cheap.cost, 'a dearer carrier costs the shop more');
  assert.equal(
    Math.round((dear.cost - cheap.cost) * 100) / 100,
    Math.round(cheap.smsCount * 0.35 * 100) / 100,
    'and the difference is exactly the fee, per message',
  );
});

test('a wallet that does not send credit is not offered for it', async () => {
  const w = (await req('POST', '/wallets', { name: 'Gift float', kind: 'gift_card' }, adminToken)).json.wallet;
  const res = await req('GET', `/credit/quote?walletId=${w.id}&amount=10`, null, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /not set up to send credit/);

  await req('PUT', `/wallets/${w.id}`, { sendsCredit: true }, adminToken);
  assert.equal((await req('GET', `/credit/quote?walletId=${w.id}&amount=10`, null, adminToken)).status, 200);
});

/**
 * Moving a shelf of cards onto the balance that actually funds them.
 *
 * The starter catalogue funds every recharge card from one shared "Mobile
 * recharge" balance, on the reasoning that recharge is recharge. That is wrong
 * for a shop holding two balances with its distributor — one for Alfa, one for
 * Touch: selling an Alfa card comes off the shared pot and the Alfa line never
 * moves, so neither figure is the truth and the shop stops believing both.
 *
 * The mechanism was never broken. A card has always spent whatever wallet it
 * names; it was the naming that had to be fixable in fewer than ninety dialogs.
 */
test('a card spends the wallet it names, whichever one that is', async () => {
  const alfa = (await req('POST', '/wallets', { name: 'Alfa distributor', kind: 'recharge' }, adminToken))
    .json.wallet;
  await req('POST', `/wallets/${alfa.id}/movements`, { kind: 'top_up', amount: 100 }, adminToken);

  const shared = (await req('POST', '/wallets', { name: 'Shared pot', kind: 'recharge' }, adminToken))
    .json.wallet;
  await req('POST', `/wallets/${shared.id}/movements`, { kind: 'top_up', amount: 100 }, adminToken);

  const card = (
    await req(
      'POST',
      '/products',
      { name: 'Alfa $7.58', sku: 'ALFA-758-X', price: 8, cost: 7.58, wallet_id: shared.id },
      adminToken,
    )
  ).json.product;

  // As seeded: the shared pot pays, and the Alfa line does not move.
  await req('POST', '/orders', { items: [{ productId: card.id, quantity: 1 }], paymentMethod: 'card' }, adminToken);
  let now = (await req('GET', '/wallets', null, adminToken)).json.wallets;
  assert.equal(now.find((w) => w.id === shared.id).balance, 92.42);
  assert.equal(now.find((w) => w.id === alfa.id).balance, 100, 'the Alfa line is untouched');

  // Moved onto Alfa, the next sale comes off Alfa instead.
  const moved = await req(
    'POST',
    '/products/paid-from',
    { productIds: [card.id], walletId: alfa.id },
    adminToken,
  );
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.wallet.name, 'Alfa distributor');
  assert.deepEqual(moved.json.moved.map((m) => m.name), ['Alfa $7.58']);

  await req('POST', '/orders', { items: [{ productId: card.id, quantity: 1 }], paymentMethod: 'card' }, adminToken);
  now = (await req('GET', '/wallets', null, adminToken)).json.wallets;
  assert.equal(now.find((w) => w.id === alfa.id).balance, 92.42, 'and now Alfa pays');
  assert.equal(now.find((w) => w.id === shared.id).balance, 92.42, 'the shared pot stayed put');
});

test('a whole shelf moves in one request', async () => {
  const touch = (await req('POST', '/wallets', { name: 'Touch line', kind: 'recharge' }, adminToken))
    .json.wallet;
  const ids = [];
  for (const value of ['379', '450', '758']) {
    const made = await req(
      'POST',
      '/products',
      { name: `Touch $${value}`, sku: `TOUCH-${value}-X`, price: 5, cost: 4 },
      adminToken,
    );
    ids.push(made.json.product.id);
  }

  const moved = await req('POST', '/products/paid-from', { productIds: ids, walletId: touch.id }, adminToken);
  assert.equal(moved.status, 200);
  assert.equal(moved.json.moved.length, 3);

  const products = (await req('GET', '/products', null, adminToken)).json.products;
  for (const id of ids) {
    assert.equal(products.find((p) => p.id === id).wallet_id, touch.id);
  }
});

test('one card that cannot take a wallet stops the whole move', async () => {
  const touch = (await req('GET', '/wallets', null, adminToken)).json.wallets.find(
    (w) => w.name === 'Touch line',
  );
  const ordinary = (
    await req(
      'POST',
      '/products',
      { name: 'Plain card', sku: 'PLAIN-1', price: 5, cost: 4 },
      adminToken,
    )
  ).json.product;
  const handset = (
    await req(
      'POST',
      '/products',
      { name: 'A phone', sku: 'PHONE-W', price: 200, cost: 170, tracks_units: true },
      adminToken,
    )
  ).json.product;

  const refused = await req(
    'POST',
    '/products/paid-from',
    { productIds: [ordinary.id, handset.id], walletId: touch.id },
    adminToken,
  );
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /A phone/);

  /*
   * And the one that could have moved did not. Half a shelf moved is two wrong
   * balances instead of one, and nothing on screen would say which half.
   */
  const products = (await req('GET', '/products', null, adminToken)).json.products;
  assert.equal(products.find((p) => p.id === ordinary.id).wallet_id, null);
});

test('a closed wallet is refused rather than quietly used', async () => {
  const spare = (await req('POST', '/wallets', { name: 'Old line', kind: 'recharge' }, adminToken))
    .json.wallet;
  await req('DELETE', `/wallets/${spare.id}`, null, adminToken);
  const card = (
    await req('POST', '/products', { name: 'Any card', sku: 'ANY-1', price: 5, cost: 4 }, adminToken)
  ).json.product;

  const refused = await req(
    'POST',
    '/products/paid-from',
    { productIds: [card.id], walletId: spare.id },
    adminToken,
  );
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /closed/);
});

test('a cashier cannot move what the shop is funded from', async () => {
  const refused = await req('POST', '/products/paid-from', { productIds: [1], walletId: 1 }, cashierToken);
  assert.equal(refused.status, 403);
});

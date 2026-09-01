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
  const tills = (await req('GET', '/accounts/registry', null, adminToken, saida.id)).json.registry.cash;
  assert.ok(tills.some((t) => t.name.includes('Saida')), 'opening a branch that cannot take money is not opening');
});

test('and that till is not offered at the other branch’s counter', async () => {
  /*
   * A drawer is a physical thing standing in one shop. Offering Saida's safe in
   * a picker on the main counter is how money comes to be recorded as moving
   * somewhere it cannot have moved.
   */
  const here = (await req('GET', '/accounts/registry', null, adminToken, mainBranch.id)).json.registry.cash;
  assert.ok(!here.some((t) => t.name.includes('Saida')), 'the other shop’s drawer is not on this counter');
  assert.ok(here.length > 0, 'but this one’s own till still is');

  // The owner can still see the whole company when they ask for it.
  const all = (await req('GET', '/accounts/registry?branch=all', null, adminToken, mainBranch.id))
    .json.registry.cash;
  assert.ok(all.some((t) => t.name.includes('Saida')), 'branch=all is the owner looking at everything');
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

test('the inventory screen counts the shelf you are standing at', async () => {
  /*
   * The bug this closes, reported from the shop: goods imported at one branch
   * showed up as the same quantity on both screens.
   *
   * `products.stock` is the company-wide mirror — what is owned altogether —
   * and the inventory screen was reading it. So the one screen whose job is to
   * answer "what do I need to order here" was answering with stock nobody at
   * that counter could sell.
   */
  const before = {
    here: (await req('GET', '/inventory', null, adminToken, mainBranch.id)).json.totals.units,
    there: (await req('GET', '/inventory', null, adminToken, saida.id)).json.totals.units,
  };

  const made = await makeProduct(12);

  const here = (await req('GET', '/inventory', null, adminToken, mainBranch.id)).json;
  const there = (await req('GET', '/inventory', null, adminToken, saida.id)).json;
  const mine = here.products.find((p) => p.id === made.id);
  const theirs = there.products.find((p) => p.id === made.id);

  assert.equal(mine.stock, 12, 'twelve here');
  assert.equal(theirs.stock, 0, 'and none at the other counter');
  assert.equal(theirs.total_stock, 12, 'which says where the rest of them are');

  // The value on hand is this branch's too, or the same goods are counted twice.
  assert.equal(here.totals.units - before.here, 12);
  assert.equal(there.totals.units - before.there, 0);
});

test('and the owner can still ask for the whole company at once', async () => {
  const made = await makeProduct(7);

  const all = (await req('GET', '/inventory?branch=all', null, adminToken, saida.id)).json;
  assert.equal(
    all.products.find((p) => p.id === made.id).stock,
    7,
    'seven, wherever in the company they are standing',
  );
});

test('a stock correction belongs to the counter it was made at', async () => {
  const made = await makeProduct(4);

  const adjusted = await req(
    'POST',
    '/inventory/adjust',
    { productId: made.id, delta: -1, reason: 'damaged' },
    adminToken,
    mainBranch.id,
  );
  assert.equal(adjusted.status, 200, JSON.stringify(adjusted.json));

  const mine = (
    await req('GET', `/inventory/movements?productId=${made.id}`, null, adminToken, mainBranch.id)
  ).json.movements;
  const theirs = (
    await req('GET', `/inventory/movements?productId=${made.id}`, null, adminToken, saida.id)
  ).json.movements;

  assert.ok(mine.some((m) => m.delta === -1), 'the correction is in this branch’s history');
  assert.equal(theirs.length, 0, 'and not in the other branch’s, where nobody touched it');
});

test('money asleep on the shelf is this branch’s shelf', async () => {
  /*
   * The same mistake in the reports: "what am I stuck with" was answered from
   * the company-wide mirror, so a branch manager was shown the value of stock
   * standing in the other shop.
   */
  /* Priced high on purpose: the report is the ten most expensive things
     standing still, and this file has stocked plenty of cheaper ones. */
  const made = (
    await req(
      'POST',
      '/products',
      { name: 'Unsold showcase', sku: 'BR-SLOW-1', price: 900, cost: 700, stock: 9 },
      adminToken,
      mainBranch.id,
    )
  ).json.product;

  const mine = (await req('GET', '/reports/summary', null, adminToken, mainBranch.id)).json;
  const theirs = (await req('GET', '/reports/summary', null, adminToken, saida.id)).json;

  assert.ok(
    mine.slowMovers.some((p) => p.id === made.id),
    'nine of them sitting here, unsold',
  );
  assert.ok(
    !theirs.slowMovers.some((p) => p.id === made.id),
    'and nothing sitting at the branch that has none of them',
  );

  const all = (await req('GET', '/reports/summary?branch=all', null, adminToken, saida.id)).json;
  assert.ok(
    all.slowMovers.some((p) => p.id === made.id),
    'the owner asking about the whole company still sees them',
  );
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

test('a sale parked at one branch is checked against that branch’s shelf', async () => {
  /*
   * A hold reserves nothing, so what has changed underneath it is worked out
   * when somebody picks it up. That check was reading `products.stock` — the
   * company-wide mirror — so a sale parked at the shop with none of something
   * came back saying it was all in stock, and the cashier found out at the
   * moment they tried to take the money.
   */
  const made = await makeProduct(6); // six at the main shop, none at Saida

  const cart = [
    {
      lineKey: String(made.id),
      productId: made.id,
      unitId: null,
      name: made.name,
      sku: made.sku,
      price: made.price,
      quantity: 2,
    },
  ];

  const parked = await req('POST', '/held-sales', { cart }, adminToken, saida.id);
  assert.equal(parked.status, 201, JSON.stringify(parked.json));

  const back = await req(
    'POST',
    `/held-sales/${parked.json.held.id}/resume`,
    null,
    adminToken,
    saida.id,
  );
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(back.json.issues.length, 1, 'six at the other shop are not on this shelf');
  assert.equal(back.json.issues[0].severity, 'gone');
  assert.equal(back.json.issues[0].available, 0);
});

test('and the same sale parked where the stock is comes back clean', async () => {
  const made = await makeProduct(6);

  const cart = [
    {
      lineKey: String(made.id),
      productId: made.id,
      unitId: null,
      name: made.name,
      sku: made.sku,
      price: made.price,
      quantity: 2,
    },
  ];

  const parked = await req('POST', '/held-sales', { cart }, adminToken, mainBranch.id);
  const back = await req(
    'POST',
    `/held-sales/${parked.json.held.id}/resume`,
    null,
    adminToken,
    mainBranch.id,
  );

  assert.deepEqual(back.json.issues, [], 'nothing moved, so nothing to report');
});

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

test('a whole shelf booked in at the wrong counter can be sent in one go', async () => {
  /*
   * The mistake this exists for, reported from the shop: a catalogue imported
   * while standing at the second branch. The stock is not wrong, it is in the
   * wrong place — and searching for ninety-seven products one at a time to put
   * it right is how a shop decides to leave it where it is.
   */
  const cable = await makeProduct(0);
  const glass = await makeProduct(0);

  // Booked in at Saida, which is the mistake.
  for (const [item, qty] of [[cable, 40], [glass, 120]]) {
    const put = await req(
      'POST',
      '/inventory/adjust',
      { productId: item.id, delta: qty, reason: 'received' },
      adminToken,
      saida.id,
    );
    assert.equal(put.status, 200, JSON.stringify(put.json));
  }

  const sent = await req(
    'POST',
    '/stock-transfers',
    { toBranchId: mainBranch.id, everything: true, note: 'imported at the wrong branch' },
    adminToken,
    saida.id,
  );
  assert.equal(sent.status, 201, JSON.stringify(sent.json));

  const lines = sent.json.transfer.items;
  const sentQty = Object.fromEntries(lines.map((l) => [l.product_id, l.quantity]));
  assert.equal(sentQty[cable.id], 40, 'all forty, not one');
  assert.equal(sentQty[glass.id], 120);

  // It has left that shelf, which is what sending means.
  assert.equal((await product(cable.sku, saida.id)).stock, 0);
  assert.equal((await product(glass.sku, saida.id)).stock, 0);

  const got = await req(
    'POST',
    `/stock-transfers/${sent.json.transfer.id}/receive`,
    null,
    adminToken,
    mainBranch.id,
  );
  assert.equal(got.status, 200, JSON.stringify(got.json));
  assert.equal((await product(cable.sku, mainBranch.id)).stock, 40, 'and arrived where it belongs');
  assert.equal((await product(glass.sku, mainBranch.id)).stock, 120);
});

test('and it carries the handsets by number, not as a quantity', async () => {
  /*
   * A serialised product's stock *is* the phones in it, so "three of these" is
   * not a thing that can be sent. Each one goes as its own line, or the shelf
   * and the shelf's IMEIs stop agreeing.
   */
  const csv = [
    'Item,#,SN,Price 1,Currency 1,Average cost,Currency,Qty,Family,Barcode',
    'PIXEL 7 128GB,BR-P7-1,351000000000001,500,USD,400,USD,1,CELLPHONES,',
    'PIXEL 7 128GB,BR-P7-2,351000000000002,500,USD,400,USD,1,CELLPHONES,',
    'PIXEL 7 128GB,BR-P7-3,351000000000003,500,USD,400,USD,1,CELLPHONES,',
  ].join('\n');

  // Imported at Saida — the mistake, in the shape it actually arrived in.
  const done = await req('POST', '/imports/commit', { csv }, adminToken, saida.id);
  assert.equal(done.json.handsets, 3, JSON.stringify(done.json));

  const phone = (await req('GET', '/products', null, adminToken, saida.id)).json.products.find(
    (p) => p.name === 'PIXEL 7 128GB',
  );
  assert.equal(phone.stock, 3, 'three phones at the wrong branch');

  const sent = await req(
    'POST',
    '/stock-transfers',
    { toBranchId: mainBranch.id, everything: true },
    adminToken,
    saida.id,
  );
  assert.equal(sent.status, 201, JSON.stringify(sent.json));

  const handsetLines = sent.json.transfer.items.filter((l) => l.product_id === phone.id);
  assert.equal(handsetLines.length, 3, 'one line per phone');
  assert.ok(handsetLines.every((l) => l.unit_id && l.quantity === 1), 'each by its own number');

  assert.equal(
    (await req('GET', '/products', null, adminToken, saida.id)).json.products.find(
      (p) => p.id === phone.id,
    ).stock,
    0,
    'and none of them left behind',
  );
});

test('sending everything from an empty shelf says so rather than sending nothing', async () => {
  const empty = (await req('POST', '/branches', { name: 'Tripoli' }, adminToken)).json.branch;

  const res = await req(
    'POST',
    '/stock-transfers',
    { toBranchId: mainBranch.id, everything: true },
    adminToken,
    empty.id,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /nothing on the shelf/i);
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

/* ------------------------------------------------ what must not be shared */

/*
 * The paperwork, the takings and the money.
 *
 * Stock was separated from the beginning; these were not, and every one of them
 * showed a branch manager the other shop's trade as though it were their own.
 * Each test below asks the same three questions: is it mine here, is it absent
 * there, and can the owner still see the whole company when they ask.
 */

/** A document raised at one counter. */
async function raise(branch, docType, party) {
  const made = await req(
    'POST',
    '/documents',
    { docType, partyId: party, items: [{ productId: sharedProduct.id, quantity: 1, price: 5 }] },
    adminToken,
    branch,
  );
  assert.equal(made.status, 201, JSON.stringify(made.json));
  return made.json.document;
}

const docsAt = async (branch, type, query = '') =>
  (await req('GET', `/documents?type=${type}${query}`, null, adminToken, branch)).json.documents;

let sharedProduct;
let customerId;
let supplierId;

test('setting up a customer, a supplier and something to sell', async () => {
  sharedProduct = await makeProduct(50, mainBranch.id);
  customerId = (await req('POST', '/customers', { name: 'Branch buyer' }, adminToken)).json.party.id;
  supplierId = (await req('POST', '/suppliers', { name: 'Branch seller' }, adminToken)).json.party.id;
  assert.ok(sharedProduct && customerId && supplierId);
});

for (const [docType, label] of [
  ['sales_invoice', 'a sales invoice'],
  ['quotation', 'a quotation'],
  ['purchase_invoice', 'a purchase invoice'],
]) {
  test(`${label} raised at one branch is not the other branch's`, async () => {
    const party = docType === 'purchase_invoice' ? supplierId : customerId;
    const here = await raise(mainBranch.id, docType, party);
    const there = await raise(saida.id, docType, party);

    const mine = await docsAt(mainBranch.id, docType);
    assert.ok(mine.some((d) => d.id === here.id), 'the one raised here is here');
    assert.ok(
      !mine.some((d) => d.id === there.id),
      `${label} raised at Saida is showing on the main counter`,
    );

    const theirs = await docsAt(saida.id, docType);
    assert.ok(theirs.some((d) => d.id === there.id), 'and theirs is theirs');
    assert.ok(!theirs.some((d) => d.id === here.id), 'and not ours');

    // The owner, asking about the company rather than a counter.
    const all = await docsAt(mainBranch.id, docType, '&branch=all');
    assert.ok(
      all.some((d) => d.id === here.id) && all.some((d) => d.id === there.id),
      'branch=all is the whole company',
    );
  });
}

test('a sale rung up at one register is not on the other register’s list', async () => {
  const sell = async (branch) => {
    await req('POST', '/cash/open', { openingUsd: 50 }, adminToken, branch);
    const sale = await req(
      'POST',
      '/orders',
      {
        items: [{ productId: sharedProduct.id, quantity: 1 }],
        paymentMethod: 'cash',
        payments: [{ currency: 'USD', amount: 20 }],
      },
      adminToken,
      branch,
    );
    return sale.json.order;
  };

  // Stock has to be on the shelf it is sold from.
  await req(
    'POST',
    '/stock-transfers',
    { toBranchId: saida.id, items: [{ productId: sharedProduct.id, quantity: 5 }] },
    adminToken,
    mainBranch.id,
  );
  const sent = (await req('GET', '/stock-transfers', null, adminToken, saida.id)).json.transfers[0];
  await req('POST', `/stock-transfers/${sent.id}/receive`, { items: [] }, adminToken, saida.id);

  const hereSale = await sell(mainBranch.id);
  const thereSale = await sell(saida.id);
  assert.ok(hereSale && thereSale, 'both counters took a sale');

  const mine = (await req('GET', '/orders', null, adminToken, mainBranch.id)).json.orders;
  assert.ok(mine.some((o) => o.id === hereSale.id), 'ours is ours');
  assert.ok(!mine.some((o) => o.id === thereSale.id), 'the other register’s sale is not on this list');

  const all = (await req('GET', '/orders?branch=all', null, adminToken, mainBranch.id)).json.orders;
  assert.ok(all.some((o) => o.id === thereSale.id), 'and the owner can still see both');
});

test('the cash-flow feed is the branch’s own movements', async () => {
  /*
   * The balance is deliberately *not* split — a customer owes the shop, not the
   * counter they stood at — but what moved, and where, is exactly what this
   * feed is for.
   */
  const charged = await req(
    'POST',
    `/customers/${customerId}/charges`,
    { amount: 25, note: 'Paid at Saida' },
    adminToken,
    saida.id,
  );
  assert.equal(charged.status, 201, JSON.stringify(charged.json));

  const here = (await req('GET', '/accounts/entries', null, adminToken, mainBranch.id)).json.entries;
  assert.ok(
    !here.some((e) => e.note === 'Paid at Saida'),
    'money moving at Saida is not on the main counter’s feed',
  );

  const there = (await req('GET', '/accounts/entries', null, adminToken, saida.id)).json.entries;
  assert.ok(there.some((e) => e.note === 'Paid at Saida'), 'it is on Saida’s');

  const all = (await req('GET', '/accounts/entries?branch=all', null, adminToken, mainBranch.id))
    .json.entries;
  assert.ok(all.some((e) => e.note === 'Paid at Saida'), 'and the owner sees the company');
});

test('nothing written lands in no branch at all', async () => {
  /*
   * The failure worth guarding: an entry with no branch is invisible in every
   * feed and present in none, which is worse than not separating them. Seventeen
   * places write these, so the default lives in addEntry rather than in each
   * caller remembering.
   */
  const orphans = (await req('GET', '/accounts/entries?branch=all&limit=500', null, adminToken))
    .json.entries.filter((e) => e.branch_id === null);
  assert.equal(orphans.length, 0, `${orphans.length} entries belong to no branch`);
});

/**
 * Which counter somebody stands at, said once when they are hired.
 *
 * `users.branch_id` and `setUserBranch` have been here since branches were
 * built, and nothing ever called them — so there was no way to put anybody
 * anywhere. Every account opened at the main branch, and a shop with a second
 * one had to tell its Saida cashier to switch every morning, which is a thing
 * a cashier cannot do: they are pinned, deliberately.
 *
 * Two different jobs, from the one setting:
 *
 *  - for a cashier it is a **pin** — every request is answered with their own
 *    branch whatever the browser asks for, which is what stops one selling off
 *    the other shop's shelf;
 *  - for somebody who may switch it is where they **open**, with the picker
 *    still there for the days they are somewhere else.
 */
let saidaClerk;

test('somebody can be hired straight onto a branch', async () => {
  const made = await req(
    'POST',
    '/users',
    {
      name: 'Saida clerk',
      username: 'saidaclerk',
      password: 'counter123',
      role: 'cashier',
      branchId: saida.id,
      permissions: ['register'],
    },
    adminToken,
  );
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.user.branch_id, saida.id);
  assert.equal(made.json.user.branch_name, saida.name, 'named, so the list can be read');
  saidaClerk = made.json.user;
});

test('and they open at that branch without touching anything', async () => {
  const token = (
    await req('POST', '/auth/login', { username: 'saidaclerk', password: 'counter123' })
  ).json.token;

  /*
   * No branch asked for — a browser that has never been signed into before, or
   * one somebody else was using. The server answers with where they work.
   */
  const where = await req('GET', '/branches', null, token);
  assert.equal(where.json.current, saida.id, 'they open at their own counter');
  assert.equal(where.json.home, saida.id);
  assert.equal(where.json.canSwitch, false);
  assert.equal(where.json.branches.length, 1, 'and see one shop, not a menu');
});

test('a machine still asking for the other branch does not move them', async () => {
  const token = (
    await req('POST', '/auth/login', { username: 'saidaclerk', password: 'counter123' })
  ).json.token;

  // Exactly what a shared counter computer sends after the owner used it.
  const where = await req('GET', '/branches', null, token, mainBranch.id);
  assert.equal(where.json.current, saida.id, 'pinned, whatever the browser asks for');
});

test('the list says where everybody works', async () => {
  const { json } = await req('GET', '/users', null, adminToken);
  const clerk = json.users.find((u) => u.username === 'saidaclerk');
  assert.equal(clerk.branch_name, saida.name);

  // Null is the main branch, which is what everybody else still is.
  const admin = json.users.find((u) => u.username === 'admin');
  assert.equal(admin.branch_id, null);
  assert.equal(admin.branch_name, null);
});

test('somebody already hired can be moved to another counter', async () => {
  const moved = await req('PUT', `/users/${saidaClerk.id}/branch`, { branchId: null }, adminToken);
  assert.equal(moved.status, 200);
  assert.equal(moved.json.user.branch_id, null);

  const token = (
    await req('POST', '/auth/login', { username: 'saidaclerk', password: 'counter123' })
  ).json.token;
  assert.equal((await req('GET', '/branches', null, token)).json.current, mainBranch.id);

  // And back, because "for a fortnight" is the usual reason.
  await req('PUT', `/users/${saidaClerk.id}/branch`, { branchId: saida.id }, adminToken);
  assert.equal((await req('GET', '/branches', null, token)).json.current, saida.id);
});

test('a branch that does not exist is refused, not stored', async () => {
  const bad = await req('PUT', `/users/${saidaClerk.id}/branch`, { branchId: 9999 }, adminToken);
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /does not exist/);

  const { json } = await req('GET', '/users', null, adminToken);
  assert.equal(json.users.find((u) => u.id === saidaClerk.id).branch_id, saida.id, 'left alone');
});

test('a closed branch is refused rather than silently ignored', async () => {
  const spare = (await req('POST', '/branches', { name: 'Tyre' }, adminToken)).json.branch;
  await req('DELETE', `/branches/${spare.id}`, null, adminToken);

  const bad = await req('PUT', `/users/${saidaClerk.id}/branch`, { branchId: spare.id }, adminToken);
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /closed/);
});

test('only somebody who manages staff can move people about', async () => {
  const refused = await req(
    'PUT',
    `/users/${saidaClerk.id}/branch`,
    { branchId: null },
    cashierToken,
  );
  assert.equal(refused.status, 403);
});

test('a cashier put at a branch sells off that branch\'s shelf, not the main one', async () => {
  const made = await makeProduct(3);
  // Four more at Saida, where the clerk actually stands.
  await req(
    'POST',
    '/inventory/adjust',
    { productId: made.id, delta: 4, reason: 'received' },
    adminToken,
    saida.id,
  );

  const token = (
    await req('POST', '/auth/login', { username: 'saidaclerk', password: 'counter123' })
  ).json.token;
  const seen = await req('GET', `/products/lookup?code=${made.sku}`, null, token);
  assert.equal(seen.json.product.stock, 4, 'the Saida shelf, without asking for it');
});

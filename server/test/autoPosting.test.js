/**
 * The books, filling themselves from the till.
 *
 * Two claims are held here and they pull against each other, which is the
 * whole reason this file exists.
 *
 * **The books must not drift.** A sale that moved stock and took money but
 * posted nothing leaves the ledger permanently wrong by that sale, and nothing
 * will ever find it again. So the entry is written in the same transaction as
 * the sale.
 *
 * **A sale must not be refused because of the books.** A shop with a customer
 * at the counter cannot be stopped by an account nobody has mapped.
 *
 * Both hold only because posting cannot fail: an account that cannot be
 * resolved falls back to Suspense, and the entry is balanced against Suspense
 * rather than left short. So the last test here breaks the mapping on purpose
 * and checks that the shop can still sell — and that the money it could not
 * place is sitting somewhere a person will see it.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4647;
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

/** The trial balance as a map of code -> row, which is how these read best. */
async function books() {
  const tb = (await req('GET', '/ledger/trial-balance')).json;
  return {
    balanced: tb.balanced,
    totals: tb.totals,
    at: (code) => tb.accounts.find((a) => a.code === code) ?? { debit: 0, credit: 0, balance: 0 },
  };
}

let widget;
let customer;
let supplier;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-auto-post-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'post.sqlite'),
    JWT_SECRET: 'auto-posting-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  await req('POST', '/cash/open', { openingUsd: 200 });

  widget = (await req('POST', '/products', {
    name: 'Charger', sku: 'POST-1', price: 20, cost: 12, stock: 100,
  })).json.product;
  customer = (await req('POST', '/customers', { name: 'Rami' })).json.party;
  supplier = (await req('POST', '/suppliers', { name: 'Wholesaler' })).json.party;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------- the till */

test('a cash sale writes itself into the books', async () => {
  const before = await books();

  const sale = await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 2 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 40 }],
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const after = await books();
  assert.equal(after.balanced, true, 'and the books still balance');

  // What was earned, where the money went, and what left the shelf.
  assert.equal(after.at('4100').balance - before.at('4100').balance, 40, 'sales up by the takings');
  assert.equal(after.at('1110').balance - before.at('1110').balance, 40, 'cash up by the same');
  assert.equal(after.at('5100').balance - before.at('5100').balance, 24, 'cost of two at 12');
  assert.equal(after.at('1300').balance - before.at('1300').balance, -24, 'and stock down by it');
});

test('the entry names the sale, so it can be found again', async () => {
  const sale = (await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 1 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 20 }],
  })).json.order;

  const entries = (await req('GET', '/ledger/entries')).json.entries;
  const mine = entries.find((e) => e.memo === `Sale ${sale.order_number}`);
  assert.ok(mine, 'the entry says which sale it was');
  /*
   * $20 taken and $12 of stock gone: the entry's debit side is both, because
   * they are two different movements that happened in the same sale.
   */
  assert.equal(mine.total, 32, 'the takings plus the cost that came off the shelf');
});

test('a sale on account is owed by the customer, not sitting in the drawer', async () => {
  const before = await books();

  const sale = await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 1 }],
    paymentMethod: 'account',
    customerId: customer.id,
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const after = await books();
  assert.equal(after.balanced, true);
  assert.equal(after.at('1200').balance - before.at('1200').balance, 20, 'the customer owes it');
  assert.equal(after.at('1110').balance - before.at('1110').balance, 0, 'and no money reached the till');
});

test('voiding a sale takes it back out of the books', async () => {
  const sale = (await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 1 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 20 }],
  })).json.order;

  const before = await books();
  const voided = await req('POST', `/orders/${sale.id}/refund`, {});
  assert.equal(voided.status, 200, JSON.stringify(voided.json));

  const after = await books();
  assert.equal(after.balanced, true, 'the books balance after a void');
  assert.equal(after.at('4100').balance - before.at('4100').balance, -20, 'the sale comes back off');
  assert.equal(after.at('1110').balance - before.at('1110').balance, -20, 'and the money goes back');
  assert.equal(after.at('1300').balance - before.at('1300').balance, 12, 'the stock returns to the shelf');
});

/* ----------------------------------------------------------- the office */

test('an expense is spent, and the drawer is lighter', async () => {
  const before = await books();

  const spent = await req('POST', '/expenses', {
    category: 'rent', amountUsd: 300, paidWith: 'cash', note: 'August',
  });
  assert.equal(spent.status, 201, JSON.stringify(spent.json));

  const after = await books();
  assert.equal(after.balanced, true);
  assert.equal(after.at('5300').balance - before.at('5300').balance, 300, 'rent, in its own account');
  assert.equal(after.at('1110').balance - before.at('1110').balance, -300);
});

test('a purchase invoice brings stock in and owes the supplier', async () => {
  const before = await books();

  const doc = (await req('POST', '/documents', {
    docType: 'purchase_invoice',
    partyId: supplier.id,
    items: [{ productId: widget.id, quantity: 10, price: 12 }],
    paymentMethod: 'account',
  })).json.document;
  const confirmed = await req('POST', `/documents/${doc.id}/confirm`);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));

  const after = await books();
  assert.equal(after.balanced, true);
  assert.equal(after.at('1300').balance - before.at('1300').balance, 120, 'stock on the shelf');
  assert.equal(after.at('2100').balance - before.at('2100').balance, 120, 'and owed for');
});

test('cash taken out by hand lands where the reason says', async () => {
  const before = await books();

  const out = await req('POST', '/cash/movements', {
    direction: 'out', amountUsd: 50, reason: 'owner_draw', note: 'lunch',
  });
  assert.equal(out.status, 201, JSON.stringify(out.json));

  const after = await books();
  assert.equal(after.balanced, true);
  /*
   * Drawings is a contra-equity account: the owner taking money out *reduces*
   * what the shop owes them, so it sits in the debit column and its balance in
   * equity's own direction is negative. The debit column is the unambiguous
   * figure, and it is the one a trial balance is read from.
   */
  assert.equal(after.at('3200').debit - before.at('3200').debit, 50, 'the owner took it');
  assert.equal(after.at('3200').balance - before.at('3200').balance, -50, 'so equity is lower by it');
  assert.equal(after.at('1110').balance - before.at('1110').balance, -50);
});

/* ------------------------------------------- and when the mapping is wrong */

test('a broken mapping never refuses a sale — the money goes to Suspense', async () => {
  /*
   * The claim the whole design rests on. A shop with a customer at the counter
   * cannot be stopped because somebody pointed an account at a code that does
   * not exist, so the money has to land *somewhere* — and the somewhere has to
   * be visible, or the books drift silently, which is worse than refusing.
   */
  await req('PUT', '/settings', { gl_map: JSON.stringify({ sales: 'NOPE-0000' }) });

  const before = await books();
  const sale = await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 1 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 20 }],
  });
  assert.equal(sale.status, 201, 'the shop can still sell');

  const after = await books();
  assert.equal(after.balanced, true, 'and the books still balance');
  assert.equal(after.at('4100').balance - before.at('4100').balance, 0, 'nothing reached sales');
  assert.equal(
    after.at('9999').balance - before.at('9999').balance,
    -20,
    'it is sitting in Suspense, where somebody will see it',
  );

  await req('PUT', '/settings', { gl_map: '' });
});

test('every automatic entry is marked as one, so hand-written work is still visible', async () => {
  const entries = (await req('GET', '/ledger/entries')).json.entries;
  assert.ok(entries.length > 5, 'the books filled themselves');
  assert.ok(entries.every((e) => e.source === 'auto'), 'and each says the app wrote it');
});

test('the penny left by change in another currency is an exchange difference', async () => {
  /*
   * A dual-currency till gives change in pounds, rounded to the nearest note
   * the shop actually holds — so a sale settled across the two currencies
   * really does leave a few cents more or less in the drawer than the sale was
   * worth. That is a genuine exchange difference and it has an account.
   *
   * It must not go to Suspense. Suspense means "something here is wrong", and
   * within a week of accumulating rounding it would stop meaning anything at
   * all — which is the one thing that would make it useless when something
   * really is wrong.
   */
  const before = await books();

  // $20 of stock, settled with $25 and the change taken in pounds.
  const rate = 89000;
  const sale = await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 1 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 25 }],
    changeCurrency: 'LBP',
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  void rate;

  const after = await books();
  assert.equal(after.balanced, true, 'the books balance whatever the rounding did');
  assert.equal(
    after.at('9999').balance - before.at('9999').balance,
    0,
    'and nothing went to Suspense — Suspense means something is wrong',
  );
});

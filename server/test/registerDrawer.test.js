/**
 * Which pile of money the register rings into, and where it goes at close.
 *
 * A shop with a counter drawer and an office safe made the safe the account
 * every screen falls back to — which is right for the back office and was
 * quietly wrong for the counter. Every sale rung up went straight into the
 * safe. The cashier then counted a physical drawer at the end of the shift
 * against a figure that included every invoice the office had settled that
 * afternoon, and the count agreed with nothing.
 *
 * So the register is tied to the **drawer**, and only to the drawer. What the
 * back office does — paying a supplier, taking a payment on an invoice written
 * away from the counter — goes to the shop's standing cash account.
 *
 * And the two are joined at close: the notes lifted out of the drawer at the
 * end of a shift land in that standing account, because they physically do.
 * Recording only the half where the drawer emptied is how a day's takings
 * could disappear between one screen and the next.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4642;
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
let safe;
let supplier;
let customer;
let widget;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-register-drawer-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'register.sqlite'),
    JWT_SECRET: 'register-drawer-secret-long-enough-for-the-guard',
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

  safe = (await req('POST', '/accounts/cash', { name: 'Office safe', kind: 'safe' })).json.account;
  await req('PUT', `/accounts/cash/${safe.id}`, { isDefault: true });

  supplier = (await req('POST', '/suppliers', { name: 'Wholesaler' })).json.party;
  customer = (await req('POST', '/customers', { name: 'Rami' })).json.party;
  widget = (await req('POST', '/products', {
    name: 'Widget', sku: 'REG-001', price: 10, cost: 6, stock: 500,
  })).json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** What an account holds, as the Accounts screen reads it. */
async function balanceOf(accountId) {
  const registry = (await req('GET', '/accounts/registry')).json.registry;
  return registry.cash.find((a) => a.id === accountId)?.balance ?? null;
}

/** Both piles added up — the shop's cash on hand, wherever it is sitting. */
async function cashOnHand() {
  return (await balanceOf(drawer.id)) + (await balanceOf(safe.id));
}

test('the register asks about its own drawer, not the shop’s default account', async () => {
  /*
   * The panel on the register names no account, and what it means by "the
   * cashbox" is the box in front of the cashier. It used to mean whichever
   * account was the default, so on this shop the register's own panel was a
   * window onto the safe — and "open the cashbox" opened the safe.
   */
  const current = await req('GET', '/cash/current');
  assert.equal(current.json.accountId, drawer.id, 'the register means the drawer');
  assert.notEqual(current.json.accountId, safe.id);
});

test('a sale at the register lands in the drawer, and nowhere else', async () => {
  const opened = await req('POST', '/cash/open', { openingUsd: 50 });
  assert.equal(opened.status, 201, JSON.stringify(opened.json));
  assert.equal(opened.json.session.account_id, drawer.id, 'and it opened the drawer');

  const safeBefore = await balanceOf(safe.id);
  const drawerBefore = await balanceOf(drawer.id);

  const sale = await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 3 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 30 }],
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  assert.equal(await balanceOf(drawer.id), drawerBefore + 30, 'the notes are in the drawer');
  assert.equal(await balanceOf(safe.id), safeBefore, 'and the safe never saw them');
});

test('a supplier paid from the back office comes out of the standing account', async () => {
  const safeBefore = await balanceOf(safe.id);
  const drawerBefore = await balanceOf(drawer.id);

  const paid = await req('POST', `/suppliers/${supplier.id}/payments`, {
    payments: [{ currency: 'USD', amount: 20 }],
  });
  assert.equal(paid.status, 201, JSON.stringify(paid.json));

  assert.equal(await balanceOf(safe.id), safeBefore - 20, 'the safe is $20 lighter');
  assert.equal(await balanceOf(drawer.id), drawerBefore, 'the counter drawer is untouched');
});

test('a customer settling an invoice away from the counter pays into the standing account', async () => {
  const safeBefore = await balanceOf(safe.id);
  const drawerBefore = await balanceOf(drawer.id);

  const received = await req('POST', `/customers/${customer.id}/payments`, {
    payments: [{ currency: 'USD', amount: 45 }],
  });
  assert.equal(received.status, 201, JSON.stringify(received.json));

  assert.equal(await balanceOf(safe.id), safeBefore + 45, 'the money is in the safe');
  assert.equal(await balanceOf(drawer.id), drawerBefore, 'not in the cashier’s drawer');
});

test('closing the drawer moves what is in it into the standing account', async () => {
  /*
   * The thing the shop actually asked for, and the reason it matters: the
   * shop's cash on hand must be the same figure before and after. Carrying
   * notes ten feet from a drawer to a safe does not make the shop richer or
   * poorer, and until now the second half of that sentence was not recorded
   * anywhere — the money simply left the drawer as a "bank drop" and the safe
   * was never told.
   */
  const before = {
    drawer: await balanceOf(drawer.id),
    safe: await balanceOf(safe.id),
    total: await cashOnHand(),
  };
  assert.ok(before.drawer > 20, 'there is money in the drawer to move');

  // Counted to the penny, with $20 left as tomorrow's float.
  const closed = await req('POST', '/cash/close', {
    countedUsd: before.drawer,
    carriedUsd: 20,
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));

  const moved = before.drawer - 20;
  assert.equal(await balanceOf(drawer.id), 20, 'the float stays for tomorrow');
  assert.equal(await balanceOf(safe.id), before.safe + moved, 'and the rest is in the safe');
  assert.equal(await cashOnHand(), before.total, 'the shop has exactly as much money as it did');

  const sweep = closed.json.movements.filter((m) => m.kind === 'sweep');
  assert.equal(sweep.length, 1, 'the drawer records one movement for it');
  assert.match(sweep[0].note, /Office safe/, 'and the note says where the money went');
});

test('what moves to the safe is what was counted, not what was expected', async () => {
  /*
   * The sweep must not paper over a shortfall. A drawer that came up light
   * carries its actual contents to the safe and leaves the difference recorded
   * against the shift — otherwise a missing $5 would be created again out of
   * nothing on the way to the back office, and the shop's cash on hand would
   * be a figure nobody had ever counted.
   */
  await req('POST', '/cash/open', { openingUsd: 0 });
  await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 1 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 10 }],
  });

  const safeBefore = await balanceOf(safe.id);
  const inTheDrawer = await balanceOf(drawer.id);
  const counted = inTheDrawer - 5;

  const closed = await req('POST', '/cash/close', { countedUsd: counted, carriedUsd: 0 });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));

  assert.equal(await balanceOf(drawer.id), 0, 'the drawer is emptied');
  assert.equal(
    await balanceOf(safe.id),
    safeBefore + counted,
    'and the safe got the notes that were actually there',
  );
});

test('the float left for tomorrow is counted by tomorrow’s sitting', async () => {
  /*
   * A drawer closed with change left in it opens holding that change. The
   * sitting used to count only its own movements, so the float showed up at
   * the next count as a surplus nobody could explain — the same money, every
   * morning, declared found again.
   */
  await req('POST', '/cash/open', { openingUsd: 40 });
  await req('POST', '/cash/close', { countedUsd: 40, carriedUsd: 15 });

  const opened = await req('POST', '/cash/open', { openingUsd: 0 });
  assert.equal(opened.status, 201, JSON.stringify(opened.json));
  assert.equal(opened.json.session.opening_balance_usd, 15, 'the sitting knows the float is there');

  // Nothing traded, and the drawer still holds exactly the float.
  const closed = await req('POST', '/cash/close', { countedUsd: 15, carriedUsd: 0 });
  assert.equal(closed.json.session.expected_usd, 15, 'which is what it expected to find');
  assert.equal(closed.json.session.over_short_usd, 0, 'so the count comes out square');
});

test('a sales invoice settled in cash away from the counter lands in the standing account', async () => {
  /*
   * The other half of what the shop asked for, and the one the register must
   * not touch: an invoice written in the back office and paid there in cash is
   * money the office is holding, not takings in the cashier's drawer. Counted
   * against the drawer it would make the shift come up over by the invoice.
   */
  const safeBefore = await balanceOf(safe.id);
  const drawerBefore = await balanceOf(drawer.id);

  const created = await req('POST', '/documents', {
    docType: 'sales_invoice',
    partyId: customer.id,
    items: [{ productId: widget.id, quantity: 4, price: 10 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 40 }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const confirmed = await req('POST', `/documents/${created.json.document.id}/confirm`);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));

  assert.equal(await balanceOf(safe.id), safeBefore + 40, 'the office kept the money');
  assert.equal(await balanceOf(drawer.id), drawerBefore, 'the till never saw it');
});

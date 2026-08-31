/**
 * Paying a bill when the shop is shut.
 *
 * An owner sits down at nine in the morning with a stack of supplier invoices.
 * Nobody has opened the register — nobody is serving customers yet — and the
 * app refused every one of them: *"Main drawer is closed — open it before
 * settling this in cash"*. To pay a supplier out of the office envelope, the
 * shop was being asked to open a till it was not going to use, and then count
 * and close it again to undo the lie.
 *
 * The rule the message came from is sound and stays. Money must not leave a
 * drawer nobody has opened, because the count at the end of the shift is only
 * worth having if everything that moved is on the sitting. The mistake was
 * applying it to money that was never in that drawer.
 *
 * So: a shut drawer is no longer the shop's only answer. The cash the office
 * actually pays out of gets a name of its own the first time it is used, the
 * register is untouched, and a shop that really does pay across the counter
 * with the till open goes on doing exactly that — see the last test here, and
 * oneTillShop.test.js next door.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4674;
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
let customer;
let widget;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-office-cash-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'office.sqlite'),
    JWT_SECRET: 'office-cash-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;

  const cash = (await req('GET', '/accounts/registry')).json.registry.cash;
  assert.equal(cash.length, 1, 'the shop starts with the one drawer it was given');
  drawer = cash[0];
  assert.equal(drawer.kind, 'drawer');

  supplier = (await req('POST', '/suppliers', { name: 'Wholesaler' })).json.party;
  customer = (await req('POST', '/customers', { name: 'Rami' })).json.party;
  widget = (await req('POST', '/products', {
    name: 'Widget', sku: 'OFF-001', price: 10, cost: 6, stock: 200,
  })).json.product;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** The tills as the Accounts screen reads them. */
async function tills() {
  return (await req('GET', '/accounts/registry')).json.registry.cash;
}

async function tillNamed(name) {
  return (await tills()).find((a) => a.name === name) ?? null;
}

async function balanceOf(id) {
  return (await tills()).find((a) => a.id === id)?.balance ?? null;
}

/** A draft of `type`, settled in full in cash. */
async function draftPaidInCash(type, partyId, amount) {
  const res = await req('POST', '/documents', {
    docType: type,
    partyId,
    items: [{ productId: widget.id, quantity: 1, price: amount }],
    payments: [{ currency: 'USD', amount }],
    paymentMethod: 'cash',
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.document;
}

test('a purchase invoice is settled in cash with every drawer shut', async () => {
  /*
   * The whole complaint, done the way the screen does it — which is the part
   * the first version of this fix got wrong, on a live shop.
   *
   * The server was right and the screen undid it. Asked which till it would
   * use, the app answered with the shut drawer: true as far as it went, since
   * naming the office's cash is what confirming *does next*. The screen took
   * the literal answer and sent it back on Confirm, turning the app's own
   * default into the shop's explicit choice — and a choice is held to the
   * open-drawer rule while a default is not. The refusal came straight back,
   * in the new wording, on the very case the change was written for.
   *
   * So this asks first and confirms with whatever it was told, exactly as the
   * screen does. Both halves have to be right for it to pass.
   */
  const doc = await draftPaidInCash('purchase_invoice', supplier.id, 40);

  const plan = (await req('GET', `/documents/${doc.id}/settlement`)).json;
  assert.equal(plan.accountId, null, 'nothing to hand back, so the screen sends nothing');
  assert.equal(plan.willCreate, true, 'because confirming is what creates it');
  assert.equal(plan.name, 'Main cash', 'and it says what the money will come out of');

  const confirmed = await req(
    'POST',
    `/documents/${doc.id}/confirm`,
    plan.accountId ? { accountId: plan.accountId } : null,
  );

  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  assert.equal(confirmed.json.document.status, 'confirmed');
});

test('the money came out of the shop’s cash, and not out of the register', async () => {
  const office = await tillNamed('Main cash');
  assert.ok(office, 'the pile the money came from now has a name');
  assert.equal(office.kind, 'safe', 'and it is not a drawer, so it needs no shift opened');
  assert.equal(office.balance, -40, 'the shop has paid out $40 of cash it had not declared');

  assert.equal(await balanceOf(drawer.id), 0, 'the cashier’s drawer never moved');
});

test('the supplier’s books agree that they were paid', async () => {
  /*
   * The half that used to be written on its own. A ledger saying paid with no
   * cash record anywhere is the failure this whole area exists to prevent, and
   * it must not have been traded for the opposite.
   */
  const statement = (await req('GET', `/suppliers/${supplier.id}/statement`)).json;
  const payment = statement.lines.find((l) => l.kind === 'payment');
  assert.ok(payment, 'the payment is on their statement');
  assert.equal(payment.credit, 40, 'for what actually left the shop');
});

test('a sales invoice taken in cash away from the counter lands there too', async () => {
  const before = (await tillNamed('Main cash')).balance;

  const doc = await draftPaidInCash('sales_invoice', customer.id, 25);
  assert.equal((await req('POST', `/documents/${doc.id}/confirm`)).status, 200);

  assert.equal((await tillNamed('Main cash')).balance, before + 25, 'money in, same pile');
  assert.equal(await balanceOf(drawer.id), 0, 'still not the register’s business');
});

test('the shop is told which till it is paying from, and can say otherwise', async () => {
  const doc = await draftPaidInCash('purchase_invoice', supplier.id, 5);

  const offered = (await req('GET', `/documents/${doc.id}/settlement`)).json;
  const office = await tillNamed('Main cash');
  assert.equal(offered.accountId, office.id, 'the office cash is what it would use');

  const shown = offered.accounts.find((a) => a.id === drawer.id);
  assert.ok(shown, 'the drawer is offered as well — a shop may really pay from it');
  assert.equal(shown.open, false, 'and it says why it cannot be picked right now');

  // Picking it anyway is still refused, because that money is not in there.
  const refused = await req('POST', `/documents/${doc.id}/confirm`, { accountId: drawer.id });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /closed/);
});

test('with the register open, the notes come out of the register', async () => {
  /*
   * The line that keeps this from being a licence to route every payment away
   * from the till. A shop with one drawer, open and trading, pays its suppliers
   * across the counter — that is where the money is — and nothing about that
   * changed.
   */
  await req('POST', '/cash/open', { openingUsd: 100 });

  const officeBefore = (await tillNamed('Main cash')).balance;
  const doc = await draftPaidInCash('purchase_invoice', supplier.id, 30);
  assert.equal((await req('POST', `/documents/${doc.id}/confirm`)).status, 200);

  assert.equal(await balanceOf(drawer.id), 70, 'the drawer paid for it');
  assert.equal((await tillNamed('Main cash')).balance, officeBefore, 'the office cash is untouched');
});

test('an expense paid with everything shut is money that left somewhere', async () => {
  /*
   * The same hole, on the other screen, and worse: the cash movement was only
   * written `if (session)`, so a bill paid before opening time went into the
   * books, the profit figure and the ledger — and into no cash record at all.
   * The shop's cash on hand stayed exactly as high as it had been a moment
   * before the money left.
   */
  const closed = await req('POST', '/cash/close', { countedUsd: 70, carriedUsd: 0 });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));

  const before = (await tillNamed('Main cash')).balance;
  const spent = await req('POST', '/expenses', { category: 'rent', amountUsd: 12 });
  assert.equal(spent.status, 201, JSON.stringify(spent.json));

  assert.equal((await tillNamed('Main cash')).balance, before - 12, 'the money left a real pile');
});

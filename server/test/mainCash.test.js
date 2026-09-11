/**
 * Whose money is whose: the drawer is the register's, everything else is the
 * shop's main cash.
 *
 * The rule the shop actually runs on. The cashier counts the drawer against
 * what the register rang through it; the owner pays suppliers, technicians and
 * bills out of the main cash and never out of that count. So the same refund
 * lands in a different pile depending on where it was done — the drawer at the
 * register with the till open, the main cash from the Sales screen or after the
 * drawer was closed — and the register says which it is with a header on every
 * request (see client/src/api.js and `tillFor` in lib/cash.js).
 *
 * Repairs are the one exception the shop asked for: their money goes through
 * the drawer whichever screen took it.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4695;
const BASE = `http://127.0.0.1:${PORT}/api`;

/** What the register page says with every request. */
const AT_REGISTER = { 'X-At-Register': '1' };

let child;
let workDir;
let token;

async function req(method, route, body, headers = {}) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* Some responses carry no body. */
  }
  return { status: res.status, json };
}

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The drawer as the register sees it: what should be in it right now. */
async function drawerUsd() {
  const cur = (await req('GET', '/cash/current')).json;
  return cur.session ? cur.expected.usd : null;
}

/** The shop's main cash, as the Accounts screen reads it — null until it exists. */
async function mainCash() {
  const { registry } = (await req('GET', '/accounts/registry')).json;
  return registry.cash.find((a) => a.name === 'Main cash') ?? null;
}
const mainCashUsd = async () => (await mainCash())?.balance ?? 0;

/** Every cash movement on an account, newest first. */
async function movementsOf(accountId) {
  const cur = (await req('GET', `/cash/current?accountId=${accountId}`)).json;
  return cur.movements || [];
}

let charger;
let cable;

async function sell(product, quantity = 1) {
  const res = await req(
    'POST',
    '/orders',
    {
      items: [{ productId: product.id, quantity }],
      paymentMethod: 'cash',
      payments: [{ currency: 'USD', amount: product.price * quantity }],
    },
    AT_REGISTER,
  );
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const detail = (await req('GET', `/orders/${res.json.order.id}`)).json;
  return { order: res.json.order, item: detail.items[0] };
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-main-cash-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'main-cash-secret-long-enough-for-the-production-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };
  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  charger = (
    await req('POST', '/products', { name: 'Blue Charger', sku: 'MC-CHG', price: 20, cost: 8, stock: 50 })
  ).json.product;
  cable = (
    await req('POST', '/products', { name: 'Blue Cable', sku: 'MC-CBL', price: 5, cost: 1, stock: 50 })
  ).json.product;
  assert.equal((await req('POST', '/cash/open', { openingUsd: 100 })).status, 201);
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ----------------------------------------------------------------- refunds */

test('a return taken at the register with the till open comes out of the drawer', async () => {
  const { order, item } = await sell(charger);
  const before = await drawerUsd();
  const cashBefore = await mainCashUsd();

  const back = await req('POST', `/orders/${order.id}/return-line`, { itemId: item.id, quantity: 1 }, AT_REGISTER);
  assert.equal(back.status, 200, JSON.stringify(back.json));

  assert.equal(await drawerUsd(), round(before - 20), 'the drawer handed it back');
  assert.equal(await mainCashUsd(), cashBefore, 'the main cash was not asked');
});

test('the same return from the Sales screen comes out of the main cash, even with the till open', async () => {
  const { order, item } = await sell(charger);
  const before = await drawerUsd();
  const cashBefore = await mainCashUsd();

  // No register header: this is the back office.
  const back = await req('POST', `/orders/${order.id}/return-line`, { itemId: item.id, quantity: 1 });
  assert.equal(back.status, 200, JSON.stringify(back.json));

  assert.equal(await drawerUsd(), before, 'the drawer is untouched — that count is the cashier’s');
  assert.equal(await mainCashUsd(), round(cashBefore - 20), 'the main cash paid it');

  const office = await mainCash();
  const refund = (await movementsOf(office.id)).find((m) => m.order_id === order.id && m.kind === 'refund');
  assert.ok(refund, 'and it is on the main cash’s own record');
  assert.equal(refund.amount_usd, -20);
});

test('a void from the back office is the same: the whole sale, out of the main cash', async () => {
  const { order } = await sell(cable, 2);
  const before = await drawerUsd();
  const cashBefore = await mainCashUsd();

  const voided = await req('POST', `/orders/${order.id}/refund`, null);
  assert.equal(voided.status, 200, JSON.stringify(voided.json));
  assert.equal(await drawerUsd(), before);
  assert.equal(await mainCashUsd(), round(cashBefore - 10));
});

test('with the drawer closed, a return at the register is not refused — it comes out of the main cash', async () => {
  const { order, item } = await sell(charger);
  const closed = await req('POST', '/cash/close', { countedUsd: await drawerUsd(), carriedUsd: 0 });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));
  assert.equal(await drawerUsd(), null, 'the drawer is closed');
  const cashBefore = await mainCashUsd();

  const back = await req('POST', `/orders/${order.id}/return-line`, { itemId: item.id, quantity: 1 }, AT_REGISTER);
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(await mainCashUsd(), round(cashBefore - 20), 'the customer was paid from the main cash');

  // Undone, the money goes back to the pile it came out of — not to a drawer
  // that was never involved.
  const undone = await req('POST', `/orders/${order.id}/return-line/undo`, { itemId: item.id }, AT_REGISTER);
  assert.equal(undone.status, 200, JSON.stringify(undone.json));
  assert.equal(await mainCashUsd(), cashBefore, 'and it is back in the main cash');
  assert.equal(await drawerUsd(), null, 'the drawer is still closed');
});

/* ---------------------------------------------------------- the back office */

test('an expense paid from the expenses screen comes out of the main cash while the till is open', async () => {
  assert.equal((await req('POST', '/cash/open', { openingUsd: 100 })).status, 201);
  const before = await drawerUsd();
  const cashBefore = await mainCashUsd();

  const spent = await req('POST', '/expenses', { category: 'rent', amountUsd: 30, paidWith: 'cash' });
  assert.equal(spent.status, 201, JSON.stringify(spent.json));
  assert.equal(spent.json.warning, null, 'the main cash is a balance, not a float, so it is never "short"');
  assert.equal(await drawerUsd(), before, 'the drawer is untouched');
  assert.equal(await mainCashUsd(), round(cashBefore - 30));
});

test('a repair is the exception: its money goes through the drawer whichever screen took it', async () => {
  const ticket = (
    await req('POST', '/repairs', { customerName: 'Drawer Job', device: 'Nokia', fault: 'Port', quoted: 25 })
  ).json.ticket;
  const before = await drawerUsd();
  const cashBefore = await mainCashUsd();

  // No register header — the Repairs screen — and still the drawer.
  const paid = await req('POST', `/repairs/${ticket.id}/payment`, {
    charged: 25,
    payments: [{ currency: 'USD', amount: 25 }],
  });
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  assert.equal(await drawerUsd(), round(before + 25), 'into the drawer');
  assert.equal(await mainCashUsd(), cashBefore, 'not the main cash');
});

/* ----------------------------------------- finding a product’s sales later */

test('a product’s sales can be asked for by id, with the line to take back on each', async () => {
  const { order } = await sell(cable);
  const res = await req('GET', `/orders?productId=${cable.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.product.id, cable.id);
  const found = res.json.orders.find((o) => o.id === order.id);
  assert.ok(found, 'the sale is there');
  assert.equal(found.lines.length, 1, 'with the product’s own line on it');
  assert.equal(found.lines[0].quantity, 1);
  assert.ok(res.json.orders.every((o) => o.lines.length > 0), 'and only sales that carried it');
});

test('typed by name, one match is the product and several are offered to choose from', async () => {
  const one = (await req('GET', '/orders?q=blue%20charger')).json;
  assert.equal(one.product?.id, charger.id, 'a name that fits one product is that product');
  assert.ok(one.orders.every((o) => o.lines?.length > 0), 'with its sales');

  const several = (await req('GET', '/orders?q=blue')).json;
  assert.equal(several.product, null, 'two products fit, so nothing is guessed');
  assert.deepEqual(
    several.products.map((p) => p.name).sort(),
    ['Blue Cable', 'Blue Charger'],
    'they are offered instead',
  );
  assert.ok(several.orders.length > 0, 'and the sales that name either are still listed');
});

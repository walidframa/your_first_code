/**
 * Emptying a shop that asked to start again.
 *
 * Two things are checked. That the right things go and the right things stay —
 * a reset that takes the staff logins with it locks the owner out of their own
 * shop, and one that leaves the sales behind is not a reset.
 *
 * And that every table in the schema is named somewhere. The lists in
 * resetShop.js are read out of the live database here, so a table added next
 * month and forgotten there fails this test rather than quietly surviving a
 * wipe a client was told was total.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 4591-4622 and 4634-4636 are spoken for; a file with a port of its own is
// what testPorts.test.js insists on, and for good reason.
const PORT = 4637;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;

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
    // Some responses carry no body.
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

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-reset-'));
  /*
   * The same file for both halves of this test.
   *
   * The shop runs in a child process and the reset is called in this one, so
   * unless this process is pointed at the same database it would empty the
   * developer's own — which is a test that passes by doing the damage
   * somewhere nobody is looking.
   */
  process.env.DB_PATH = path.join(workDir, 'reset.sqlite');
  process.env.JWT_SECRET = 'reset-test-secret-long-enough-for-guard';
  process.env.ACCOUNT_SECRET = 'reset-account-secret-long-enough-32ch';

  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'reset.sqlite'),
    JWT_SECRET: 'reset-test-secret-long-enough-for-guard',
    ACCOUNT_SECRET: 'reset-account-secret-long-enough-32ch',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };
  const seed = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: serverRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();
  const signIn = await req('POST', '/auth/login', { username: 'admin', password: 'admin123' });
  adminToken = signIn.json.token;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ the lists */

test('every table in the schema is either emptied or deliberately kept', async () => {
  const { db } = await import('../src/db.js');
  const { CATALOGUE_TABLES, KEPT_TABLES, TRADING_TABLES } = await import('../src/lib/resetShop.js');

  const live = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);

  const named = new Set([...TRADING_TABLES, ...CATALOGUE_TABLES, ...KEPT_TABLES]);
  const unaccounted = live.filter((t) => !named.has(t));
  assert.deepEqual(
    unaccounted,
    [],
    `these tables are in the database and in none of the reset lists: ${unaccounted.join(', ')}`,
  );

  // And nothing is named that does not exist — a typo in a list is a table
  // that silently never gets emptied.
  const missing = [...named].filter((t) => !live.includes(t));
  assert.deepEqual(missing, [], `named for reset but not in the database: ${missing.join(', ')}`);
});

/* ------------------------------------------------------------ the wipe */

test('clearing the trading leaves the shop able to open in the morning', async () => {
  // A day's work: something sold, on an account, with the drawer open.
  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const item = products[0];
  const customer = (
    await req('POST', '/customers', { name: 'Rami Haddad', credit_limit: 500 }, adminToken)
  ).json.party;

  await req('POST', '/cash/open', { openingUsd: 100 }, adminToken);
  const sale = await req(
    'POST',
    '/orders',
    {
      items: [{ productId: item.id, quantity: 1 }],
      paymentMethod: 'account',
      customerId: customer.id,
    },
    adminToken,
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const { resetShop } = await import('../src/lib/resetShop.js');
  const out = resetShop('trading');

  assert.equal(out.scope, 'trading');
  assert.ok(out.cleared.orders >= 1, 'the sale went');
  assert.ok(out.cleared.account_entries >= 1, 'and what it put on the account');

  // What the shop needs to trade on Monday is still there.
  const after = await req('GET', '/products', null, adminToken);
  assert.equal(after.status, 200);
  assert.equal(after.json.products.length, products.length, 'the catalogue stayed');
  const stillThere = (await req('GET', '/customers', null, adminToken)).json.parties;
  assert.ok(stillThere.some((p) => p.name === 'Rami Haddad'), 'the customer stayed');
  assert.equal(stillThere.find((p) => p.name === 'Rami Haddad').balance, 0, 'owing nothing');

  // The staff can still get in, which is the whole difference between a reset
  // and a locked door.
  const back = await req('POST', '/auth/login', { username: 'admin', password: 'admin123' });
  assert.equal(back.status, 200);

  // And the shelves are empty, because the movements that filled them are gone.
  const stock = (await req('GET', '/products', null, adminToken)).json.products;
  assert.ok(stock.every((p) => Number(p.stock) === 0), 'nothing is left on the shelf');

  // Nothing left to sell means the first sale after a reset starts the
  // numbering again.
  assert.equal((await req('GET', '/orders', null, adminToken)).json.orders.length, 0);
});

test('and a total reset takes the catalogue too, but never the logins', async () => {
  const { resetShop } = await import('../src/lib/resetShop.js');
  const out = resetShop('everything');

  assert.equal(out.scope, 'everything');
  assert.ok(out.cleared.products >= 1, 'the catalogue went');
  assert.ok(out.cleared.customers >= 1, 'and the contacts');

  assert.equal((await req('GET', '/products', null, adminToken)).json.products.length, 0);
  assert.equal((await req('GET', '/customers', null, adminToken)).json.parties.length, 0);

  const back = await req('POST', '/auth/login', { username: 'admin', password: 'admin123' });
  assert.equal(back.status, 200, 'the owner can still sign in');

  // The shop is still a shop: its settings and its till survived.
  const settings = await req('GET', '/settings', null, adminToken);
  assert.equal(settings.status, 200);
  assert.ok(Number(settings.json.settings.exchange_rate) > 0, 'the rate is still set');
});

test('a scope nobody named empties nothing', async () => {
  const { resetShop } = await import('../src/lib/resetShop.js');
  assert.throws(() => resetShop('half'), /one of/);
  assert.throws(() => resetShop(''), /one of/);
});

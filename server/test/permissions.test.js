/**
 * What each member of staff may do, and the transfer counter that made it
 * necessary.
 *
 * The thread through both: somebody hired to run one part of the shop should be
 * able to run it and nothing else — and the drawer they run it out of has to
 * still add up at the end of the day.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Taken: 4593 wallets, 4594 repairs, 4595 units, 4596 profit, 4598 cash, 4599 api.
const PORT = 4592;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let operatorToken;
let operator;

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

const login = async (username, password) =>
  (await req('POST', '/auth/login', { username, password })).json;

const drawer = async () => (await req('GET', '/cash/current', null, adminToken)).json;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-perms-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'perms.sqlite'),
    JWT_SECRET: 'permissions-test-secret-long-enough-guard',
    ACCOUNT_SECRET: 'permissions-account-secret-long-enough32',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await login('admin', 'admin123')).token;

  // Somebody hired to run the transfer desk and nothing else.
  operator = (
    await req(
      'POST',
      '/users',
      {
        name: 'Rania Saab',
        username: 'rania',
        password: 'transfer123',
        role: 'cashier',
        permissions: ['transfers', 'expenses'],
      },
      adminToken,
    )
  ).json.user;

  operatorToken = (await login('rania', 'transfer123')).token;

  // The desk takes real money, so it needs a drawer to take it into.
  await req('POST', '/cash/open', { openingUsd: 200, openingLbp: 5000000 }, adminToken);
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ----------------------------------------------------------- permissions */

test('an admin needs no grants — the role is the answer', async () => {
  const me = (await req('GET', '/auth/me', null, adminToken)).json.user;
  assert.equal(me.role, 'admin');
  assert.ok(me.permissions.includes('settings'));
  assert.ok(me.permissions.includes('transfers'));
});

test('a new account gets exactly what it was given', async () => {
  const me = (await req('GET', '/auth/me', null, operatorToken)).json.user;
  assert.deepEqual(me.permissions.sort(), ['expenses', 'transfers']);
});

test('a permission opens its section and nothing else', async () => {
  assert.equal((await req('GET', '/transfers', null, operatorToken)).status, 200);
  assert.equal((await req('GET', '/expenses', null, operatorToken)).status, 200);

  // Not granted: the back office stays shut whether or not they find the URL.
  for (const route of ['/inventory', '/users', '/reports/summary']) {
    const res = await req('GET', route, null, operatorToken);
    assert.equal(res.status, 403, `${route} should be refused`);
  }

  /*
   * Reading the catalogue is not one of the gated things — the register needs
   * it, and a price list is not a secret. Changing it is.
   */
  assert.equal((await req('GET', '/products', null, operatorToken)).status, 200);
  assert.equal(
    (await req('POST', '/products', { name: 'Sneaky', sku: 'SNK-X', price: 1 }, operatorToken)).status,
    403,
  );
});

test('selling is a permission too, not something every login implies', async () => {
  const sale = await req(
    'POST',
    '/orders',
    { items: [{ productId: 1, quantity: 1 }], paymentMethod: 'card' },
    operatorToken,
  );
  assert.equal(sale.status, 403, 'the transfer operator is not a cashier');
});

test('taking a permission away takes effect on the next request, not the next login', async () => {
  await req('PUT', `/users/${operator.id}/permissions`, { permissions: ['transfers'] }, adminToken);

  // Same token as before — permissions are read from the database, not carried
  // in it, which is the whole point.
  assert.equal((await req('GET', '/expenses', null, operatorToken)).status, 403);
  assert.equal((await req('GET', '/transfers', null, operatorToken)).status, 200);

  await req('PUT', `/users/${operator.id}/permissions`, { permissions: ['transfers', 'expenses'] }, adminToken);
});

test('an unknown permission is refused rather than stored', async () => {
  const res = await req(
    'PUT',
    `/users/${operator.id}/permissions`,
    { permissions: ['transfers', 'everything'] },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Unknown permission/);

  const me = (await req('GET', '/auth/me', null, operatorToken)).json.user;
  assert.ok(me.permissions.includes('expenses'), 'the valid half was not half-applied');
});

test("an admin's permissions cannot be narrowed without demoting them first", async () => {
  const admin = (await req('GET', '/users', null, adminToken)).json.users.find((u) => u.role === 'admin');
  const res = await req('PUT', `/users/${admin.id}/permissions`, { permissions: [] }, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /already has every permission/);
});

test('staff cannot grant themselves anything', async () => {
  const res = await req(
    'PUT',
    `/users/${operator.id}/permissions`,
    { permissions: ['settings', 'users'] },
    operatorToken,
  );
  assert.equal(res.status, 403);
});

/* ------------------------------------------------------------- transfers */

test('sending takes the money in, fee and all', async () => {
  const before = await drawer();

  const res = await req(
    'POST',
    '/transfers',
    {
      company: 'OMT',
      direction: 'send',
      reference: 'OMT-1001',
      customerName: 'Hassan Aoun',
      customerPhone: '03 222 111',
      counterparty: 'Layal Aoun',
      destination: 'Tripoli',
      amountUsd: 150,
      feeUsd: 3,
    },
    operatorToken,
  );
  assert.equal(res.status, 201, JSON.stringify(res.json));

  const after = await drawer();
  assert.equal(
    Math.round((after.expected.usd - before.expected.usd) * 100) / 100,
    153,
    'the amount and the fee both went into the drawer',
  );
});

test('paying out counts the money back out, keeping the fee', async () => {
  const before = await drawer();

  await req(
    'POST',
    '/transfers',
    {
      company: 'Whish',
      direction: 'payout',
      reference: 'WH-77',
      customerName: 'Maya Chidiac',
      amountUsd: 40,
      feeUsd: 1,
    },
    operatorToken,
  );

  const after = await drawer();
  assert.equal(
    Math.round((after.expected.usd - before.expected.usd) * 100) / 100,
    -39,
    '$40 out, $1 fee kept',
  );
});

test('pounds and dollars are moved separately, never converted', async () => {
  const before = await drawer();

  await req(
    'POST',
    '/transfers',
    { company: 'OMT', direction: 'send', amountLbp: 3000000, feeLbp: 50000 },
    operatorToken,
  );

  const after = await drawer();
  assert.equal(after.expected.lbp - before.expected.lbp, 3050000);
  assert.equal(after.expected.usd, before.expected.usd, 'the dollars did not move');
});

test('a transfer with no amount is refused', async () => {
  const res = await req(
    'POST',
    '/transfers',
    { company: 'OMT', direction: 'send', feeUsd: 2 },
    operatorToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /amount/i);
});

test('a payout is a direction, not a negative amount', async () => {
  const res = await req(
    'POST',
    '/transfers',
    { company: 'OMT', direction: 'send', amountUsd: -50 },
    operatorToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /negative/);
});

test('cancelling puts the money back and keeps the row', async () => {
  const sent = (
    await req(
      'POST',
      '/transfers',
      { company: 'BOB Finance', direction: 'send', reference: 'BOB-9', amountUsd: 80, feeUsd: 2 },
      operatorToken,
    )
  ).json.transfer;

  const before = await drawer();
  const cancelled = await req('POST', `/transfers/${sent.id}/cancel`, {}, operatorToken);
  assert.equal(cancelled.json.transfer.status, 'cancelled');

  const after = await drawer();
  assert.equal(Math.round((after.expected.usd - before.expected.usd) * 100) / 100, -82);

  // Still there to be explained to the company, and out of the takings.
  const list = (await req('GET', '/transfers', null, operatorToken)).json;
  assert.ok(list.transfers.some((t) => t.id === sent.id));
  assert.equal((await req('POST', `/transfers/${sent.id}/cancel`, {}, operatorToken)).status, 400);
});

test("the day's totals separate what came in, what went out and what was kept", async () => {
  const { summary } = (await req('GET', '/transfers?preset=today', null, operatorToken)).json;

  assert.equal(summary.inUsd, 150, 'the cancelled send is not takings');
  assert.equal(summary.outUsd, 40);
  assert.equal(summary.feeUsd, 4, '$3 on the send plus $1 on the payout');
  assert.equal(summary.inLbp, 3000000);
});

test('a transfer is found by its reference', async () => {
  const found = (await req('GET', '/transfers?search=OMT-1001', null, operatorToken)).json;
  assert.equal(found.transfers.length, 1);
  assert.equal(found.transfers[0].customer_name, 'Hassan Aoun');
});

test('the operator can put an expense through the same drawer', async () => {
  const before = await drawer();
  const res = await req(
    'POST',
    '/expenses',
    { category: 'utilities', amountUsd: 12, paidWith: 'cash', note: 'Generator' },
    operatorToken,
  );
  assert.equal(res.status, 201, JSON.stringify(res.json));

  const after = await drawer();
  assert.equal(Math.round((after.expected.usd - before.expected.usd) * 100) / 100, -12);
});

test('somebody without the desk cannot use it', async () => {
  const cashier = (await login('cashier', 'cashier123')).token;
  assert.equal((await req('GET', '/transfers', null, cashier)).status, 403);
  assert.equal(
    (await req('POST', '/transfers', { company: 'OMT', direction: 'send', amountUsd: 10 }, cashier)).status,
    403,
  );
});

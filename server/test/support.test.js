/**
 * The vendor, inside a shop that is not theirs.
 *
 * This is the second-most dangerous thing in the system after the console
 * login, and for a reason worth stating: it is a door into a business's books
 * that the business did not open. So most of what follows is about the ways it
 * refuses, and about the marks it leaves when it does not.
 *
 * The bargain is "leave a mark", not "ask permission" — the shopkeeper who is
 * locked out is the one who most needs this and the least able to approve it.
 * What holds the bargain up is testable, and tested here: single use, five
 * minutes, one shop, and everything written down including the refusals.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureControlSchema } from '../src/lib/control.js';
import { mintTicket } from '../src/lib/supportTickets.js';
import { addDays, today } from '../src/lib/licence.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4616;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let workDir;
let control;
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
    // Downloads are not JSON.
  }
  return { status: res.status, json };
}

/** Write a ticket the way the console would, and hand back the secret half. */
const ticketFor = (slug = 'rami', reason = 'Fixing a price') =>
  mintTicket(control, { slug, operator: 'walid', reason }).token;

/*
 * Every visit this file opens, so it can shut them again.
 *
 * A visit that is never ended stays live for twenty minutes, which is correct
 * behaviour and awkward for a test: without this, "leaving takes the bar down"
 * fails because of a session three tests ago that nobody closed.
 */
const opened = [];

async function goIn(token) {
  const res = await req('POST', '/api/support/redeem', { token });
  if (res.json?.token) opened.push(res.json.token);
  return res;
}

async function everyoneOut() {
  for (const token of opened.splice(0)) await req('POST', '/api/support/end', {}, token);
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-support-'));
  const controlPath = path.join(workDir, 'control.sqlite');

  control = ensureControlSchema(new DatabaseSync(controlPath));
  control
    .prepare(
      `INSERT INTO tenants (slug, shop_name, plan, paid_through, grace_days)
       VALUES ('rami', 'Rami Mobile', 'monthly', ?, 10)`,
    )
    .run(addDays(today(), 30));

  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'support-test-secret-long-enough-for-the-guard',
    BACKUP_DIR: path.join(workDir, 'backups'),
    CONTROL_DB: controlPath,
    TENANT_SLUG: 'rami',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  assert.equal(spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env }).status, 0);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  adminToken = (await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' }))
    .json.token;
  assert.ok(adminToken, 'the shop would not let its own admin in');
});

after(() => {
  child?.kill();
  control?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ getting in */

test('a ticket from the console opens the shop', async () => {
  const res = await goIn(ticketFor());
  assert.equal(res.status, 200);
  assert.ok(res.json.token);
  assert.equal(res.json.session.operator, 'walid');
  assert.match(res.json.user.name, /walid/);
  assert.equal(res.json.user.role, 'admin');
});

test('a ticket works once and then never again', async () => {
  // The console cannot mark a ticket spent — it writes the book of shops and
  // the shop only reads it. So the shop has to enforce this itself, and if it
  // did not, a link out of a browser history would be a permanent key.
  const token = ticketFor();
  assert.equal((await goIn(token)).status, 200);
  assert.equal((await goIn(token)).status, 401);
});

test('a ticket for another shop does not open this one', async () => {
  control
    .prepare(
      `INSERT INTO tenants (slug, shop_name, plan, paid_through)
       VALUES ('nabil', 'Nabil Phones', 'monthly', ?)`,
    )
    .run(addDays(today(), 30));

  assert.equal((await goIn(ticketFor('nabil'))).status, 401);
});

test('an expired ticket does not open it either', async () => {
  const past = new Date(Date.now() - 60 * 60 * 1000);
  const { token } = mintTicket(control, { slug: 'rami', operator: 'walid', now: past });
  assert.equal((await goIn(token)).status, 401);
});

test('a made-up ticket is refused, and says nothing about why', async () => {
  const forged = await goIn('f'.repeat(64));
  const spent = await goIn(ticketFor());
  await goIn('f'.repeat(64));

  assert.equal(forged.status, 401);
  assert.ok(spent.json.token);
  // Expired, forged, wrong shop and already used all answer identically. Which
  // one it was is a hint about how to get closer.
  assert.equal((await goIn('e'.repeat(64))).json.error, forged.json.error);
});

/* ------------------------------------------- what the shop is told about it */

test('the shop can see who is in it, and why', async () => {
  await goIn(ticketFor('rami', 'Rami asked me to fix the iPhone price'));

  const { json } = await req('GET', '/api/support/state', null, adminToken);
  assert.equal(json.support.active, true);
  assert.equal(json.support.operator, 'walid');
  assert.equal(json.support.reason, 'Rami asked me to fix the iPhone price');
});

test('a cashier can see it too, not only the owner', async () => {
  // Somebody standing at the counter has as much right to know a stranger is in
  // the till as the person who owns it.
  const cashier = (
    await req('POST', '/api/auth/login', { username: 'cashier', password: 'cashier123' })
  ).json.token;
  assert.ok(cashier);

  await goIn(ticketFor());
  const { json } = await req('GET', '/api/support/state', null, cashier);
  assert.equal(json.support.active, true);
});

test('leaving takes the bar down', async () => {
  // Earlier tests walked in and never walked out, which is exactly what a
  // twenty-minute idle window is for — and would otherwise keep the bar up here
  // for a reason that has nothing to do with what is being tested.
  await everyoneOut();

  const token = (await goIn(ticketFor())).json.token;
  assert.equal((await req('GET', '/api/support/state', null, adminToken)).json.support.active, true);

  await req('POST', '/api/support/end', {}, token);

  const after = await req('GET', '/api/support/state', null, adminToken);
  assert.equal(after.json.support.active, false);
});

/* --------------------------------------------------------- what it wrote down */

test('every change is written into the shop’s own log', async () => {
  const token = (await goIn(ticketFor('rami', 'Fixing the price'))).json.token;

  await req('PUT', '/api/products/1', { price: 999 }, token);

  const { json } = await req('GET', '/api/support/visits', null, adminToken);
  const visit = json.visits.find((v) => v.reason === 'Fixing the price');
  assert.ok(visit, 'the visit is not in the log');
  assert.equal(visit.operator, 'walid');
  assert.ok(
    visit.changes.some((c) => c.method === 'PUT' && c.path === '/api/products/1'),
    'the change is not in the log',
  );
});

test('a refused attempt is written down too', async () => {
  // The more interesting half. A log that quietly dropped what the vendor tried
  // and was stopped from doing would be the vendor's account of the visit
  // rather than the shop's.
  const token = (await goIn(ticketFor('rami', 'Trying something'))).json.token;

  const refused = await req('DELETE', '/api/products/999999', null, token);
  assert.ok(refused.status >= 400);

  const { json } = await req('GET', '/api/support/visits', null, adminToken);
  const visit = json.visits.find((v) => v.reason === 'Trying something');
  const attempt = visit.changes.find((c) => c.path === '/api/products/999999');
  assert.ok(attempt, 'the refused attempt is missing from the log');
  assert.ok(attempt.status >= 400);
});

test('reading things is not logged as changing them', async () => {
  const token = (await goIn(ticketFor('rami', 'Just looking'))).json.token;
  await req('GET', '/api/products', null, token);

  const { json } = await req('GET', '/api/support/visits', null, adminToken);
  const visit = json.visits.find((v) => v.reason === 'Just looking');
  assert.deepEqual(visit.changes, [], 'a look was recorded as a change');
});

test('the log is the shop’s to read', async () => {
  // Behind the shop's own "runs this place" permission, and not behind anything
  // of the vendor's. A record the vendor could withhold is not a record.
  assert.equal((await req('GET', '/api/support/visits', null, null)).status, 401);
  assert.equal((await req('GET', '/api/support/visits', null, adminToken)).status, 200);
});

/* ------------------------------------------- what only a visit may do */

test('the shop’s own admin cannot use the support-only doors', async () => {
  /*
   * These exist for somebody coming in from outside. An owner who could reset
   * their own password through this door would have a way round the "you must
   * know the current one" rule, and one who could restore through it would have
   * an unlogged way to roll their own books back.
   */
  for (const [method, route, body] of [
    ['POST', '/api/support/reset-password', { username: 'admin' }],
    ['POST', '/api/support/restore', { name: 'anything' }],
    ['POST', '/api/support/backup', {}],
  ]) {
    const res = await req(method, route, body, adminToken);
    assert.equal(res.status, 403, `${route} was open to the shop's own admin`);
  }
});

test('none of it is open to a stranger', async () => {
  for (const [method, route] of [
    ['GET', '/api/support/state'],
    ['GET', '/api/support/visits'],
    ['POST', '/api/support/backup'],
    ['POST', '/api/support/reset-password'],
    ['POST', '/api/support/restore'],
  ]) {
    const res = await req(method, route, method === 'POST' ? {} : null, null);
    assert.equal(res.status, 401, `${method} ${route} was open`);
  }
});

/* -------------------------------------------------- letting an owner back in */

test('a locked-out owner is given a new password they must change', async () => {
  const token = (await goIn(ticketFor())).json.token;

  const reset = await req('POST', '/api/support/reset-password', { username: 'admin' }, token);
  assert.equal(reset.status, 200);
  assert.ok(reset.json.password.length >= 12, 'a password to read down a phone, not a short one');

  // The old one is dead and the new one works.
  assert.equal(
    (await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).status,
    401,
  );
  const back = await req('POST', '/api/auth/login', {
    username: 'admin',
    password: reset.json.password,
  });
  assert.equal(back.status, 200);
  assert.equal(
    back.json.user.mustChangePassword,
    true,
    'the vendor would otherwise keep a working key to the shop',
  );

  adminToken = back.json.token;
});

test('resetting an account that is not there is a 404, not a new account', async () => {
  const token = (await goIn(ticketFor())).json.token;
  const res = await req('POST', '/api/support/reset-password', { username: 'nobody' }, token);
  assert.equal(res.status, 404);
});

/* ---------------------------------------------------------------- copies */

test('a visit can take a copy of the shop', async () => {
  const token = (await goIn(ticketFor())).json.token;
  const res = await req('POST', '/api/support/backup', {}, token);
  assert.equal(res.status, 201);
  assert.ok(res.json.backup.bytes > 0);
});

test('restoring a copy that does not exist changes nothing', async () => {
  // Checked before anything is staged. A path that got as far as writing a
  // file beside the database and then failed would restart the shop onto
  // whatever it had written.
  const token = (await goIn(ticketFor())).json.token;
  const res = await req('POST', '/api/support/restore', { name: '../../etc/passwd' }, token);
  assert.equal(res.status, 404);

  // Still up, still answering.
  assert.equal((await req('GET', '/api/health')).status, 200);
});

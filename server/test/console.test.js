/**
 * The vendor's console.
 *
 * This is the most dangerous login in the system: it can stop every shop on the
 * machine at once, and it sits on the open internet behind one password. So
 * most of what follows is about what it refuses rather than what it does.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleApp } from '../src/control/app.js';
import { ensureControlSchema } from '../src/lib/control.js';
import { addDays, today } from '../src/lib/licence.js';
import {
  MAX_ATTEMPTS,
  createOperator,
  ensureOperatorSchema,
  forgetAttempts,
} from '../src/lib/operators.js';

const PORT = 4615;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'a-console-secret-long-enough-to-be-accepted';
const PASSWORD = 'a-properly-long-console-password';

let server;
let workDir;
let control;
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
    // The page itself is HTML.
  }
  return { status: res.status, json };
}

const login = (username, password) => req('POST', '/api/login', { username, password }, null);

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-console-'));
  const controlPath = path.join(workDir, 'control.sqlite');

  control = ensureOperatorSchema(ensureControlSchema(new DatabaseSync(controlPath)));
  createOperator(control, 'walid', PASSWORD);

  control
    .prepare(
      `INSERT INTO tenants (slug, shop_name, owner_phone, plan, price, port, paid_through)
       VALUES ('rami', 'Rami Mobile', '03123456', 'monthly', 25, 4100, ?)`,
    )
    .run(addDays(today(), 20));
  control
    .prepare(
      `INSERT INTO tenants (slug, shop_name, plan, price, port, paid_through)
       VALUES ('nabil', 'Nabil Phones', 'yearly', 240, 4101, ?)`,
    )
    .run(addDays(today(), -30));

  const app = createConsoleApp({ controlDb: controlPath, secret: SECRET, domain: 'xtechpos.com' });
  server = app.listen(PORT, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  token = (await login('walid', PASSWORD)).json.token;
  assert.ok(token);
});

after(() => {
  server?.close();
  control?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => forgetAttempts());

/* ----------------------------------------------------------- getting in */

test('the right password gets a token', async () => {
  const res = await login('walid', PASSWORD);
  assert.equal(res.status, 200);
  assert.ok(res.json.token);
});

test('a wrong password does not', async () => {
  assert.equal((await login('walid', 'not-the-password')).status, 401);
});

test('a wrong username and a wrong password are told apart by nobody', async () => {
  // Which usernames exist is not a hint worth giving away on the one login that
  // can stop every shop on the machine.
  const noSuchUser = await login('nobody-at-all', PASSWORD);
  const wrongPassword = await login('walid', 'not-the-password');
  assert.equal(noSuchUser.status, wrongPassword.status);
  assert.equal(noSuchUser.json.error, wrongPassword.json.error);
});

test('guessing stops being possible after a handful of tries', async () => {
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) await login('walid', `guess-${i}`);

  const blocked = await login('walid', 'guess-again');
  assert.equal(blocked.status, 429);
  assert.match(blocked.json.error, /Too many wrong tries/);

  // And the lockout does not let a correct password through either, or it would
  // be no lockout at all.
  assert.equal((await login('walid', PASSWORD)).status, 429);
});

test('nothing is readable without a token', async () => {
  for (const [method, route] of [
    ['GET', '/api/tenants'],
    ['GET', '/api/commands'],
    ['GET', '/api/tenants/rami/payments'],
    ['POST', '/api/tenants/rami/pay'],
    ['POST', '/api/tenants/rami/suspend'],
  ]) {
    // No body on a GET — fetch refuses to send one, and a request that never
    // leaves is not a test of anything.
    const res = await req(method, route, method === 'POST' ? {} : null, null);
    assert.equal(res.status, 401, `${method} ${route} was open`);
  }
});

test('a token signed with another key is refused', async () => {
  // The tills have signing keys of their own. One of them being accepted here
  // would mean a shop's own admin could stop every other shop.
  const { default: jwt } = await import('jsonwebtoken');
  const forged = jwt.sign({ id: 1, username: 'walid' }, 'a-different-secret-entirely-long-enough');
  assert.equal((await req('GET', '/api/tenants', null, forged)).status, 401);
});

test('a token for a deleted console account stops working', async () => {
  const theirs = (await login('walid', PASSWORD)).json.token;
  assert.equal((await req('GET', '/api/tenants', null, theirs)).status, 200);

  control.prepare(`DELETE FROM operators WHERE username = 'walid'`).run();
  assert.equal((await req('GET', '/api/tenants', null, theirs)).status, 401);

  createOperator(control, 'walid', PASSWORD);
  token = (await login('walid', PASSWORD)).json.token;
});

/* -------------------------------------------------------------- the book */

test('the list says where every shop stands', async () => {
  const { json } = await req('GET', '/api/tenants');
  const rami = json.tenants.find((t) => t.slug === 'rami');
  const nabil = json.tenants.find((t) => t.slug === 'nabil');

  assert.equal(rami.licence.state, 'active');
  assert.equal(rami.address, 'https://rami.xtechpos.com');
  assert.equal(nabil.licence.state, 'locked', 'thirty days past, ten days of grace');
  assert.match(nabil.licence.message, /run out/);
});

test('it counts what the vendor opens it to find out', async () => {
  const { json } = await req('GET', '/api/tenants');
  assert.equal(json.summary.total, 2);
  assert.equal(json.summary.needAttention, 1, 'nabil');
  // A yearly plan counted as its monthly worth, or the two cannot be added up.
  assert.equal(json.summary.monthlyValue, 25 + 240 / 12);
});

test('it never hands out a shop’s own keys', async () => {
  // The console reads the book of shops. The signing keys that protect each
  // till are not in it, and must never be served from here by accident.
  const raw = await (await fetch(`${BASE}/api/tenants`, {
    headers: { Authorization: `Bearer ${token}` },
  })).text();
  assert.ok(!/secret/i.test(raw), 'something secret-shaped is in the reply');
});

/* ------------------------------------------------------------- the money */

test('taking a payment moves the licence and writes it down', async () => {
  const before = (await req('GET', '/api/tenants')).json.tenants.find((t) => t.slug === 'rami');

  const paid = await req('POST', '/api/tenants/rami/pay', { periods: 1, amount: 25, note: 'cash' });
  assert.equal(paid.status, 200);

  // From the day already paid for, not from today.
  const expected = new Date(`${before.paidThrough}T00:00:00Z`);
  expected.setUTCMonth(expected.getUTCMonth() + 1);
  assert.equal(paid.json.paidThrough, expected.toISOString().slice(0, 10));

  const { json } = await req('GET', '/api/tenants/rami/payments');
  assert.equal(json.payments[0].amount, 25);
  assert.equal(json.payments[0].note, 'cash');
  assert.equal(json.payments[0].was_paid_through, before.paidThrough);
});

test('paying a locked shop starts it selling again', async () => {
  const paid = await req('POST', '/api/tenants/nabil/pay', { periods: 1 });
  assert.equal(paid.status, 200);

  const nabil = (await req('GET', '/api/tenants')).json.tenants.find((t) => t.slug === 'nabil');
  assert.notEqual(nabil.licence.state, 'locked');
});

test('a nonsense payment is refused rather than recorded', async () => {
  for (const body of [{ periods: 0 }, { periods: 1.5 }, { periods: 999 }, { amount: -5 }]) {
    const res = await req('POST', '/api/tenants/rami/pay', body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} was accepted`);
  }
});

test('a payment against a shop that does not exist is a 404', async () => {
  assert.equal((await req('POST', '/api/tenants/ghost/pay', { periods: 1 })).status, 404);
});

/* --------------------------------------------------------- the on/off switch */

test('suspending stops a shop, and resuming returns it', async () => {
  await req('POST', '/api/tenants/rami/suspend', { suspended: true });
  let rami = (await req('GET', '/api/tenants')).json.tenants.find((t) => t.slug === 'rami');
  assert.equal(rami.suspended, true);
  assert.equal(rami.licence.state, 'locked');
  assert.equal(rami.licence.reason, 'suspended');

  await req('POST', '/api/tenants/rami/suspend', { suspended: false });
  rami = (await req('GET', '/api/tenants')).json.tenants.find((t) => t.slug === 'rami');
  assert.equal(rami.suspended, false);
  assert.notEqual(rami.licence.state, 'locked');
});

/* ------------------------------------------------- what it will not do */

test('the destructive commands are text to paste, not buttons to press', async () => {
  /*
   * Setting a shop up, taking one off the air and deleting one's data all need
   * root. A page on the open internet that could run those would be worth
   * breaking into — and deleting a shop's books should take somebody sitting at
   * a terminal, not a mis-click on a phone.
   */
  const { json } = await req('GET', '/api/commands');
  assert.match(json.add, /pos-tenant add/);
  assert.match(json.purge, /--yes/);

  for (const [method, route] of [
    ['POST', '/api/tenants'],
    ['DELETE', '/api/tenants/rami'],
    ['POST', '/api/tenants/rami/purge'],
    ['POST', '/api/tenants/rami/remove'],
  ]) {
    const res = await req(method, route, {});
    assert.notEqual(res.status, 200, `${method} ${route} did something`);
  }
});

/* ------------------------------------------------- going into a shop */

test('a visit needs a reason, because the shop is going to read it', async () => {
  // Not a formality: it is what the shop sees on the bar across their screen
  // while the visit lasts, and what stands in their log afterwards.
  for (const body of [{}, { reason: '' }, { reason: 'ok' }]) {
    const res = await req('POST', '/api/tenants/rami/support', body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} was accepted`);
  }
});

test('a link is one address, for one shop, that expires', async () => {
  const res = await req('POST', '/api/tenants/rami/support', {
    reason: 'Rami asked me to fix a price',
  });
  assert.equal(res.status, 200);
  assert.match(res.json.url, /^https:\/\/rami\.xtechpos\.com\/support\?t=[0-9a-f]{64}$/);
  assert.ok(res.json.expiresAt);
});

test('the ticket in the link is not the one in the book', async () => {
  /*
   * The console hands the secret out once and keeps only its hash. A vendor's
   * own backup of the book of shops is then not a set of keys to every till
   * they have ever visited.
   */
  const { json } = await req('POST', '/api/tenants/rami/support', { reason: 'Checking something' });
  const token = new URL(json.url).searchParams.get('t');

  const rows = control.prepare('SELECT * FROM support_tickets').all();
  const stored = JSON.stringify(rows);
  assert.ok(!stored.includes(token), 'the token is stored in the clear');
});

test('there is no going into a shop that is not there', async () => {
  const res = await req('POST', '/api/tenants/ghost/support', { reason: 'Anything at all' });
  assert.equal(res.status, 404);
});

test('reaching a shop that is not running says so rather than hanging', async () => {
  // Nothing is listening on the port in the fixture, which is the same thing a
  // vendor sees when a client's shop is down — and the moment they most need to
  // be told which of the two it is.
  for (const [method, route] of [
    ['GET', '/api/tenants/rami/backups'],
    ['POST', '/api/tenants/rami/backups'],
    ['POST', '/api/tenants/rami/reset-password'],
  ]) {
    const res = await req(method, route, method === 'POST' ? {} : null);
    assert.equal(res.status, 502, `${method} ${route}`);
    assert.match(res.json.error, /Could not reach that shop/);
  }
});

test('a restore has to name a copy', async () => {
  assert.equal((await req('POST', '/api/tenants/rami/restore', {})).status, 400);
});

test('none of it is open without a token', async () => {
  for (const [method, route] of [
    ['POST', '/api/tenants/rami/support'],
    ['GET', '/api/tenants/rami/backups'],
    ['POST', '/api/tenants/rami/restore'],
    ['POST', '/api/tenants/rami/reset-password'],
  ]) {
    const res = await req(method, route, method === 'POST' ? {} : null, null);
    assert.equal(res.status, 401, `${method} ${route} was open`);
  }
});

/* ------------------------------------------- what the shop is allowed */

test('the console lists what can be sold separately', async () => {
  const { json } = await req('GET', '/api/modules');
  const keys = json.modules.map((m) => m.key);
  assert.ok(keys.includes('repairs'));
  assert.ok(keys.includes('transfers'));
  // The till itself is never on the list — a shop with the register switched
  // off has bought nothing, and a switch for it invites somebody to try.
  for (const never of ['register', 'catalogue', 'cashbox', 'settings']) {
    assert.ok(!keys.includes(never), `${never} is offered as something to withhold`);
  }
});

test('a shop starts with everything, and can be cut back', async () => {
  const before = (await req('GET', '/api/tenants')).json.tenants.find((t) => t.slug === 'rami');
  assert.ok(before.modules.includes('transfers'), 'a new shop was sold less than the whole app');

  const set = await req('POST', '/api/tenants/rami/modules', { modules: ['repairs', 'sims'] });
  assert.equal(set.status, 200);
  assert.deepEqual(set.json.modules, ['repairs', 'sims']);

  const after = (await req('GET', '/api/tenants')).json.tenants.find((t) => t.slug === 'rami');
  assert.deepEqual(after.modules, ['repairs', 'sims']);
});

test('a feature that does not exist is refused rather than stored', async () => {
  const res = await req('POST', '/api/tenants/rami/modules', { modules: ['repairs', 'telegrams'] });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /telegrams/);
});

test('the fee can be renegotiated without moving what they have paid for', async () => {
  /*
   * A shop that has paid to March has paid to March whatever it agrees to pay
   * from now on. Quietly re-dating the licence off a price change is how
   * somebody loses a month they already paid for.
   */
  const before = (await req('GET', '/api/tenants')).json.tenants.find((t) => t.slug === 'rami');

  const res = await req('POST', '/api/tenants/rami/plan', { plan: 'yearly', price: 240 });
  assert.equal(res.status, 200);

  const after = (await req('GET', '/api/tenants')).json.tenants.find((t) => t.slug === 'rami');
  assert.equal(after.plan, 'yearly');
  assert.equal(after.price, 240);
  assert.equal(after.paidThrough, before.paidThrough, 'changing the fee moved their licence');
});

test('a nonsense fee is refused', async () => {
  for (const body of [{ plan: 'weekly' }, { price: -5 }, { price: 'free' }]) {
    const res = await req('POST', '/api/tenants/rami/plan', body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} was accepted`);
  }
});

test('neither is open without a token', async () => {
  // No body on the GET — fetch refuses to send one, and a request that never
  // leaves is not a test of anything.
  for (const [method, route] of [
    ['GET', '/api/modules'],
    ['POST', '/api/tenants/rami/modules'],
    ['POST', '/api/tenants/rami/plan'],
  ]) {
    const res = await req(method, route, method === 'POST' ? {} : null, null);
    assert.equal(res.status, 401, `${method} ${route} was open`);
  }
});

test('the page itself is served, and is not an API 404', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Shops/);
});

test('a mistyped API route says so in JSON rather than handing back the page', async () => {
  const res = await req('GET', '/api/nothing-here');
  assert.equal(res.status, 404);
  assert.equal(res.json.error, 'Not found');
});

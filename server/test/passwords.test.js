/**
 * Changing a password, and what that is supposed to do to everybody's sessions.
 *
 * The half of "reset the password" that people assume already happens is the
 * signing-out. A reset that leaves the old session working is not a reset; it
 * is a note to self, and the twelve hours it stays valid are exactly the hours
 * somebody wanted that account closed.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4600;
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
    // Some replies legitimately carry no body.
  }
  return { status: res.status, json };
}

const login = (username, password) => req('POST', '/auth/login', { username, password });

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-pw-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'test.sqlite'),
    JWT_SECRET: 'test-secret-long-enough-for-the-production-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env });
  assert.equal(seed.status, 0);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  adminToken = (await login('admin', 'admin123')).json.token;
  assert.ok(adminToken);
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------ the demo accounts */

test('a freshly seeded account is flagged as still on its demo password', async () => {
  const me = await req('GET', '/auth/me', null, adminToken);
  assert.equal(me.json.user.mustChangePassword, true);
});

test('the passwords this app ships with are refused as new ones', async () => {
  for (const shipped of ['admin123', 'cashier123']) {
    const res = await req(
      'POST',
      '/auth/password',
      { currentPassword: 'admin123', newPassword: shipped },
      adminToken,
    );
    assert.equal(res.status, 400, `${shipped} was accepted`);
  }
});

test('a short password is refused', async () => {
  const res = await req(
    'POST',
    '/auth/password',
    { currentPassword: 'admin123', newPassword: 'short1' },
    adminToken,
  );
  assert.equal(res.status, 400);
});

test('the wrong current password is refused, even while signed in', async () => {
  // The screen somebody walked away from is signed in too.
  const res = await req(
    'POST',
    '/auth/password',
    { currentPassword: 'not-it', newPassword: 'a-perfectly-good-one' },
    adminToken,
  );
  assert.equal(res.status, 401);
});

/* ------------------------------------------------ changing your own */

test('changing your own password works, and hands back a working token', async () => {
  const res = await req(
    'POST',
    '/auth/password',
    { currentPassword: 'admin123', newPassword: 'a-real-password-now' },
    adminToken,
  );
  assert.equal(res.status, 200);
  assert.ok(res.json.token);
  assert.equal(res.json.user.mustChangePassword, false);

  // The new token works straight away — the owner is not signed out by their
  // own change, which would be a strange reward for doing the right thing.
  const me = await req('GET', '/auth/me', null, res.json.token);
  assert.equal(me.status, 200);
  assert.equal(me.json.user.mustChangePassword, false);

  adminToken = res.json.token;
});

test('the old password no longer signs anybody in', async () => {
  assert.equal((await login('admin', 'admin123')).status, 401);
  assert.equal((await login('admin', 'a-real-password-now')).status, 200);
});

/* ------------------------------------------- resetting somebody else's */

test("resetting a cashier's password ends the session they already had", async () => {
  const before = await login('cashier', 'cashier123');
  assert.equal(before.status, 200);
  const cashierToken = before.json.token;

  // Working, right up until the moment it should not be.
  assert.equal((await req('GET', '/auth/me', null, cashierToken)).status, 200);

  /*
   * A second, deliberately.
   *
   * Token issue times are whole seconds, so a session opened in the very second
   * the password changes cannot be told from one opened just after it, and the
   * app resolves that tie in favour of letting it through — otherwise changing
   * your own password would log you out. The case this is about is a session
   * from earlier: the phone in a departing cashier's pocket, which is minutes
   * or hours old, not milliseconds.
   */
  await new Promise((r) => setTimeout(r, 1100));

  const cashierId = before.json.user.id;
  const reset = await req(
    'PUT',
    `/users/${cashierId}/password`,
    { password: 'they-have-left-us' },
    adminToken,
  );
  assert.equal(reset.status, 200);

  // The phone in their pocket, now.
  const after = await req('GET', '/auth/me', null, cashierToken);
  assert.equal(after.status, 401);

  assert.equal((await login('cashier', 'cashier123')).status, 401);
  assert.equal((await login('cashier', 'they-have-left-us')).status, 200);
});

test('an owner cannot reset their own password by that route', async () => {
  // It hands back no token, so it would sign the owner out of the screen they
  // are standing at — and it would not ask for the current password on the way.
  const me = await req('GET', '/auth/me', null, adminToken);
  const res = await req(
    'PUT',
    `/users/${me.json.user.id}/password`,
    { password: 'something-else-entirely' },
    adminToken,
  );
  assert.equal(res.status, 400);

  // And it must not have been changed on the way to saying so.
  assert.equal((await login('admin', 'a-real-password-now')).status, 200);
});

test('a cashier cannot reset anybody else', async () => {
  const cashier = await login('cashier', 'they-have-left-us');
  const me = await req('GET', '/auth/me', null, adminToken);
  const res = await req(
    'PUT',
    `/users/${me.json.user.id}/password`,
    { password: 'a-promotion-by-force' },
    cashier.json.token,
  );
  assert.equal(res.status, 403);
  assert.equal((await login('admin', 'a-real-password-now')).status, 200);
});

test('a token for a deleted account stops working', async () => {
  const made = await req(
    'POST',
    '/users',
    { username: 'temp', password: 'a-temporary-one', name: 'Temp', role: 'cashier' },
    adminToken,
  );
  assert.equal(made.status, 201);

  const theirToken = (await login('temp', 'a-temporary-one')).json.token;
  assert.equal((await req('GET', '/auth/me', null, theirToken)).status, 200);

  await req('DELETE', `/users/${made.json.user.id}`, null, adminToken);
  assert.equal((await req('GET', '/auth/me', null, theirToken)).status, 401);
});

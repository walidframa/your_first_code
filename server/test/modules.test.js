/**
 * What a shop bought, as opposed to what anybody in it may do.
 *
 * Two different questions that look alike and must not be confused. Permissions
 * decide whether *this cashier* may open the drawer, and the shop's own owner
 * passes every one of them. Modules decide whether the shop has the transfer
 * desk **at all** — so the owner is refused too, and that is the part worth
 * testing, because getting it wrong means a shop using a feature it never paid
 * for and nobody finding out.
 *
 * Stored in the vendor's control database for the same reason the licence is: a
 * shop's admin has full rights over every table in their own database.
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
import { MODULE_KEYS, parseModules, serialiseModules } from '../src/lib/modules.js';
import { addDays, today } from '../src/lib/licence.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4620;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let workDir;
let control;
let adminToken;

async function req(method, route, body, token = adminToken) {
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
    // Not everything answers in JSON.
  }
  return { status: res.status, json };
}

/** Sell this shop a particular set of features, as the console would. */
const sell = (keys) =>
  control.prepare('UPDATE tenants SET modules = ? WHERE slug = ?').run(serialiseModules(keys), 'rami');

const sellEverything = () =>
  control.prepare('UPDATE tenants SET modules = NULL WHERE slug = ?').run('rami');

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-modules-'));
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
    JWT_SECRET: 'modules-test-secret-long-enough-for-the-guard',
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

  adminToken = (await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' }, null))
    .json.token;
  assert.ok(adminToken);
});

after(() => {
  child?.kill();
  control?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------- reading the list */

test('a shop sold the whole app keeps the whole app', () => {
  // Every shop already running has NULL here, and a column added underneath
  // them must not take away the transfer desk they have used all year.
  assert.deepEqual(parseModules(null), MODULE_KEYS);
  assert.deepEqual(parseModules(''), MODULE_KEYS);
});

test('an unreadable list is treated as everything, not as nothing', () => {
  // A corrupted column must not take a working shop's features away in the
  // middle of a trading day.
  assert.deepEqual(parseModules('{not json'), MODULE_KEYS);
  assert.deepEqual(parseModules('"repairs"'), MODULE_KEYS);
});

test('a feature the app no longer has is dropped rather than carried', () => {
  assert.deepEqual(parseModules('["repairs","telegrams"]'), ['repairs']);
});

/* --------------------------------------------------- what the till refuses */

test('a shop that bought everything can reach everything', async () => {
  sellEverything();
  for (const route of ['/api/repairs', '/api/transfers', '/api/vouchers', '/api/sims']) {
    const res = await req('GET', route);
    assert.notEqual(res.status, 403, `${route} was refused to a shop that has it`);
  }
});

test('a feature not bought is refused, and says which', async () => {
  sell(['repairs']);

  const res = await req('GET', '/api/transfers');
  assert.equal(res.status, 403);
  assert.equal(res.json.module, 'transfers');
  assert.match(res.json.error, /Transfer desk/);
});

test('the shop’s own owner is refused too', async () => {
  /*
   * The whole difference between this and permissions. An owner passes every
   * permission there is; they still cannot use a feature the shop is not
   * paying for, or the switch means nothing.
   */
  sell(['repairs']);
  const me = await req('GET', '/api/auth/me');
  assert.equal(me.json.user.role, 'admin');
  assert.equal((await req('POST', '/api/transfers', { kind: 'send' })).status, 403);
});

test('what was bought still works while the rest is off', async () => {
  sell(['repairs']);
  assert.notEqual((await req('GET', '/api/repairs')).status, 403);
});

test('the till itself is never for sale', async () => {
  /*
   * A shop with the register, the catalogue, stock or the cashbox switched off
   * has not bought a cheaper copy of this app — it has bought nothing. There is
   * no switch for them, and this is what says so.
   */
  sell([]);
  for (const route of ['/api/products', '/api/orders', '/api/cash/current', '/api/settings']) {
    const res = await req('GET', route);
    assert.notEqual(res.status, 403, `${route} was refused, and it is part of the till`);
  }
});

test('turning one back on needs no restart', async () => {
  // The shop's process reads the book on every call, so the vendor pressing a
  // tick in the console is enough — nobody has to be told to refresh anything.
  sell(['repairs']);
  assert.equal((await req('GET', '/api/transfers')).status, 403);

  sell(['repairs', 'transfers']);
  assert.notEqual((await req('GET', '/api/transfers')).status, 403);
});

/* ------------------------------------------------- what the app is told */

test('the app is told what it has before anybody signs in', async () => {
  // On the licence call the client already makes, so the menu is right on the
  // first paint rather than offering a screen and then taking it away.
  sell(['repairs', 'sims']);
  const { json } = await req('GET', '/api/licence', null, null);
  assert.deepEqual(json.modules, ['repairs', 'sims']);
});

test('a copy that is nobody’s tenant has the lot', async () => {
  /*
   * The vendor's own shop, and anybody running this for themselves. It has no
   * control database, so there is nothing to read a plan out of — and the
   * answer must be "everything" rather than "nothing", or the app would ship
   * with every feature switched off.
   */
  const plainDir = mkdtempSync(path.join(tmpdir(), 'pos-plain-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(plainDir, 'shop.sqlite'),
    JWT_SECRET: 'plain-copy-secret-long-enough-for-the-guard',
    BACKUP_DIR: path.join(plainDir, 'backups'),
    PORT: String(PORT + 1),
    NODE_ENV: 'test',
  };
  assert.equal(spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env }).status, 0);
  const plain = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });

  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT + 1}/api/health`)).ok) break;
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const res = await fetch(`http://127.0.0.1:${PORT + 1}/api/licence`);
    assert.deepEqual((await res.json()).modules, MODULE_KEYS);
  } finally {
    plain.kill();
    rmSync(plainDir, { recursive: true, force: true });
  }
});

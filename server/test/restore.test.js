/**
 * Putting a shop back to yesterday.
 *
 * A restore replaces the file the server is holding open, which cannot be done
 * safely by the server that is holding it. So it happens in two halves: the
 * running process writes the chosen copy down beside its database and stands
 * down; the next boot swaps it in before anything opens anything.
 *
 * The halves are in different files and only meet across a restart, which is
 * the one arrangement a unit test cannot check by reading either half. So this
 * does what systemd would: starts it, restores, waits for it to stop, starts it
 * again, and looks at what came back.
 *
 * There is no undo for getting this wrong. A restore that half-happened, or
 * that stood on a good database with a truncated file, is a shop's whole
 * history — every sale, every customer, every repair.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureControlSchema } from '../src/lib/control.js';
import { mintTicket } from '../src/lib/supportTickets.js';
import { addDays, today } from '../src/lib/licence.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4617;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let workDir;
let control;
let env;

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
    // Not everything answers in JSON.
  }
  return { status: res.status, json };
}

async function waitUntilUp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** What systemd does, and what this test has to do in its place. */
async function startShop() {
  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  assert.ok(await waitUntilUp(), 'the shop did not come up');
}

async function waitUntilDown(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** A visit, since the restore door is open only to one. */
async function visitToken(reason = 'Restoring') {
  const { token } = mintTicket(control, { slug: 'rami', operator: 'walid', reason });
  const res = await req('POST', '/api/support/redeem', { token });
  assert.equal(res.status, 200, 'could not get into the shop');
  return res.json.token;
}

const signIn = (password) =>
  req('POST', '/api/auth/login', { username: 'admin', password }).then((r) => r.json.token);

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-restore-'));
  const controlPath = path.join(workDir, 'control.sqlite');

  control = ensureControlSchema(new DatabaseSync(controlPath));
  control
    .prepare(
      `INSERT INTO tenants (slug, shop_name, plan, paid_through, grace_days)
       VALUES ('rami', 'Rami Mobile', 'monthly', ?, 10)`,
    )
    .run(addDays(today(), 30));

  env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'restore-test-secret-long-enough-for-the-guard',
    BACKUP_DIR: path.join(workDir, 'backups'),
    CONTROL_DB: controlPath,
    TENANT_SLUG: 'rami',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  assert.equal(spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env }).status, 0);
  await startShop();
});

after(() => {
  child?.kill();
  control?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a shop goes back to how it was, and says where "now" was saved', async () => {
  const admin = await signIn('admin123');

  // Something to lose, and something to find again.
  const before = await req('POST', '/api/products', {
    name: 'Before the restore',
    sku: 'BEFORE-1',
    price: 10,
  }, admin);
  assert.equal(before.status, 201);

  const copy = (await req('POST', '/api/support/backup', {}, await visitToken())).json.backup;
  assert.ok(copy.name);

  // Now do the thing somebody would want undone.
  const after = await req('POST', '/api/products', {
    name: 'A mistake',
    sku: 'MISTAKE-1',
    price: 999,
  }, admin);
  assert.equal(after.status, 201);

  const restore = await req('POST', '/api/support/restore', { name: copy.name }, await visitToken());
  assert.equal(restore.status, 200);
  assert.ok(restore.json.safetyCopy, 'nothing was kept of where the shop was');
  assert.notEqual(restore.json.safetyCopy, copy.name);

  // It answered first and stood down after — a restart that beat its own reply
  // out of the door would look to the console exactly like a crash.
  assert.ok(await waitUntilDown(), 'the shop did not stand down');
  await startShop();

  const back = await signIn('admin123');
  const skus = (await req('GET', '/api/products', null, back)).json.products.map((p) => p.sku);
  assert.ok(skus.includes('BEFORE-1'), 'the restore lost what was there before');
  assert.ok(!skus.includes('MISTAKE-1'), 'the restore did not undo anything');
});

test('the copy of where it was is a real one, and holds what was undone', async () => {
  // The safety copy is the only way back from a restore somebody regrets, so
  // "a file was written" is not enough — it has to open, and have the work in
  // it. Restored from, it would put MISTAKE-1 back.
  const admin = await signIn('admin123');
  const { backups } = (await req('GET', '/api/backups', null, admin)).json;
  assert.ok(backups.length >= 2);

  const newest = new DatabaseSync(path.join(workDir, 'backups', backups[0].name), {
    readOnly: true,
  });
  const found = newest.prepare('SELECT sku FROM products WHERE sku = ?').get('MISTAKE-1');
  newest.close();
  assert.ok(found, 'the safety copy does not contain the work it was taken to protect');
});

test('a staged file that is not a database is refused, and the shop still opens', async () => {
  /*
   * The worst available outcome is a shop that will not start because something
   * unreadable was put in its place — the restore fails *and* the till is down.
   * So a staged file is opened and read before anything is replaced, and a bad
   * one is dropped rather than stood on.
   */
  child.kill();
  assert.ok(await waitUntilDown());

  writeFileSync(`${env.DB_PATH}.restore`, 'this is not a database');
  await startShop();

  const admin = await signIn('admin123');
  const skus = (await req('GET', '/api/products', null, admin)).json.products.map((p) => p.sku);
  assert.ok(skus.includes('BEFORE-1'), 'a junk file replaced a working shop');
});

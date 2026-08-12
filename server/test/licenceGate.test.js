/**
 * What a shop can and cannot do once its licence has run out.
 *
 * The rule is drawn at trading, not at access, and the two halves are equally
 * load-bearing: a locked shop must not be able to take a single pound, and it
 * must not lose its own books. The second half is not generosity — a sales
 * history is an accounting record, and a vendor holding one behind an unpaid
 * invoice has a problem of their own rather than leverage.
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
import { addDays, today } from '../src/lib/licence.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4614;
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

/** Move this shop's licence, as the vendor's console would. */
function setLicence(fields) {
  const sets = Object.keys(fields)
    .map((k) => `${k} = ?`)
    .join(', ');
  control.prepare(`UPDATE tenants SET ${sets} WHERE slug = 'rami'`).run(...Object.values(fields));
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-licence-'));
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
    JWT_SECRET: 'licence-test-secret-long-enough-for-the-guard',
    BACKUP_DIR: path.join(workDir, 'backups'),
    CONTROL_DB: controlPath,
    TENANT_SLUG: 'rami',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env });
  assert.equal(seed.status, 0);

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
  assert.ok(adminToken);
  await req('POST', '/api/cash/open', { openingUsd: 100 }, adminToken);
});

after(() => {
  child?.kill();
  control?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const sell = () =>
  req(
    'POST',
    '/api/orders',
    { items: [{ productId: 1, quantity: 1 }], paymentMethod: 'card' },
    adminToken,
  );

/* ------------------------------------------------------- while it is paid */

test('a paid shop sells, and is told nothing', async () => {
  assert.equal((await sell()).status, 201);
  const { json } = await req('GET', '/api/licence');
  assert.equal(json.licence.state, 'active');
  assert.equal(json.licence.message, '');
});

test('inside the last fortnight it sells, and says so', async () => {
  setLicence({ paid_through: addDays(today(), 3) });
  assert.equal((await sell()).status, 201, 'a warning must not stop the till');

  const { json } = await req('GET', '/api/licence');
  assert.equal(json.licence.state, 'due');
  assert.match(json.licence.message, /runs out in 3 days/);
});

test('past the deadline but inside grace, it still sells', async () => {
  // The ten days exist so that a late payment is an inconvenience rather than a
  // closed shop. They would be worth nothing if the till stopped anyway.
  setLicence({ paid_through: addDays(today(), -5) });
  assert.equal((await sell()).status, 201);

  const { json } = await req('GET', '/api/licence');
  assert.equal(json.licence.state, 'overdue');
  assert.match(json.licence.message, /Selling stops on/);
});

/* ------------------------------------------------------------ once locked */

test('past grace, a sale is refused with the reason', async () => {
  setLicence({ paid_through: addDays(today(), -11) });
  const res = await sell();
  assert.equal(res.status, 402, 'the one code that means exactly this');
  assert.equal(res.json.licence.state, 'locked');
  assert.match(res.json.error, /run out/);
});

test('and so is everything else that touches the books', async () => {
  for (const [method, route, body] of [
    ['POST', '/api/expenses', { amount: 5, category: 'other', note: 'x' }],
    ['POST', '/api/products', { name: 'x', sku: 'x', price: 1 }],
    ['POST', '/api/cash/close', { countedUsd: 0 }],
    ['GET', '/api/reports/summary', null],
    ['GET', '/api/products', null],
  ]) {
    const res = await req(method, route, body, adminToken);
    assert.equal(res.status, 402, `${method} ${route} was allowed`);
  }
});

test('but the owner can still sign in', async () => {
  // Locking somebody out of their own account as well would be a second
  // punishment for the same thing, and would stop them reaching the copy below.
  const res = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  assert.equal(res.status, 200);
  assert.ok(res.json.token);
});

test('and can still take their own data away', async () => {
  // A sales history is the shop's accounting record. Holding it behind an
  // unpaid invoice is the vendor's problem, not their leverage.
  const made = await req('POST', '/api/backups', null, adminToken);
  assert.equal(made.status, 201, 'a locked shop must still be able to make a copy');

  const list = await req('GET', '/api/backups', null, adminToken);
  assert.equal(list.status, 200);
  assert.ok(list.json.backups.length > 0);

  const file = await fetch(`${BASE}/api/backups/${list.json.backups[0].name}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(file.status, 200);
  assert.ok(Number(file.headers.get('content-length')) > 0, 'the download is not empty');
});

test('and can read why it stopped without signing in at all', async () => {
  const res = await req('GET', '/api/licence');
  assert.equal(res.status, 200);
  assert.equal(res.json.licence.state, 'locked');
});

/* ------------------------------------------------------- the vendor's switch */

test('taking the payment starts it selling again on the next tap', async () => {
  // No cache to wait out: a shopkeeper who has just paid is standing at the
  // counter with a customer.
  setLicence({ paid_through: addDays(today(), 30) });
  assert.equal((await sell()).status, 201);
});

test('suspending stops it whatever the dates say, and unsuspending returns it', async () => {
  setLicence({ suspended: 1 });
  const stopped = await sell();
  assert.equal(stopped.status, 402);
  assert.equal(stopped.json.licence.reason, 'suspended');

  setLicence({ suspended: 0 });
  assert.equal((await sell()).status, 201);
});

test('a shop removed from the book stops selling', async () => {
  control.prepare(`UPDATE tenants SET removed_at = datetime('now') WHERE slug = 'rami'`).run();
  const res = await sell();
  assert.equal(res.status, 402);
  assert.equal(
    res.json.licence.reason,
    'unknown_tenant',
    'a row that has gone must lock, not hand out the app for free',
  );

  control.prepare(`UPDATE tenants SET removed_at = NULL WHERE slug = 'rami'`).run();
  assert.equal((await sell()).status, 201);
});

test('the app itself is always served, so the lock can explain itself', async () => {
  /*
   * The gate sits in front of the built client as well as the API. Refusing
   * everything would hand a locked shop a page of JSON where the screen
   * explaining the lock should be — no way to pay, and no way to reach their
   * own records either.
   */
  control.prepare(`UPDATE tenants SET paid_through = ? WHERE slug = 'rami'`).run(addDays(today(), -60));

  const page = await fetch(`${BASE}/`);
  assert.notEqual(page.status, 402, 'the app shell must load');

  const asset = await fetch(`${BASE}/some/deep/app/route`);
  assert.notEqual(asset.status, 402, 'and so must any route the app owns');
});

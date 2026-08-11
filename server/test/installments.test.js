/**
 * Paying for a phone over months, and keeping copies of the books.
 *
 * The thing to hold onto for instalments is that a plan is a **schedule over a
 * debt that already exists**, not a second set of books. The ledger says what
 * is owed; the plan says when the shop expects it. These tests keep the two
 * from drifting, because the day they disagree the ledger is right and the plan
 * is a liar with a nice table.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { split, monthlyDates } from '../src/lib/installments.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4604;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let customerId;

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

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-instal-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'instal.sqlite'),
    BACKUP_DIR: path.join(workDir, 'backups'),
    JWT_SECRET: 'installments-test-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;

  customerId = (
    await req(
      'POST',
      '/customers',
      { name: 'Rami Haddad', phone: '03 456 789', credit_limit: 1000 },
      adminToken,
    )
  ).json.party.id;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ arithmetic */

test('an amount that will not divide evenly still adds up', () => {
  const parts = split(100, 3);
  assert.deepEqual(parts, [33.34, 33.33, 33.33]);
  assert.equal(
    Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100,
    100,
    'the instalments are the whole debt, to the cent',
  );
});

test('the odd cents go on the first payment, not the last', () => {
  // Somebody who has paid the same figure for months should not meet a
  // different one at the end.
  const [first, ...rest] = split(10, 3);
  assert.ok(first >= rest[0]);
  assert.equal(rest.at(-1), rest[0], 'every later payment is the same');
});

test('a plan started on the 31st does not skip February', () => {
  const dates = monthlyDates('2026-01-31', 4);
  assert.deepEqual(dates, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});

/* ----------------------------------------------------------------- plans */

test('a plan schedules a debt the customer already has', async () => {
  // The phone went out on account the ordinary way, so the ledger already says
  // what is owed before any plan exists.
  await req(
    'POST',
    `/customers/${customerId}/charges`,
    { amount: 400, note: 'iPhone 13' },
    adminToken,
  );
  const owedBefore = (await req('GET', `/customers/${customerId}`, null, adminToken)).json.party.balance;
  assert.equal(owedBefore, 400);

  const res = await req(
    'POST',
    '/installments',
    { customerId, total: 400, count: 4, startDate: '2026-09-01', note: 'iPhone 13' },
    adminToken,
  );
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.plan.dues.length, 4);
  assert.equal(res.json.plan.outstandingUsd, 400);

  // Scheduling it changed nothing about what is owed.
  const owedAfter = (await req('GET', `/customers/${customerId}`, null, adminToken)).json.party.balance;
  assert.equal(owedAfter, 400, 'a plan is a schedule, not a second debt');
});

test('a payment settles the earliest month and comes off the account', async () => {
  const plan = (await req('GET', '/installments', null, adminToken)).json.plans[0];

  const res = await req(
    'POST',
    `/installments/${plan.id}/payments`,
    { payments: [{ currency: 'USD', amount: 100 }] },
    adminToken,
  );
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.allocated, 100);
  assert.equal(res.json.plan.dues[0].paid_usd, 100, 'the first month is settled');
  assert.equal(res.json.plan.dues[1].paid_usd, 0, 'the second is untouched');

  // And the ledger — the thing that actually says what is owed — moved with it.
  assert.equal(res.json.balance, 300);
  assert.equal(res.json.plan.outstandingUsd, 300);
});

test('a payment bigger than one month spills into the next', async () => {
  const plan = (await req('GET', '/installments', null, adminToken)).json.plans[0];

  const res = await req(
    'POST',
    `/installments/${plan.id}/payments`,
    { payments: [{ currency: 'USD', amount: 150 }] },
    adminToken,
  );
  assert.equal(res.json.plan.dues[1].paid_usd, 100, 'the second month in full');
  assert.equal(res.json.plan.dues[2].paid_usd, 50, 'and half of the third');
  assert.equal(res.json.plan.outstandingUsd, 150);
});

test('paying it off marks the plan settled', async () => {
  const plan = (await req('GET', '/installments', null, adminToken)).json.plans[0];

  const res = await req(
    'POST',
    `/installments/${plan.id}/payments`,
    { payments: [{ currency: 'USD', amount: 150 }] },
    adminToken,
  );
  assert.equal(res.json.plan.status, 'settled');
  assert.equal(res.json.plan.outstandingUsd, 0);
  assert.equal(res.json.balance, 0, 'and the customer owes nothing');
});

test('a plan due in the past is overdue, without anything having run', async () => {
  const res = await req(
    'POST',
    '/installments',
    { customerId, total: 200, count: 2, startDate: '2020-01-01' },
    adminToken,
  );
  const plan = res.json.plan;

  assert.equal(plan.overdueCount, 2, 'both payments are long past');
  assert.equal(plan.overdueUsd, 200);
  assert.equal(plan.nextDue.date, '2020-01-01');
});

test('the reminder says what is late and what is left', async () => {
  const plans = (await req('GET', '/installments?status=active', null, adminToken)).json.plans;
  const late = plans.find((p) => p.overdueCount > 0);

  const res = await req('GET', `/installments/${late.id}/whatsapp`, null, adminToken);
  assert.equal(res.status, 200);
  assert.match(res.json.text, /overdue/i);
  assert.match(res.json.text, /\$200\.00/);
  // Addressed to the number on file, in a form WhatsApp will take.
  assert.equal(res.json.to, '9613456789');
});

test('cancelling stops the chasing without forgiving the debt', async () => {
  const plans = (await req('GET', '/installments?status=active', null, adminToken)).json.plans;
  const owedBefore = (await req('GET', `/customers/${customerId}`, null, adminToken)).json.party.balance;

  const res = await req('POST', `/installments/${plans[0].id}/cancel`, null, adminToken);
  assert.equal(res.json.plan.status, 'cancelled');

  const owedAfter = (await req('GET', `/customers/${customerId}`, null, adminToken)).json.party.balance;
  assert.equal(owedAfter, owedBefore, 'what they owe is the ledger’s business, not the plan’s');
});

test('a plan needs a customer, a positive amount and a first date', async () => {
  const bad = [
    [{ customerId, total: 0, count: 4, startDate: '2026-09-01' }, /how much/i],
    [{ customerId, total: 100, count: 0, startDate: '2026-09-01' }, /between 1 and 60/i],
    [{ customerId, total: 100, count: 4, startDate: 'soon' }, /when the first/i],
  ];
  for (const [body, expected] of bad) {
    const res = await req('POST', '/installments', body, adminToken);
    assert.equal(res.status, 400);
    assert.match(res.json.error, expected);
  }
});

/* --------------------------------------------------------------- backups */

test('a backup can be taken, listed and downloaded', async () => {
  const made = await req('POST', '/backups', null, adminToken);
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.match(made.json.backup.name, /^pos-\d{4}-\d{2}-\d{2}T/);
  assert.ok(made.json.backup.bytes > 0, 'an empty backup is not a backup');

  const list = await req('GET', '/backups', null, adminToken);
  assert.ok(list.json.backups.some((b) => b.name === made.json.backup.name));
  assert.ok(existsSync(path.join(list.json.directory, made.json.backup.name)));
});

test('a backup opens as a database with the shop inside it', async () => {
  const { json } = await req('GET', '/backups', null, adminToken);
  const file = path.join(json.directory, json.backups[0].name);

  // The point of VACUUM INTO over copying the file: this has to open cleanly
  // while the server is still running and writing.
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(file, { readOnly: true });
  const { n } = copy.prepare('SELECT COUNT(*) AS n FROM customers').get();
  copy.close();
  assert.ok(n > 0, 'the copy has the customers in it');
});

test('a name that is not one of ours is not served', async () => {
  for (const name of ['../data.sqlite', 'nope.sqlite']) {
    const res = await fetch(`${BASE}/backups/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 404);
  }
});

test('backups are not for whoever happens to be signed in', async () => {
  const cashier = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' }))
    .json.token;

  // The file is the whole shop, including the passwords it holds for customers.
  assert.equal((await req('GET', '/backups', null, cashier)).status, 403);
  assert.equal((await req('POST', '/backups', null, cashier)).status, 403);
});

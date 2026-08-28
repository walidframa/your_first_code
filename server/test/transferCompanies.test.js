/**
 * The agencies the shop runs a transfer counter for.
 *
 * Two things are being checked, and the first matters more than the second.
 *
 * One: the migration. Widening a CHECK in SQLite means rebuilding the table,
 * and `account_entries` is where every balance in the shop comes from. A
 * rebuild that loses a row, or renumbers one, breaks money that was right
 * yesterday — so a database is built in the *old* shape, filled, migrated, and
 * checked row for row.
 *
 * Two: the ledger itself. A send leaves the shop holding the agency's money; a
 * payout leaves the agency owing the shop; the fee is the shop's either way and
 * belongs in neither.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 4591-4609 and 4613-4620 are spoken for; 4610 and 4611 belong to the e2e run.
const PORT = 4621;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let deskToken;
let till;

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

const agencies = async () => (await req('GET', '/transfers/companies', null, adminToken)).json.companies;
const named = async (name) => (await agencies()).find((c) => c.name === name);

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-agencies-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'agencies.sqlite'),
    JWT_SECRET: 'agencies-test-secret-long-enough-for-guard',
    ACCOUNT_SECRET: 'agencies-account-secret-long-enough-32c',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;

  const meta = (await req('GET', '/transfers/meta', null, adminToken)).json;
  till = meta.tills.find((t) => t.is_default) || meta.tills[0];
  await req('POST', '/cash/open', { accountId: till.id, openingUsd: 1000 }, adminToken);

  // Somebody who runs the transfer desk and does not own the shop.
  const staff = (await req('GET', '/users', null, adminToken)).json.users.find(
    (u) => u.username === 'cashier',
  );
  await req(
    'PUT',
    `/users/${staff.id}/permissions`,
    { permissions: ['register', 'transfers'] },
    adminToken,
  );
  deskToken = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' })).json
    .token;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------- migration */

test('the ledger is rebuilt without losing or renumbering a single entry', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pos-migrate-'));
  const file = path.join(dir, 'old.sqlite');

  try {
    // A database in the shape it had before agencies existed, with entries in
    // it whose ids other tables point at.
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE account_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        party_type TEXT NOT NULL CHECK (party_type IN ('customer', 'supplier')),
        party_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('sale', 'payment', 'refund', 'bill', 'adjustment', 'opening')),
        amount_usd REAL NOT NULL,
        paid_usd REAL NOT NULL DEFAULT 0,
        paid_lbp REAL NOT NULL DEFAULT 0,
        exchange_rate REAL,
        order_id INTEGER,
        note TEXT,
        user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const insert = old.prepare(
      `INSERT INTO account_entries (id, party_type, party_id, kind, amount_usd, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(1, 'customer', 7, 'sale', 120.5, 'a sale on account');
    insert.run(2, 'supplier', 3, 'bill', 400, 'a delivery');
    // A gap, because ids are not necessarily contiguous and the rebuild must
    // not quietly close one up.
    insert.run(9, 'customer', 7, 'payment', -50, 'paid something off');
    const before = old.prepare('SELECT * FROM account_entries ORDER BY id').all();
    old.close();

    // Opening it through the app runs every migration.
    const env = {
      ...process.env,
      DB_PATH: file,
      JWT_SECRET: 'migrate-test-secret-long-enough-for-guard',
      ACCOUNT_SECRET: 'migrate-account-secret-long-enough-32ch',
      NODE_ENV: 'test',
    };
    const opened = spawnSync(
      process.execPath,
      ['-e', "import('./src/db.js').then(() => process.exit(0))"],
      { cwd: serverRoot, env, encoding: 'utf8' },
    );
    assert.equal(opened.status, 0, `opening the old database failed: ${opened.stderr}`);

    const migrated = new DatabaseSync(file);
    const after_ = migrated.prepare('SELECT * FROM account_entries ORDER BY id').all();

    assert.deepEqual(
      after_.map((r) => [r.id, r.party_type, r.party_id, r.kind, r.amount_usd, r.note]),
      before.map((r) => [r.id, r.party_type, r.party_id, r.kind, r.amount_usd, r.note]),
      'every row came across unchanged, ids included',
    );

    // And the widened table accepts what the old one refused.
    migrated.exec("INSERT INTO transfer_companies (name) VALUES ('OMT')");
    migrated
      .prepare(
        `INSERT INTO account_entries (party_type, party_id, kind, amount_usd)
         VALUES ('transfer_company', 1, 'bill', 25)`,
      )
      .run();

    // The next id carries on past the gap rather than colliding with row 9.
    const last = migrated.prepare('SELECT MAX(id) AS n FROM account_entries').get();
    assert.equal(last.n, 10);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('and it carries across the columns the table has grown since', async () => {
  /*
   * The bug this closes. The rebuild above listed the columns it copied, and
   * that list was written before `native_usd`, `native_lbp` and `branch_id`
   * existed — so a rebuild threw away every entry's currency split and left
   * `addEntry`, whose INSERT always names those columns, unable to write at all.
   *
   * It hid because seeding and serving are separate processes: the rebuild ran
   * during the seed and the next boot put the columns back, empty. One process
   * doing both — any shop booting against a database it has just made — got a
   * table it could not write an entry to.
   */
  const dir = mkdtempSync(path.join(tmpdir(), 'pos-grown-'));
  const file = path.join(dir, 'old.sqlite');

  try {
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE account_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        party_type TEXT NOT NULL CHECK (party_type IN ('customer', 'supplier')),
        party_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('sale', 'payment', 'refund', 'bill', 'adjustment', 'opening')),
        amount_usd REAL NOT NULL,
        paid_usd REAL NOT NULL DEFAULT 0,
        paid_lbp REAL NOT NULL DEFAULT 0,
        exchange_rate REAL,
        order_id INTEGER,
        note TEXT,
        user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // A shop that has already been through one upgrade: the split columns are
    // there, and carrying real figures.
    old.exec('ALTER TABLE account_entries ADD COLUMN native_usd REAL');
    old.exec('ALTER TABLE account_entries ADD COLUMN native_lbp REAL');
    old
      .prepare(
        `INSERT INTO account_entries
           (id, party_type, party_id, kind, amount_usd, note, native_usd, native_lbp)
         VALUES (1, 'customer', 7, 'payment', -411.24, 'dollars and pounds', -400, -1000000)`,
      )
      .run();
    old.close();

    const env = {
      ...process.env,
      DB_PATH: file,
      JWT_SECRET: 'grown-test-secret-long-enough-for-guard',
      ACCOUNT_SECRET: 'grown-account-secret-long-enough-32chr',
      NODE_ENV: 'test',
    };
    const opened = spawnSync(
      process.execPath,
      ['-e', "import('./src/db.js').then(() => process.exit(0))"],
      { cwd: serverRoot, env, encoding: 'utf8' },
    );
    assert.equal(opened.status, 0, `opening the old database failed: ${opened.stderr}`);

    const migrated = new DatabaseSync(file);
    const names = migrated.prepare('PRAGMA table_info(account_entries)').all().map((c) => c.name);
    assert.ok(names.includes('native_usd'), 'the split survived the rebuild');
    assert.ok(names.includes('native_lbp'));

    const row = migrated.prepare('SELECT * FROM account_entries WHERE id = 1').get();
    assert.equal(row.native_usd, -400, 'and so did what was in it');
    assert.equal(row.native_lbp, -1000000);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a database made and written to by one process can record an entry', async () => {
  /*
   * The shape of the failure as a shop would meet it: one boot, no restart in
   * between. Everything above tests the migration; this tests that the thing
   * the migration exists to serve still works afterwards.
   */
  const dir = mkdtempSync(path.join(tmpdir(), 'pos-oneboot-'));
  try {
    const written = spawnSync(
      process.execPath,
      [
        '-e',
        `Promise.all([import('./src/db.js'), import('./src/lib/accounts.js')]).then(([{ db }, acc]) => {
           db.prepare("INSERT INTO customers (name, active) VALUES ('One boot', 1)").run();
           acc.addEntry({ partyType: 'customer', partyId: 1, kind: 'sale',
                          amountUsd: 100, nativeUsd: 60, nativeLbp: 4000000 });
           process.exit(0);
         }).catch((e) => { console.error(e.message); process.exit(1); })`,
      ],
      {
        cwd: serverRoot,
        env: {
          ...process.env,
          DB_PATH: path.join(dir, 'fresh.sqlite'),
          JWT_SECRET: 'oneboot-secret-long-enough-for-the-guard',
          ACCOUNT_SECRET: 'oneboot-account-secret-long-enough-32c',
          NODE_ENV: 'test',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(written.status, 0, `a fresh database could not take an entry: ${written.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- balance */

test('an agency is opened the first time its name is used', async () => {
  assert.equal((await agencies()).length, 0, 'a new shop deals with nobody yet');

  const sent = await req(
    'POST',
    '/transfers',
    {
      company: 'OMT',
      direction: 'send',
      amountUsd: 200,
      feeUsd: 3,
      accountId: till.id,
      customerName: 'Rami',
    },
    adminToken,
  );
  assert.equal(sent.status, 201);

  const omt = await named('OMT');
  assert.ok(omt, 'the agency was opened by the transfer itself');
  assert.equal(omt.balance, 200, 'the shop is holding their money');
  assert.equal(omt.standing, 'owed_to_company');
});

test('the fee is the shop’s and stays off the agency’s balance', async () => {
  // $200 sent + $3 fee went into the drawer, but only the $200 is theirs.
  assert.equal((await named('OMT')).balance, 200);
});

test('a payout turns the balance round', async () => {
  await req(
    'POST',
    '/transfers',
    { company: 'OMT', direction: 'payout', amountUsd: 350, feeUsd: 2, accountId: till.id },
    adminToken,
  );

  const omt = await named('OMT');
  assert.equal(omt.balance, -150, '200 held less 350 laid out');
  assert.equal(omt.standing, 'owed_to_shop');
});

test('cancelling a transfer takes it back off the agency too', async () => {
  const before = (await named('OMT')).balance;
  const made = await req(
    'POST',
    '/transfers',
    { company: 'OMT', direction: 'send', amountUsd: 75, accountId: till.id },
    adminToken,
  );
  assert.equal((await named('OMT')).balance, before + 75);

  await req('POST', `/transfers/${made.json.transfer.id}/cancel`, null, adminToken);
  assert.equal((await named('OMT')).balance, before, 'a cancelled transfer owes nobody anything');
});

test('each agency counts on its own', async () => {
  await req(
    'POST',
    '/transfers',
    { company: 'Whish', direction: 'send', amountUsd: 40, accountId: till.id },
    adminToken,
  );

  assert.equal((await named('Whish')).balance, 40);
  assert.equal((await named('OMT')).balance, -150, 'untouched by the other counter');
});

/* ---------------------------------------------------------------- opening */

test('a shop already trading can say where its balance starts', async () => {
  const omt = await named('OMT');
  const set = await req(
    'PUT',
    `/transfers/companies/${omt.id}/opening`,
    { amountUsd: 500 },
    adminToken,
  );
  assert.equal(set.status, 200);

  // The opening is added to what the transfers have done since, not instead
  // of it: −150 from the counter, plus 500 carried in.
  assert.equal((await named('OMT')).balance, 350);
});

test('setting it again is a correction, not a second opening', async () => {
  const omt = await named('OMT');
  await req('PUT', `/transfers/companies/${omt.id}/opening`, { amountUsd: 600 }, adminToken);

  assert.equal((await named('OMT')).balance, 450, 'moved by the difference, not by the whole figure');

  const statement = (await req('GET', `/transfers/companies/${omt.id}`, null, adminToken)).json;
  assert.equal(
    statement.entries.filter((e) => e.kind === 'opening').length,
    1,
    'one opening line, however many times it is corrected',
  );
});

/* -------------------------------------------------------------- settling */

test('a voucher settles with an agency and clears the balance', async () => {
  const whish = await named('Whish');
  assert.equal(whish.balance, 40, 'holding their money');

  const paid = await req(
    'POST',
    '/vouchers',
    {
      fromType: 'cash',
      fromId: till.id,
      toType: 'transfer_company',
      toId: whish.id,
      amountUsd: 40,
      reason: 'transfer_agency',
    },
    adminToken,
  );
  assert.equal(paid.status, 201);
  assert.equal(paid.json.voucher.kind, 'payment');

  assert.equal((await named('Whish')).balance, 0, 'settled up');
  assert.equal((await named('Whish')).standing, 'square');
});

test('and the other way round, when the agency owes the shop', async () => {
  let omt = await named('OMT');

  // Square it off first, so the direction being tested is the only thing left.
  await req(
    'POST',
    '/vouchers',
    {
      fromType: 'cash',
      fromId: till.id,
      toType: 'transfer_company',
      toId: omt.id,
      amountUsd: omt.balance,
      reason: 'transfer_agency',
    },
    adminToken,
  );
  assert.equal((await named('OMT')).balance, 0);

  // A payout with nothing held against it: the shop has laid out its own cash
  // on the agency's behalf and is owed it back.
  await req(
    'POST',
    '/transfers',
    { company: 'OMT', direction: 'payout', amountUsd: 80, accountId: till.id },
    adminToken,
  );
  omt = await named('OMT');
  assert.equal(omt.balance, -80);
  assert.equal(omt.standing, 'owed_to_shop');

  // And they make it good.
  const taken = await req(
    'POST',
    '/vouchers',
    {
      fromType: 'transfer_company',
      fromId: omt.id,
      toType: 'cash',
      toId: till.id,
      amountUsd: 80,
      reason: 'transfer_agency',
    },
    adminToken,
  );
  assert.equal(taken.status, 201);
  assert.equal(taken.json.voucher.kind, 'receipt');

  omt = await named('OMT');
  assert.equal(omt.balance, 0, 'square again');
  assert.equal(omt.standing, 'square');
});

/* ------------------------------------------------------------------ desk */

test('an agency can be renamed and put away without losing its history', async () => {
  const whish = await named('Whish');
  const renamed = await req(
    'PUT',
    `/transfers/companies/${whish.id}`,
    { name: 'Whish Money' },
    adminToken,
  );
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.company.name, 'Whish Money');

  await req('PUT', `/transfers/companies/${whish.id}`, { isActive: false }, adminToken);
  assert.ok(!(await named('Whish Money')), 'gone from the working list');

  const all = (await req('GET', '/transfers/companies?all=1', null, adminToken)).json.companies;
  assert.ok(all.some((c) => c.name === 'Whish Money'), 'but still on the books');
});

test('the desk records transfers but does not say where the count starts', async () => {
  const omt = await named('OMT');
  const before = omt.balance;

  // The counter's own work, which is theirs.
  const sent = await req(
    'POST',
    '/transfers',
    { company: 'OMT', direction: 'send', amountUsd: 30, accountId: till.id },
    deskToken,
  );
  assert.equal(sent.status, 201);

  /*
   * The opening balance is not. It is the figure every later balance is
   * measured from, so moving it moves what the shop appears to owe without
   * anything having happened at the counter — which is exactly what somebody
   * who is short would want.
   */
  const tried = await req(
    'PUT',
    `/transfers/companies/${omt.id}/opening`,
    { amountUsd: 5 },
    deskToken,
  );
  assert.equal(tried.status, 403);
  assert.equal((await named('OMT')).balance, before + 30, 'the refusal changed nothing');

  // And the owner still can.
  assert.equal(
    (await req('PUT', `/transfers/companies/${omt.id}/opening`, { amountUsd: 5 }, adminToken)).status,
    200,
  );
});

test('two agencies cannot share a name', async () => {
  const clash = await req('POST', '/transfers/companies', { name: 'OMT' }, adminToken);
  assert.equal(clash.status, 400);
  assert.match(clash.json.error, /already on the list/);
});

/* --------------------------------------------------- settling at the desk */

/**
 * The end of a day.
 *
 * Settling used to mean leaving the counter for the voucher screen and filling
 * in both ends of a general-purpose form — a permission the operator does not
 * have, on a screen they were not on. It is the last thing before locking up,
 * so it happens where the balance that says it is due is.
 *
 * On an agency of its own, because these tests are about what settling does to
 * a balance and the ones above have been moving OMT's around all morning.
 */
const DESK = 'Bob Finance';

test('the operator squares up with an agency without leaving the desk', async () => {
  // A day's sends: the shop is holding the agency's money.
  await req(
    'POST',
    '/transfers',
    { company: DESK, direction: 'send', amountUsd: 100, accountId: till.id },
    deskToken,
  );
  const before = await named(DESK);
  assert.equal(before.balance, 100, 'holding their money');
  assert.equal(before.standing, 'owed_to_company');

  // Counted out the way it is counted out: some dollars, some pounds.
  const settled = await req(
    'POST',
    `/transfers/companies/${before.id}/settle`,
    { accountId: till.id, amountUsd: 40, amountLbp: 890000 },
    deskToken,
  );
  assert.equal(settled.status, 201, JSON.stringify(settled.json));

  const { voucher, company } = settled.json;
  assert.equal(voucher.kind, 'payment', 'out of our till into theirs');
  assert.match(voucher.voucher_number, /^PV-/);
  assert.equal(voucher.reason, 'transfer_agency');
  assert.equal(voucher.amount_usd, 40);
  assert.equal(voucher.amount_lbp, 890000);

  // Both piles come off what is owed, at the rate written on the voucher.
  const moved = 40 + 890000 / voucher.exchange_rate;
  assert.ok(
    Math.abs(company.balance - (100 - moved)) < 0.01,
    `balance came to ${company.balance}, expected ${100 - moved}`,
  );
});

test('and the direction follows the balance when nobody names one', async () => {
  let agency = await named(DESK);

  // Clear whatever is left, so the sign is the only thing being tested.
  if (Math.abs(agency.balance) >= 0.005) {
    await req(
      'POST',
      `/transfers/companies/${agency.id}/settle`,
      { accountId: till.id, amountUsd: Math.abs(agency.balance) },
      deskToken,
    );
  }
  assert.equal((await named(DESK)).standing, 'square');

  // A payout with nothing held against it: the shop's own cash went out.
  await req(
    'POST',
    '/transfers',
    { company: DESK, direction: 'payout', amountUsd: 60, accountId: till.id },
    deskToken,
  );
  agency = await named(DESK);
  assert.equal(agency.balance, -60);

  // No direction asked for, and the money comes in rather than going out.
  const made = await req(
    'POST',
    `/transfers/companies/${agency.id}/settle`,
    { accountId: till.id, amountUsd: 60 },
    deskToken,
  );
  assert.equal(made.status, 201);
  assert.equal(made.json.voucher.kind, 'receipt', 'they made the shop good');
  assert.match(made.json.voucher.voucher_number, /^RV-/);
  assert.equal(made.json.company.balance, 0);
  assert.equal(made.json.company.standing, 'square');
});

test('a settlement paid by mistake is voided and the balance comes back', async () => {
  await req(
    'POST',
    '/transfers',
    { company: DESK, direction: 'send', amountUsd: 25, accountId: till.id },
    deskToken,
  );
  const before = await named(DESK);

  const settled = await req(
    'POST',
    `/transfers/companies/${before.id}/settle`,
    { accountId: till.id, amountUsd: 25 },
    deskToken,
  );
  assert.equal(settled.json.company.balance, before.balance - 25);

  // Voiding is the voucher book's job, and the agency's balance follows it.
  const voided = await req('POST', `/vouchers/${settled.json.voucher.id}/cancel`, null, adminToken);
  assert.equal(voided.status, 200);
  assert.equal(voided.json.voucher.status, 'cancelled');
  assert.equal((await named(DESK)).balance, before.balance, 'back where it was');
});

test('settling an amount of nothing is refused', async () => {
  const agency = await named(DESK);
  const empty = await req(
    'POST',
    `/transfers/companies/${agency.id}/settle`,
    { accountId: till.id },
    deskToken,
  );
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /Enter an amount/);
});

/* ------------------------------------------------- both currencies, apart */

/**
 * What the rider actually collects.
 *
 * A combined figure answers "what is this account worth" and nothing else. The
 * agency wants its dollars and its pounds, and a shop that converts one into
 * the other at today's rate is settling with a number neither side agreed.
 */
test('an agency carries its dollars and its pounds separately', async () => {
  const name = 'Cash United';
  await req(
    'POST',
    '/transfers',
    { company: name, direction: 'send', amountUsd: 120, amountLbp: 3_000_000, accountId: till.id },
    deskToken,
  );

  let agency = await named(name);
  assert.equal(agency.balanceUsd, 120, 'the dollars they sent');
  assert.equal(agency.balanceLbp, 3_000_000, 'and the pounds, unconverted');
  // The combined figure is still the one every balance is built from.
  assert.ok(agency.balance > 120, 'the total counts both');

  // A payout takes from the pile it was paid out of, not from the total.
  await req(
    'POST',
    '/transfers',
    { company: name, direction: 'payout', amountUsd: 20, accountId: till.id },
    deskToken,
  );
  agency = await named(name);
  assert.equal(agency.balanceUsd, 100);
  assert.equal(agency.balanceLbp, 3_000_000, 'the pounds did not move');

  // And settling moves each pile by what was counted out in it.
  const settled = await req(
    'POST',
    `/transfers/companies/${agency.id}/settle`,
    { accountId: till.id, amountUsd: 100, amountLbp: 1_000_000 },
    deskToken,
  );
  assert.equal(settled.status, 201, JSON.stringify(settled.json));
  assert.equal(settled.json.company.balanceUsd, 0, 'the dollars are square');
  assert.equal(settled.json.company.balanceLbp, 2_000_000, 'two million still owed');
});

test('and an opening balance starts each pile where it was typed', async () => {
  const created = await req('POST', '/transfers/companies', { name: 'Bankers' }, adminToken);
  const id = created.json.company.id;

  const opened = await req(
    'PUT',
    `/transfers/companies/${id}/opening`,
    { amountUsd: 500, amountLbp: 8_900_000 },
    adminToken,
  );
  assert.equal(opened.status, 200);
  assert.equal(opened.json.company.balanceUsd, 500);
  assert.equal(opened.json.company.balanceLbp, 8_900_000);

  // Setting it again replaces both piles rather than adding to them.
  await req(
    'PUT',
    `/transfers/companies/${id}/opening`,
    { amountUsd: 300, amountLbp: 1_000_000 },
    adminToken,
  );
  const again = await named('Bankers');
  assert.equal(again.balanceUsd, 300);
  assert.equal(again.balanceLbp, 1_000_000);
});

test('a cancelled transfer takes both of its piles back off the account', async () => {
  const name = 'Cash United';
  const before = await named(name);

  const sent = await req(
    'POST',
    '/transfers',
    { company: name, direction: 'send', amountUsd: 40, amountLbp: 500_000, accountId: till.id },
    deskToken,
  );
  assert.equal(sent.status, 201);

  await req('POST', `/transfers/${sent.json.transfer.id}/cancel`, null, deskToken);
  const after = await named(name);
  assert.equal(after.balanceUsd, before.balanceUsd, 'the dollars came back');
  assert.equal(after.balanceLbp, before.balanceLbp, 'and the pounds with them');
});

/* ------------------------------------------------- a drawer of its own */

/**
 * The transfer counter as its own position.
 *
 * Reported from a shop where the agency desk shares the cashier's till: the
 * operator's float, their sends and their payouts all land in the register's
 * drawer, and at closing neither count means anything. Naming a till for the
 * desk is what separates them.
 */
test('the desk can be given a drawer of its own, and the money goes into it', async () => {
  // It starts on the register's, which is right for a shop with one counter.
  let meta = (await req('GET', '/transfers/meta', null, deskToken)).json;
  assert.equal(meta.deskTillId ?? null, null, 'no drawer of its own to begin with');

  // The operator cannot move the desk onto another drawer.
  const refused = await req('PUT', '/transfers/till', { name: 'Sneaky' }, deskToken);
  assert.equal(refused.status, 403);

  // The owner can, and naming one opens it.
  const set = await req('PUT', '/transfers/till', { name: 'Transfer desk' }, adminToken);
  assert.equal(set.status, 200, JSON.stringify(set.json));
  const desk = set.json.tills.find((t) => t.name === 'Transfer desk');
  assert.ok(desk, 'the drawer was opened');
  assert.equal(set.json.deskTillId, desk.id);

  meta = (await req('GET', '/transfers/meta', null, deskToken)).json;
  assert.equal(meta.deskTillId, desk.id, 'and every screen is told');

  // Its own cashbox: the register's is open, this one is not.
  const before = (await req('GET', `/cash/current?accountId=${desk.id}`, null, adminToken)).json;
  assert.equal(before.session ?? null, null, 'a new drawer is closed until it is opened');

  await req('POST', '/cash/open', { accountId: desk.id, openingUsd: 50 }, adminToken);

  // A transfer taken on the desk's till moves the desk's till.
  const registerBefore = (await req('GET', `/cash/current?accountId=${till.id}`, null, adminToken)).json;
  await req(
    'POST',
    '/transfers',
    { company: 'OMT', direction: 'send', amountUsd: 70, accountId: desk.id },
    deskToken,
  );

  const deskNow = (await req('GET', `/cash/current?accountId=${desk.id}`, null, adminToken)).json;
  const registerNow = (await req('GET', `/cash/current?accountId=${till.id}`, null, adminToken)).json;
  assert.equal(deskNow.expected.usd, 120, 'the float plus what came over the counter');
  assert.equal(
    registerNow.expected.usd,
    registerBefore.expected.usd,
    'and the register did not move at all',
  );

  // And it can be handed back to the register's drawer.
  const shared = await req('PUT', '/transfers/till', { accountId: null }, adminToken);
  assert.equal(shared.status, 200);
  assert.equal(shared.json.deskTillId ?? null, null);
});

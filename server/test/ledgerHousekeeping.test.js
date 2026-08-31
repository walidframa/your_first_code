/**
 * Two operations on a ledger that is already written.
 *
 * The app otherwise refuses to touch a posted entry — a mistake is undone by
 * its opposite. These two earn the exception because neither changes a figure:
 * renumbering changes what an entry is called, moving an account's postings
 * changes which shelf they are filed on. The trial balance before and after is
 * the proof, and it is what most of this file checks.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4673;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;
let byCode = {};

async function req(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Some replies carry no body.
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

async function post(date, memo, lines) {
  const res = await req('POST', '/ledger/entries', { entryDate: date, memo, lines });
  assert.equal(res.status, 201, `${memo}: ${JSON.stringify(res.json)}`);
  return res.json.entry;
}

const trial = async () => (await req('GET', '/ledger/trial-balance')).json;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-house-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'h.sqlite'),
    JWT_SECRET: 'housekeeping-test-secret-long-enough',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };
  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();
  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  byCode = Object.fromEntries(
    (await req('GET', '/ledger/accounts')).json.accounts.map((a) => [a.code, a.id]),
  );

  /*
   * Typed out of order on purpose, which is the whole reason renumbering
   * exists: the March entry was written after the two from May.
   */
  await post('2026-05-02', 'May the second', [
    { accountId: byCode['1110'], debit: 100 },
    { accountId: byCode['4100'], credit: 100 },
  ]);
  await post('2026-05-09', 'May the ninth', [
    { accountId: byCode['1110'], debit: 200 },
    { accountId: byCode['4100'], credit: 200 },
  ]);
  await post('2026-03-04', 'March, typed late', [
    { accountId: byCode['5900'], debit: 50 },
    { accountId: byCode['1110'], credit: 50 },
  ]);
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ----------------------------------------------------------- renumbering */

test('the plan is shown before a single voucher is renamed', async () => {
  const { json } = await req('GET', '/ledger/renumber/preview?from=2026-01-01&to=2026-12-31&startAt=1');

  assert.equal(json.entries.length, 3);
  assert.equal(json.entries[0].memo, 'March, typed late', 'the oldest goes first, whenever it was typed');
  assert.equal(json.entries[0].to, 'JV-0001');
  assert.equal(json.entries[2].memo, 'May the ninth');
  assert.equal(json.entries[2].to, 'JV-0003');
  assert.ok(json.moved > 0, 'and it says how many actually move');

  // Nothing has happened yet.
  const untouched = (await req('GET', '/ledger/entries')).json.entries.find(
    (e) => e.memo === 'March, typed late',
  );
  assert.equal(untouched.entry_number, 'JV-0003', 'still the number it was written with');
});

test('renumbering puts them in date order and changes no figure', async () => {
  const before = await trial();

  const done = await req('POST', '/ledger/renumber', { from: '2026-01-01', to: '2026-12-31', startAt: 1 });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.renumbered, 3);

  const entries = (await req('GET', '/ledger/entries')).json.entries;
  const numberOf = (memo) => entries.find((e) => e.memo === memo).entry_number;
  assert.equal(numberOf('March, typed late'), 'JV-0001');
  assert.equal(numberOf('May the second'), 'JV-0002');
  assert.equal(numberOf('May the ninth'), 'JV-0003');

  /* The point of the whole exercise: the books say exactly what they said. */
  const after = await trial();
  assert.deepEqual(after.totals, before.totals, 'the ledger is untouched');
  assert.equal(after.balanced, true);
});

test('a number already held outside the range is refused, and says which', async () => {
  await post('2027-01-05', 'Next year', [
    { accountId: byCode['1110'], debit: 10 },
    { accountId: byCode['4100'], credit: 10 },
  ]);

  /* Renumbering 2026 from 1 would hand out JV-0004, which next year now holds. */
  const preview = await req('GET', '/ledger/renumber/preview?from=2026-01-01&to=2026-12-31&startAt=2');
  assert.match(preview.json.problem, /JV-0004 already belongs/);

  const refused = await req('POST', '/ledger/renumber', { from: '2026-01-01', to: '2026-12-31', startAt: 2 });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /already belongs/);
});

test('a closed period is not renumbered', async () => {
  const closed = await req('POST', '/ledger/closings', { to: '2026-06-30' });
  assert.equal(closed.status, 201, JSON.stringify(closed.json));

  const refused = await req('POST', '/ledger/renumber', { from: '2026-01-01', to: '2026-12-31', startAt: 1 });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /closed through/);
});

/* --------------------------------------------------- moving an account's work */

test('an account’s postings move to another, and nothing else does', async () => {
  /* After the close, so these sit in the open period. */
  await post('2026-08-03', 'Rent, filed wrong', [
    { accountId: byCode['5900'], debit: 400 },
    { accountId: byCode['1110'], credit: 400 },
  ]);
  await post('2026-08-04', 'Rent again, filed wrong', [
    { accountId: byCode['5900'], debit: 600 },
    { accountId: byCode['1110'], credit: 600 },
  ]);

  const before = await trial();
  const balanceOf = (report, code) => report.accounts.find((a) => a.code === code)?.balance ?? 0;
  const otherBefore = balanceOf(before, '5900');
  const rentBefore = balanceOf(before, '5300');

  const preview = await req(
    'GET',
    `/ledger/transfer/preview?fromAccountId=${byCode['5900']}&toAccountId=${byCode['5300']}&from=2026-08-01&to=2026-08-31`,
  );
  assert.equal(preview.json.totals.count, 2);
  assert.equal(preview.json.totals.debit, 1000);

  const done = await req('POST', '/ledger/transfer', {
    fromAccountId: byCode['5900'],
    toAccountId: byCode['5300'],
    from: '2026-08-01',
    to: '2026-08-31',
  });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.moved, 2);

  const after = await trial();
  assert.equal(balanceOf(after, '5900'), otherBefore - 1000, 'it left the wrong shelf');
  assert.equal(balanceOf(after, '5300'), rentBefore + 1000, 'and landed on the right one');
  assert.deepEqual(after.totals, before.totals, 'the ledger still adds to the same thing');
  assert.equal(after.balanced, true);
});

test('postings cannot be moved onto a different kind of account', async () => {
  /*
   * The check that keeps the statements honest rather than merely tidy. The
   * trial balance would still balance — debits and credits are untouched — and
   * an expense would have quietly become an asset.
   */
  const refused = await req('POST', '/ledger/transfer', {
    fromAccountId: byCode['5300'],
    toAccountId: byCode['1110'],
  });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /would change what the books say/);
});

test('nor onto a heading, nor onto itself', async () => {
  const heading = await req('POST', '/ledger/transfer', {
    fromAccountId: byCode['5300'],
    toAccountId: byCode['5000'],
  });
  assert.equal(heading.status, 400);
  assert.match(heading.json.error, /heading/);

  const itself = await req('POST', '/ledger/transfer', {
    fromAccountId: byCode['5300'],
    toAccountId: byCode['5300'],
  });
  assert.equal(itself.status, 400);
  assert.match(itself.json.error, /same account/);
});

test('and a closed period keeps its filing', async () => {
  const refused = await req('POST', '/ledger/transfer', {
    fromAccountId: byCode['5900'],
    toAccountId: byCode['5300'],
    from: '2026-01-01',
    to: '2026-06-30',
  });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /closed through/);
});

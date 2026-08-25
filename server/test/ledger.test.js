/**
 * The books.
 *
 * The claim worth holding above all the others is the one the whole thing
 * stands on: **an entry balances or it does not exist.** Not saved as a draft,
 * not flagged for later — refused, before a row is written. A ledger that can
 * hold one unbalanced entry is a ledger whose every report is a guess, and the
 * entry that broke it is never the one being looked at when somebody notices.
 *
 * After that: a heading is not a place money can sit, a mistake is undone by
 * its opposite rather than by deletion, and the trial balance proves itself.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4646;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;
let chart;

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

/** The seeded chart, by code, so tests read as accounting rather than as ids. */
const at = (code) => chart.find((a) => a.code === code);

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-ledger-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'ledger.sqlite'),
    JWT_SECRET: 'ledger-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  chart = (await req('GET', '/ledger/accounts')).json.accounts;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* -------------------------------------------------- the chart to start with */

test('a shop opens the books to a chart it can actually use', async () => {
  /*
   * Not an empty list. A shopkeeper has no reason to know that a chart wants a
   * 1000 range for what the shop owns, and an empty tree is a screen nobody
   * can begin with.
   */
  assert.ok(chart.length >= 20, 'a starting chart is there');
  for (const code of ['1110', '1200', '2100', '3100', '4100', '5100']) {
    assert.ok(at(code), `${code} is in the starting chart`);
  }
  assert.equal(at('1000').is_group, true, 'Assets is a heading');
  assert.equal(at('1110').is_group, false, 'Cash in hand can be posted to');
  assert.equal(at('4100').type, 'income');
});

/* ------------------------------------------------- an entry balances or not */

test('a balanced entry posts, and reads back the way it was written', async () => {
  const made = await req('POST', '/ledger/entries', {
    memo: 'Owner put money in',
    lines: [
      { accountId: at('1110').id, debit: 500, memo: 'into the drawer' },
      { accountId: at('3100').id, credit: 500 },
    ],
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));

  const entry = made.json.entry;
  assert.match(entry.entry_number, /^JV-\d{4}$/);
  assert.equal(entry.total, 500);
  assert.equal(entry.lines.length, 2);
  assert.equal(entry.lines[0].account_code, '1110', 'the order it was typed in');
  assert.equal(entry.lines[0].debit_usd, 500);
  assert.equal(entry.lines[1].credit_usd, 500);
});

test('an entry that does not balance is refused, and says by how much', async () => {
  const tried = await req('POST', '/ledger/entries', {
    memo: 'Out by twelve',
    lines: [
      { accountId: at('1110').id, debit: 100 },
      { accountId: at('3100').id, credit: 88 },
    ],
  });
  assert.equal(tried.status, 400, 'it must not be stored at all');
  assert.match(tried.json.error, /out by 12\.00/, 'and the message is the figure to go and find');

  // Nothing was written — not even the entry with no lines.
  const entries = (await req('GET', '/ledger/entries')).json.entries;
  assert.ok(!entries.some((e) => e.memo === 'Out by twelve'));
});

test('one side per line, and never both', async () => {
  const tried = await req('POST', '/ledger/entries', {
    lines: [
      { accountId: at('1110').id, debit: 50, credit: 50 },
      { accountId: at('3100').id, credit: 50 },
    ],
  });
  assert.equal(tried.status, 400);
  assert.match(tried.json.error, /one column, not both/);
});

test('a heading is the shape of the chart, not a place money can sit', async () => {
  const tried = await req('POST', '/ledger/entries', {
    lines: [
      { accountId: at('1000').id, debit: 10 },
      { accountId: at('3100').id, credit: 10 },
    ],
  });
  assert.equal(tried.status, 400);
  assert.match(tried.json.error, /heading/);
});

test('an entry of one line is half a thought', async () => {
  const tried = await req('POST', '/ledger/entries', {
    lines: [{ accountId: at('1110').id, debit: 10 }],
  });
  assert.equal(tried.status, 400);
  assert.match(tried.json.error, /at least two lines/);
});

test('the form can ask whether it would post, before it does', async () => {
  const bad = await req('POST', '/ledger/entries/check', {
    lines: [
      { accountId: at('1110').id, debit: 100 },
      { accountId: at('3100').id, credit: 90 },
    ],
  });
  assert.match(bad.json.problem, /out by 10\.00/);

  const good = await req('POST', '/ledger/entries/check', {
    lines: [
      { accountId: at('1110').id, debit: 100 },
      { accountId: at('3100').id, credit: 100 },
    ],
  });
  assert.equal(good.json.problem, null);
});

/* ------------------------------------------------------- undoing a mistake */

test('a mistake is undone by its opposite, and both stay on the record', async () => {
  const wrong = (await req('POST', '/ledger/entries', {
    memo: 'Rent, twice by accident',
    lines: [
      { accountId: at('5300').id, debit: 400 },
      { accountId: at('1110').id, credit: 400 },
    ],
  })).json.entry;

  const undone = await req('POST', `/ledger/entries/${wrong.id}/reverse`, {});
  assert.equal(undone.status, 201, JSON.stringify(undone.json));

  const reversal = undone.json.entry;
  assert.equal(reversal.reverses_id, wrong.id);
  assert.match(reversal.memo, new RegExp(`Reverses ${wrong.entry_number}`));
  // Each line the other way round, which is what a reversal is.
  assert.equal(reversal.lines[0].credit_usd, 400);
  assert.equal(reversal.lines[1].debit_usd, 400);

  /*
   * The original stays posted, and that is deliberate. Taking it out of the
   * reports while leaving its reversal in was worse than doing nothing: the
   * reversal's lines went on counting with nothing to cancel them, so rent
   * entered twice and corrected once read as *income*.
   */
  const original = (await req('GET', `/ledger/entries/${wrong.id}`)).json.entry;
  assert.equal(original.status, 'posted', 'both halves of the correction stay on the record');
  assert.equal(original.lines.length, 2, 'nothing was deleted');
  assert.equal(original.reversed_by.entry_number, reversal.entry_number, 'and it says which entry undid it');

  assert.equal((await req('POST', `/ledger/entries/${wrong.id}/reverse`, {})).status, 400,
    'and it cannot be reversed twice');
});

/* ----------------------------------------------------- the trial balance */

test('the trial balance proves itself, and a correction nets to nothing', async () => {
  const tb = (await req('GET', '/ledger/trial-balance')).json;
  assert.equal(tb.balanced, true, 'the two columns agree');
  assert.equal(tb.totals.debit, tb.totals.credit);

  /*
   * The rent that was entered and then reversed shows both movements and a
   * balance of nothing — which is what happened. Showing only the reversal
   * would make the shop look like it had been paid rent.
   */
  const rent = tb.accounts.find((a) => a.code === '5300');
  assert.equal(rent.debit, 400, 'the mistake is readable');
  assert.equal(rent.credit, 400, 'so is the correction');
  assert.equal(rent.balance, 0, 'and between them they come to nothing');

  /*
   * The drawer carries every movement gross — the $500 put in, the $400 paid
   * out for rent, and the $400 that came back when it was reversed — and the
   * balance is what is actually in it. Reading the debit column alone would
   * say $900, which is the money that has passed through rather than the money
   * that is there.
   */
  const cash = tb.accounts.find((a) => a.code === '1110');
  assert.equal(cash.debit, 900, 'everything that went in, including the reversal');
  assert.equal(cash.credit, 400, 'and everything that went out');
  assert.equal(cash.balance, 500, 'leaving the owner’s money — an asset grows on the debit side');

  const capital = tb.accounts.find((a) => a.code === '3100');
  assert.equal(capital.balance, 500, 'and equity grows on the credit side — same sign, both positive');
});

test('an account’s own page runs the balance down it', async () => {
  await req('POST', '/ledger/entries', {
    memo: 'Sold something for cash',
    lines: [
      { accountId: at('1110').id, debit: 120 },
      { accountId: at('4100').id, credit: 120 },
    ],
  });

  const page = (await req('GET', `/ledger/accounts/${at('1110').id}/ledger`)).json;
  assert.equal(page.account.code, '1110');
  assert.equal(page.lines.at(-1).balance, 620, '500 in, then 120 more');
  assert.equal(page.closing, 620);
});

/* ------------------------------------------------- keeping the chart tidy */

test('a new account goes under a heading of its own kind', async () => {
  const made = await req('POST', '/ledger/accounts', {
    code: '5600', name: 'Generator fuel', type: 'expense', parentId: at('5000').id,
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.account.code, '5600');

  const wrongKind = await req('POST', '/ledger/accounts', {
    code: '5700', name: 'Filed wrong', type: 'income', parentId: at('5000').id,
  });
  assert.equal(wrongKind.status, 400, 'income cannot live under Expenses');
  assert.match(wrongKind.json.error, /expense/);

  const underAPost = await req('POST', '/ledger/accounts', {
    code: '5710', name: 'Under a leaf', type: 'expense', parentId: at('5300').id,
  });
  assert.equal(underAPost.status, 400, 'and nothing files under an account that holds money');
});

test('a code cannot be used twice', async () => {
  const clash = await req('POST', '/ledger/accounts', { code: '1110', name: 'Another one', type: 'asset' });
  assert.equal(clash.status, 400);
  assert.match(clash.json.error, /already Cash in hand/);
});

test('an account with entries on it cannot become a heading', async () => {
  const tried = await req('PUT', `/ledger/accounts/${at('1110').id}`, { isGroup: true });
  assert.equal(tried.status, 400);
  assert.match(tried.json.error, /entries posted/);
});

test('the books are not open to a cashier', async () => {
  const cashier = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' }))
    .json.token;
  assert.equal((await req('GET', '/ledger/accounts', null, cashier)).status, 403);
  assert.equal((await req('GET', '/ledger/trial-balance', null, cashier)).status, 403);
});

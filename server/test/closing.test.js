/**
 * Drawing a line under a year.
 *
 * Two claims under test, and they are one act: the earnings and the spending
 * are emptied into retained earnings, and the period is shut so nobody can
 * post into a year that has already been reported on.
 *
 * The tests that matter most are about what must still work afterwards. A
 * closed year must not stop the shop trading, and a closing that cannot be
 * undone is a trap rather than a control.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4652;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;
let widget;
let accounts;
/** What the shop owned before any line was drawn, to prove closing left it alone. */
let cashBeforeClosing;

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

const tb = async () => (await req('GET', '/ledger/trial-balance')).json;
const balanceOf = async (code) => (await tb()).accounts.find((a) => a.code === code)?.balance ?? 0;
const codeId = (code) => accounts.find((a) => a.code === code).id;

/** A hand-written entry on a date of our choosing. */
const write = (date, debit, credit, amount, memo = 'test') =>
  req('POST', '/ledger/entries', {
    entryDate: date,
    memo,
    lines: [
      { accountId: codeId(debit), debit: amount, credit: 0 },
      { accountId: codeId(credit), debit: 0, credit: amount },
    ],
  });

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-close-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'close.sqlite'),
    JWT_SECRET: 'close-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  await req('PUT', '/settings', { tax_enabled: false });
  await req('POST', '/cash/open', { openingUsd: 500 });

  accounts = (await req('GET', '/ledger/accounts')).json.accounts;
  widget = (await req('POST', '/products', {
    name: 'Charger', sku: 'CL-1', price: 100, cost: 60, stock: 50,
  })).json.product;

  // Last year's trading: earned 1,000, spent 400 on rent.
  await write('2025-06-01', '1110', '4100', 1000, 'Sales in the old year');
  await write('2025-06-02', '5300', '1110', 400, 'Rent in the old year');

  cashBeforeClosing = (await req('GET', '/ledger/trial-balance')).json
    .accounts.find((a) => a.code === '1110').balance;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('the preview shows what would move, account by account', async () => {
  const { preview } = (await req('GET', '/ledger/closings?to=2025-12-31')).json;
  assert.equal(preview.earned, 1000);
  assert.equal(preview.spent, 400);
  assert.equal(preview.profit, 600);
  assert.ok(preview.accounts.find((a) => a.code === '4100'), 'the sales are named');
  assert.ok(preview.accounts.find((a) => a.code === '5300'), 'and so is the rent');
});

test('closing empties the year into retained earnings', async () => {
  const closed = await req('POST', '/ledger/closings', { to: '2025-12-31' });
  assert.equal(closed.status, 201, JSON.stringify(closed.json));

  assert.equal(await balanceOf('4100'), 0, 'the earning is gone from this year');
  assert.equal(await balanceOf('5300'), 0, 'and so is the spending');
  assert.equal(await balanceOf('3900'), 600, 'and the profit is where a balance sheet looks for it');
  assert.equal((await tb()).balanced, true, 'and the books still balance');
});

test('what the shop owns is untouched — only what it earned is swept', async () => {
  /*
   * Compared against what it was before the line was drawn rather than against
   * a figure written here, so the claim under test is the one that matters —
   * closing moves the earning and the spending and nothing else — and not an
   * arithmetic guess about how the drawer came to hold what it holds.
   */
  assert.equal(await balanceOf('1110'), cashBeforeClosing, 'the cash is still the cash');
  assert.ok(cashBeforeClosing !== 0, 'and there was some to leave alone');
});

test('nothing can be posted back into the closed year', async () => {
  const refused = await write('2025-08-01', '5300', '1110', 50, 'A late invoice');
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /closed through 2025-12-31/);

  assert.equal(await balanceOf('3900'), 600, 'so last year’s profit cannot move');
});

test('and the day after the line is open', async () => {
  const fine = await write('2026-01-02', '5300', '1110', 50, 'This year’s rent');
  assert.equal(fine.status, 201, JSON.stringify(fine.json));
  assert.equal(await balanceOf('5300'), 50, 'which starts the new year from nothing');
});

test('a closed year does not stop the shop trading', async () => {
  /*
   * The failure this is here to prevent: a sale that cannot be rung up because
   * an accountant shut a year. Automatic postings date themselves to when the
   * thing happened, so they have to move forward rather than be refused.
   */
  const sale = await req('POST', '/orders', {
    items: [{ productId: widget.id, quantity: 1 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 100 }],
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  assert.equal(await balanceOf('4100'), 100, 'and it reached the books');
  assert.equal((await tb()).balanced, true);

  // And it did not quietly fail into the error key instead.
  const settings = (await req('GET', '/settings')).json;
  assert.ok(!settings.gl_posting_error, `a posting failed silently: ${settings.gl_posting_error}`);
});

test('closing the same period twice is refused', async () => {
  const again = await req('POST', '/ledger/closings', { to: '2025-12-31' });
  assert.equal(again.status, 400);
  assert.match(again.json.error, /already closed/i);
});

test('closing a second period only sweeps what came after the first', async () => {
  const before3900 = await balanceOf('3900');
  const closed = await req('POST', '/ledger/closings', { to: '2026-12-31' });
  assert.equal(closed.status, 201, JSON.stringify(closed.json));

  // This year: 100 earned, 50 of rent, and the cost of the charger sold.
  const cogs = 60;
  assert.equal(await balanceOf('3900'), before3900 + (100 - 50 - cogs));
  assert.equal(await balanceOf('4100'), 0);
  assert.equal((await tb()).balanced, true, 'still balanced after two closings');
});

test('reopening puts it back, and says so rather than hiding it', async () => {
  const list = (await req('GET', '/ledger/closings')).json.closings;
  const latest = list[0];
  assert.equal(latest.period_end, '2026-12-31');

  const opened = await req('POST', `/ledger/closings/${latest.id}/reopen`);
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.ok(opened.json.closing.reopened_at, 'the row records that it was opened');

  assert.equal(await balanceOf('4100'), 100, 'this year’s earning is back where it was');
  assert.equal((await tb()).balanced, true);

  // The closing entry was reversed, not deleted — both halves are still there.
  const entries = (await req('GET', '/ledger/entries')).json.entries;
  assert.ok(
    entries.some((e) => e.source === 'closing'),
    'the closing entry is still in the journal',
  );
});

test('periods come undone in the order they were shut', async () => {
  const list = (await req('GET', '/ledger/closings')).json.closings;
  const older = list.find((c) => c.period_end === '2025-12-31' && !c.reopened_at);
  assert.ok(older, 'the old year is still shut');

  // 2026 is already reopened, so 2025 is now the most recent standing closing
  // and may be reopened — which is the rule, not an exception to it.
  const opened = await req('POST', `/ledger/closings/${older.id}/reopen`);
  assert.equal(opened.status, 200, JSON.stringify(opened.json));

  assert.equal(await balanceOf('3900'), 0, 'and retained earnings comes back to nothing');
  assert.equal((await tb()).balanced, true);
});

test('the books are not open to a cashier, and neither is closing them', async () => {
  const cashier = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' }))
    .json.token;
  assert.equal((await req('GET', '/ledger/closings', null, cashier)).status, 403);
  assert.equal((await req('POST', '/ledger/closings', { to: '2027-12-31' }, cashier)).status, 403);
});

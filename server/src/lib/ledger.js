/**
 * The general ledger: the chart of accounts, and entries posted to it.
 *
 * Everything else in this app records money from one point of view — what a
 * customer owes, what is in a drawer, what a supplier was paid. Each is right
 * about its own corner and none of them add up into a statement.
 *
 * This is the other account of the same shop: every movement as a pair of
 * sides, so that "where did it come from and where did it go" has one answer
 * and the whole thing can be totalled.
 *
 * ## The rule everything here exists to enforce
 *
 * **An entry balances or it does not exist.** Not "is flagged", not "is saved
 * as a draft and warned about" — refused, inside the transaction, before a row
 * is written. A ledger that can hold one unbalanced entry is a ledger whose
 * every report is a guess, and the entry that broke it is never the one being
 * looked at when somebody finally notices.
 */
import { db, transaction } from '../db.js';
import { closedThrough, isClosed } from './periodLock.js';
import { round2 } from './currency.js';
import { getExchangeRate } from './settings.js';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];

/**
 * Which way round an account grows.
 *
 * An asset and an expense increase on the debit side; everything else
 * increases on the credit side. Written once here because it is the fact every
 * report re-derives, and three copies of it is three chances to show a shop
 * its profit with the sign inverted.
 */
export const NORMAL_SIDE = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  income: 'credit',
};

/** What an account's balance means as one signed figure, in its own direction. */
export function signedBalance(type, debit, credit) {
  return NORMAL_SIDE[type] === 'debit' ? round2(debit - credit) : round2(credit - debit);
}

/* ------------------------------------------------------ chart of accounts */

export function listAccounts({ activeOnly = false } = {}) {
  const rows = db
    .prepare(
      `SELECT a.*, p.name AS parent_name, p.code AS parent_code
       FROM gl_accounts a
       LEFT JOIN gl_accounts p ON p.id = a.parent_id
       ${activeOnly ? 'WHERE a.active = 1' : ''}
       ORDER BY a.code`,
    )
    .all();
  return rows.map((a) => ({ ...a, active: !!a.active, is_group: !!a.is_group }));
}

export function accountById(id) {
  const row = db.prepare('SELECT * FROM gl_accounts WHERE id = ?').get(id);
  return row ? { ...row, active: !!row.active, is_group: !!row.is_group } : null;
}

function assertCodeFree(code, exceptId = null) {
  const clash = db
    .prepare('SELECT id, name FROM gl_accounts WHERE code = ? AND id IS NOT ?')
    .get(code, exceptId);
  if (clash) throw new Error(`${code} is already ${clash.name}`);
}

export function createAccount({ code, name, type, parentId = null, isGroup = false, note = null }) {
  const cleanCode = String(code ?? '').trim();
  const cleanName = String(name ?? '').trim();
  if (!cleanCode) throw new Error('An account needs a code');
  if (!cleanName) throw new Error('An account needs a name');
  if (!ACCOUNT_TYPES.includes(type)) throw new Error(`type must be one of: ${ACCOUNT_TYPES.join(', ')}`);
  assertCodeFree(cleanCode);

  if (parentId) {
    const parent = accountById(parentId);
    if (!parent) throw new Error('That parent account does not exist');
    /*
     * A heading holds the shape; anything else holds money. Filing an account
     * under something that is not a heading makes a total that includes its own
     * child, which is the classic way a chart quietly doubles a figure.
     */
    if (!parent.is_group) throw new Error(`${parent.name} is not a heading — accounts cannot go under it`);
    if (parent.type !== type) {
      throw new Error(`${parent.name} holds ${parent.type} accounts, so this one has to be ${parent.type} too`);
    }
  }

  const info = db
    .prepare('INSERT INTO gl_accounts (code, name, type, parent_id, is_group, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(cleanCode, cleanName, type, parentId || null, isGroup ? 1 : 0, note || null);
  return accountById(info.lastInsertRowid);
}

export function updateAccount(id, { code, name, note, active, isGroup }) {
  const account = accountById(id);
  if (!account) throw new Error('That account does not exist');

  const merged = {
    code: code === undefined ? account.code : String(code).trim(),
    name: name === undefined ? account.name : String(name).trim(),
    note: note === undefined ? account.note : note || null,
    active: active === undefined ? account.active : Boolean(active),
    is_group: isGroup === undefined ? account.is_group : Boolean(isGroup),
  };
  if (!merged.code) throw new Error('An account needs a code');
  if (!merged.name) throw new Error('An account needs a name');
  assertCodeFree(merged.code, id);

  /*
   * The type is not editable, and that is deliberate rather than unfinished.
   * Changing it silently re-signs every figure already posted to it — a year
   * of expenses becoming a year of income, with no entry to explain it. The
   * honest way to correct a miscategorised account is a new one and a transfer.
   */
  if (merged.is_group && !account.is_group && hasPostings(id)) {
    throw new Error('There are entries posted to this account, so it cannot become a heading');
  }

  db.prepare('UPDATE gl_accounts SET code = ?, name = ?, note = ?, active = ?, is_group = ? WHERE id = ?')
    .run(merged.code, merged.name, merged.note, merged.active ? 1 : 0, merged.is_group ? 1 : 0, id);
  return accountById(id);
}

export function hasPostings(accountId) {
  return Boolean(db.prepare('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1').get(accountId));
}

/**
 * Put an account away.
 *
 * Never deleted while anything is posted to it: the entries would point at
 * nothing, and every report covering that period would change shape. Archived
 * accounts keep their history and stop being offered.
 */
export function archiveAccount(id) {
  const account = accountById(id);
  if (!account) throw new Error('That account does not exist');
  const children = db.prepare('SELECT COUNT(*) AS n FROM gl_accounts WHERE parent_id = ? AND active = 1').get(id).n;
  if (children > 0) throw new Error('Put the accounts under it away first');
  db.prepare('UPDATE gl_accounts SET active = 0 WHERE id = ?').run(id);
  return accountById(id);
}

/* ---------------------------------------------------------------- entries */

/** JV-0001, and the next one after that. */
function nextEntryNumber() {
  const last = db
    .prepare("SELECT entry_number FROM journal_entries WHERE entry_number LIKE 'JV-%' ORDER BY id DESC LIMIT 1")
    .get()?.entry_number;
  const n = last ? Number(String(last).replace('JV-', '')) || 0 : 0;
  return `JV-${String(n + 1).padStart(4, '0')}`;
}

/**
 * Check the lines before anything is written.
 *
 * Returned rather than thrown so the caller can put the reason in front of
 * somebody who is still looking at the form. Every one of these is a refusal:
 * there is no "save it anyway".
 */
export function checkLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    return 'An entry needs at least two lines — something given and something received';
  }

  let debits = 0;
  let credits = 0;
  for (const [i, line] of lines.entries()) {
    const where = `Line ${i + 1}`;
    const account = accountById(line.accountId);
    if (!account) return `${where}: that account does not exist`;
    if (!account.active) return `${where}: ${account.name} has been put away`;
    // A heading is the shape of the chart, not a place money can sit.
    if (account.is_group) return `${where}: ${account.name} is a heading — pick an account under it`;

    const debit = round2(Number(line.debit) || 0);
    const credit = round2(Number(line.credit) || 0);
    if (debit < 0 || credit < 0) return `${where}: an amount cannot be negative`;
    /*
     * One side per line. A line carrying both is two lines pretending to be
     * one, and it makes the entry read as something nobody wrote.
     */
    if (debit > 0 && credit > 0) return `${where}: put the amount in one column, not both`;
    if (debit === 0 && credit === 0) return `${where}: there is no amount on it`;

    for (const [key, table, what] of [
      ['costCentreId', 'cost_centres', 'cost centre'],
      ['areaId', 'areas', 'area'],
    ]) {
      if (!line[key]) continue;
      const found = db.prepare(`SELECT active FROM ${table} WHERE id = ?`).get(line[key]);
      if (!found) return `${where}: that ${what} does not exist`;
      if (!found.active) return `${where}: that ${what} has been put away`;
    }

    debits = round2(debits + debit);
    credits = round2(credits + credit);
  }

  if (debits !== credits) {
    const gap = round2(Math.abs(debits - credits));
    return `The two columns do not agree — debits ${debits.toFixed(2)}, credits ${credits.toFixed(
      2,
    )}, out by ${gap.toFixed(2)}`;
  }
  if (debits === 0) return 'An entry of nothing is not an entry';
  return null;
}

/**
 * Write one entry.
 *
 * The check runs again inside the transaction rather than only at the route.
 * Between a caller validating and a caller writing, an account can be archived
 * — and this is the one place in the app where "almost always fine" is not
 * good enough, because the whole value of a ledger is that it is never wrong.
 */
export function postEntry({
  entryDate = null,
  memo = null,
  lines = [],
  source = 'manual',
  branchId = null,
  userId = null,
  reversesId = null,
  allowClosed = false,
}) {
  const problem = checkLines(lines);
  if (problem) throw new Error(problem);

  /*
   * Nothing goes into a year that has been reported on.
   *
   * Checked here rather than at each caller, because "here" is the only door:
   * every entry in this app, hand-written or automatic, is written by this
   * function. A closing that could be walked around by one code path that
   * forgot to ask is not a closing.
   *
   * `allowClosed` is for the two entries that have to reach inside a closed
   * period by their nature — the one that shuts it, and the reversal that
   * opens it again.
   */
  if (!allowClosed && isClosed(entryDate)) {
    throw new Error(
      `The books are closed through ${closedThrough()} — this entry would land inside a period that has already been reported on`,
    );
  }

  return transaction(() => {
    const number = nextEntryNumber();
    const info = db
      .prepare(
        `INSERT INTO journal_entries
           (entry_number, entry_date, memo, source, exchange_rate, branch_id, reverses_id, user_id)
         VALUES (?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?)`,
      )
      .run(number, entryDate || null, memo || null, source, getExchangeRate(), branchId, reversesId, userId);

    const insert = db.prepare(
      `INSERT INTO journal_lines
         (entry_id, account_id, debit_usd, credit_usd, memo, position, cost_centre_id, area_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [i, line] of lines.entries()) {
      insert.run(
        info.lastInsertRowid,
        line.accountId,
        round2(Number(line.debit) || 0),
        round2(Number(line.credit) || 0),
        line.memo || null,
        i,
        /*
         * On the line rather than the entry, deliberately: one invoice can
         * carry rent for two shops, and a sale can earn for the counter while
         * the part fitted to it costs the repair bench.
         */
        line.costCentreId || null,
        line.areaId || null,
      );
    }
    return entryById(info.lastInsertRowid);
  })();
}

export function entryById(id) {
  const entry = db
    .prepare(
      `SELECT e.*, u.name AS user_name, b.name AS branch_name, r.entry_number AS reverses_number
       FROM journal_entries e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN branches b ON b.id = e.branch_id
       LEFT JOIN journal_entries r ON r.id = e.reverses_id
       WHERE e.id = ?`,
    )
    .get(id);
  if (!entry) return null;

  const lines = db
    .prepare(
      `SELECT l.*, a.code AS account_code, a.name AS account_name, a.type AS account_type,
              c.name AS cost_centre_name, r.name AS area_name
       FROM journal_lines l
       JOIN gl_accounts a ON a.id = l.account_id
       LEFT JOIN cost_centres c ON c.id = l.cost_centre_id
       LEFT JOIN areas r ON r.id = l.area_id
       WHERE l.entry_id = ? ORDER BY l.position, l.id`,
    )
    .all(id);

  return {
    ...entry,
    lines,
    // So a screen can mark it without asking a second question, and so the
    // reverse button knows it has already been pressed.
    reversed_by: reversalOf(id),
    total: round2(lines.reduce((sum, l) => sum + l.debit_usd, 0)),
  };
}

export function listEntries({ from = null, to = null, accountId = null, limit = 200 } = {}) {
  const rows = db
    .prepare(
      `SELECT e.*, u.name AS user_name,
              (SELECT COALESCE(SUM(debit_usd), 0) FROM journal_lines l WHERE l.entry_id = e.id) AS total
       FROM journal_entries e
       LEFT JOIN users u ON u.id = e.user_id
       WHERE (? IS NULL OR e.entry_date >= ?)
         AND (? IS NULL OR e.entry_date <= ?)
         AND (? IS NULL OR EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id AND l.account_id = ?))
       ORDER BY e.entry_date DESC, e.id DESC
       LIMIT ?`,
    )
    .all(from, from, to, to, accountId, accountId, Math.min(Number(limit) || 200, 1000));
  return rows.map((r) => ({ ...r, total: round2(r.total) }));
}

/**
 * Undo an entry by writing its opposite.
 *
 * Never by deleting it. A report printed yesterday has to go on saying what it
 * said, and an entry that vanishes takes its own explanation with it — the one
 * thing a ledger is for is that somebody can ask, later, what happened.
 */
export function reverseEntry(id, { userId = null, memo = null, allowClosed = false } = {}) {
  const entry = entryById(id);
  if (!entry) throw new Error('That entry does not exist');
  if (reversalOf(id)) throw new Error('That entry has already been reversed');
  if (entry.reverses_id) throw new Error('That entry is itself a reversal');

  return transaction(() => {
    const reversal = postEntry({
      memo: memo || `Reverses ${entry.entry_number}${entry.memo ? ` — ${entry.memo}` : ''}`,
      // Each line the other way round, which is what a reversal is.
      lines: entry.lines.map((l) => ({
        accountId: l.account_id,
        debit: l.credit_usd,
        credit: l.debit_usd,
        memo: l.memo,
        // Carried across, or the correction lands on nobody and the centre it
        // was charged to keeps a cost that has been taken back.
        costCentreId: l.cost_centre_id,
        areaId: l.area_id,
      })),
      source: entry.source,
      branchId: entry.branch_id,
      userId,
      reversesId: entry.id,
      /*
       * Dated today, not on the original's date, so a correction to something
       * inside a closed year lands after the line rather than being refused —
       * except when the reopening itself is doing the reversing, which has to
       * reach inside.
       */
      allowClosed,
    });
    /*
     * The original stays **posted**, and that is the whole point.
     *
     * Marking it cancelled while leaving its reversal posted was worse than
     * doing nothing: the reversal's own lines went on counting with nothing to
     * cancel them, so an expense entered twice and corrected once came out of
     * the trial balance as a *negative* expense. The books said the shop had
     * been paid rent.
     *
     * Both sides stay. That is also what an accountant expects to find — the
     * mistake and the correction, each readable, netting to nothing.
     */
    return reversal;
  })();
}

/** The entry that reverses this one, if somebody has already written it. */
export function reversalOf(entryId) {
  return (
    db
      .prepare('SELECT id, entry_number FROM journal_entries WHERE reverses_id = ? LIMIT 1')
      .get(entryId) ?? null
  );
}

/* ---------------------------------------------------------------- reports */

/**
 * The trial balance: every account, its two columns, and the proof.
 *
 * The two totals being equal is not decoration — it is the check that the
 * ledger has not been corrupted by anything, including by this app. Returned
 * with the figures rather than left for the screen to work out, so that a
 * report which does not balance says so wherever it is read.
 *
 * A reversed entry and its reversal are **both** counted, and net to nothing
 * between them. Leaving the original out while counting its reversal is how an
 * expense entered twice and corrected once turns into income — see
 * `reverseEntry`. What the shop sees is an account whose two columns each carry
 * the figure and whose balance is zero, which is the truth about what happened.
 */
export function trialBalance({ from = null, to = null } = {}) {
  const rows = db
    .prepare(
      `SELECT a.id, a.code, a.name, a.type, a.is_group,
              COALESCE(SUM(l.debit_usd), 0) AS debit,
              COALESCE(SUM(l.credit_usd), 0) AS credit
       FROM gl_accounts a
       LEFT JOIN journal_lines l ON l.account_id = a.id
       LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
         AND (? IS NULL OR e.entry_date >= ?) AND (? IS NULL OR e.entry_date <= ?)
       WHERE l.id IS NULL OR e.id IS NOT NULL
       GROUP BY a.id
       ORDER BY a.code`,
    )
    .all(from, from, to, to);

  const accounts = rows
    .map((r) => ({
      ...r,
      is_group: !!r.is_group,
      debit: round2(r.debit),
      credit: round2(r.credit),
      balance: signedBalance(r.type, round2(r.debit), round2(r.credit)),
    }))
    .filter((r) => r.debit !== 0 || r.credit !== 0);

  const totals = accounts.reduce(
    (acc, r) => ({ debit: round2(acc.debit + r.debit), credit: round2(acc.credit + r.credit) }),
    { debit: 0, credit: 0 },
  );

  return { accounts, totals, balanced: totals.debit === totals.credit };
}

/** One account's entries, in order, with the balance running down the page. */
export function accountLedger(accountId, { from = null, to = null } = {}) {
  const account = accountById(accountId);
  if (!account) return null;

  const rows = db
    .prepare(
      `SELECT l.*, e.entry_number, e.entry_date, e.memo AS entry_memo, e.status
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ? AND e.status = 'posted'
         AND (? IS NULL OR e.entry_date >= ?) AND (? IS NULL OR e.entry_date <= ?)
       ORDER BY e.entry_date, e.id, l.position`,
    )
    .all(accountId, from, from, to, to);

  let running = 0;
  const lines = rows.map((r) => {
    running = round2(running + signedBalance(account.type, r.debit_usd, r.credit_usd));
    return { ...r, debit_usd: round2(r.debit_usd), credit_usd: round2(r.credit_usd), balance: running };
  });

  return { account, lines, closing: running };
}

/**
 * Drawing a line under a year.
 *
 * Two things happen at once and they have to be one act, because either
 * without the other is worse than neither.
 *
 * **The books are emptied.** Every income and expense account is brought to
 * zero and the difference — the profit — is moved into retained earnings.
 * That is what makes next year's "what did we earn" mean next year rather
 * than everything since the shop opened, and it is what puts last year's
 * profit where a balance sheet expects to find it.
 *
 * **The period is shut.** Nothing can be posted into a year that has already
 * been reported on. A closing without a lock is a suggestion: the figures are
 * moved out and then somebody back-dates an invoice into December and the
 * accounts that were submitted no longer match the accounts that exist.
 *
 * ## What it deliberately does not do
 *
 * It does not stop the shop trading. A till that is still open, an invoice
 * confirmed in January for goods received in December — those still post, and
 * they post *after* the line rather than being refused. The alternative is a
 * sale that cannot be rung up because the accountant closed a year, which is
 * the tail wagging the dog.
 *
 * And it can be undone. Not by deleting anything — the closing entry is
 * reversed and the row is marked reopened, so "closed in January, opened again
 * in March" stays visible, which is exactly the fact somebody checking the
 * books needs to see.
 */
import { db, transaction } from '../db.js';
import { round2 } from './currency.js';
import { postEntry, reverseEntry, signedBalance } from './ledger.js';
import { closedThrough, isClosed } from './periodLock.js';

export { closedThrough, isClosed } from './periodLock.js';

/** Where a year's profit goes to rest. */
export const RETAINED = '3900';

/**
 * What closing on this date would move, before anything is moved.
 *
 * Account by account rather than one figure, because "your profit was $14,000"
 * is not something a shopkeeper can check and "sales 40,000, wages 9,000,
 * rent 6,000, stock 11,000" is.
 */
export function closingPreview({ to = null } = {}) {
  const end = to || new Date().toISOString().slice(0, 10);

  const rows = db
    .prepare(
      `SELECT a.id, a.code, a.name, a.type,
              COALESCE(SUM(l.debit_usd), 0) AS debit,
              COALESCE(SUM(l.credit_usd), 0) AS credit
       FROM gl_accounts a
       JOIN journal_lines l ON l.account_id = a.id
       JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
       WHERE a.type IN ('income', 'expense')
         AND a.is_group = 0
         AND e.entry_date <= ?
         AND (? IS NULL OR e.entry_date > ?)
       GROUP BY a.id
       ORDER BY a.code`,
    )
    /* Only what has happened since the last line was drawn. Everything before
       it was already swept into retained earnings, and sweeping it twice would
       double last year's profit into this year's. */
    .all(end, closedThrough(), closedThrough());

  const accounts = rows
    .map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      balance: signedBalance(r.type, round2(r.debit), round2(r.credit)),
    }))
    .filter((a) => a.balance !== 0);

  const earned = accounts
    .filter((a) => a.type === 'income')
    .reduce((sum, a) => round2(sum + a.balance), 0);
  const spent = accounts
    .filter((a) => a.type === 'expense')
    .reduce((sum, a) => round2(sum + a.balance), 0);

  return {
    to: end,
    from: closedThrough(),
    accounts,
    earned,
    spent,
    profit: round2(earned - spent),
    alreadyClosed: isClosed(end),
  };
}

/**
 * Close it.
 *
 * Every income account is debited by what it earned and every expense account
 * credited by what it spent — the opposite of their normal sides, which is
 * what brings them to nothing — and the difference lands in retained earnings.
 */
export function closePeriod({ to, note = null, branchId = null, userId = null }) {
  const end = String(to || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('A closing needs a date to close up to');
  if (isClosed(end)) throw new Error(`The books are already closed through ${closedThrough()}`);

  const preview = closingPreview({ to: end });

  return transaction(() => {
    let entry = null;

    /* A period with nothing in it still closes. A shop that traded nothing in
       a quarter has still finished that quarter, and refusing to shut it would
       leave it open for a back-dated invoice for ever. */
    if (preview.accounts.length > 0) {
      const lines = preview.accounts.map((a) => ({
        accountId: a.id,
        /* Income normally sits on the credit side, so it is closed by a debit;
           expense the other way round. Either way the account comes to zero. */
        debit: a.type === 'income' ? a.balance : 0,
        credit: a.type === 'expense' ? a.balance : 0,
        memo: `${a.name} closed`,
      }));

      if (preview.profit !== 0) {
        lines.push({
          accountId: retainedId(),
          debit: preview.profit < 0 ? Math.abs(preview.profit) : 0,
          credit: preview.profit > 0 ? preview.profit : 0,
          memo: preview.profit >= 0 ? 'Profit for the period' : 'Loss for the period',
        });
      }

      entry = postEntry({
        entryDate: end,
        memo: `Books closed to ${end}`,
        lines,
        source: 'closing',
        branchId,
        userId,
        /* The entry that shuts the period is dated inside it, which every
           other entry is about to be refused for. It is the one exception,
           and it is the reason the flag exists. */
        allowClosed: true,
      });
    }

    const info = db
      .prepare(
        `INSERT INTO book_closings (period_end, entry_id, profit_usd, note, user_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(end, entry?.id ?? null, preview.profit, note || null, userId ?? null);

    return { closing: byId(info.lastInsertRowid), entry, preview };
  })();
}

function retainedId() {
  const row = db
    .prepare('SELECT id FROM gl_accounts WHERE code = ? AND active = 1 AND is_group = 0')
    .get(RETAINED);
  if (!row) throw new Error(`There is no ${RETAINED} Retained earnings account to close into`);
  return row.id;
}

export function byId(id) {
  const row = db
    .prepare(
      `SELECT c.*, u.name AS closed_by_name, r.name AS reopened_by_name,
              e.entry_number
       FROM book_closings c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN users r ON r.id = c.reopened_by
       LEFT JOIN journal_entries e ON e.id = c.entry_id
       WHERE c.id = ?`,
    )
    .get(id);
  return row ?? null;
}

export function listClosings() {
  return db
    .prepare(
      `SELECT c.*, u.name AS closed_by_name, r.name AS reopened_by_name, e.entry_number
       FROM book_closings c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN users r ON r.id = c.reopened_by
       LEFT JOIN journal_entries e ON e.id = c.entry_id
       ORDER BY c.period_end DESC, c.id DESC`,
    )
    .all();
}

/**
 * Open it again.
 *
 * The closing entry is reversed rather than deleted, so the books still show
 * that a line was drawn and then rubbed out. Only the most recent closing can
 * be reopened: reopening 2023 while 2024 is still shut would leave 2023's
 * earnings swept into retained earnings by a closing that no longer exists.
 */
export function reopen(id, { userId = null } = {}) {
  const closing = byId(id);
  if (!closing) throw new Error('That closing does not exist');
  if (closing.reopened_at) throw new Error('That period has already been reopened');

  const latest = db
    .prepare('SELECT id FROM book_closings WHERE reopened_at IS NULL ORDER BY period_end DESC, id DESC LIMIT 1')
    .get();
  if (latest && latest.id !== closing.id) {
    throw new Error('Reopen the most recent closing first — periods have to come undone in the order they were shut');
  }

  return transaction(() => {
    if (closing.entry_id) {
      reverseEntry(closing.entry_id, {
        userId,
        memo: `Books reopened for ${closing.period_end}`,
        allowClosed: true,
      });
    }
    db.prepare("UPDATE book_closings SET reopened_at = datetime('now'), reopened_by = ? WHERE id = ?")
      .run(userId ?? null, id);
    return byId(id);
  })();
}

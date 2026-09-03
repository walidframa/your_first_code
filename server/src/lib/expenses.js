/**
 * What it costs to run the shop.
 *
 * Rent, electricity, wages, the van's fuel — none of it appears on an invoice,
 * and without it a "profit" figure is only gross margin wearing a better name.
 *
 * An expense paid from the till also moves the drawer, so the two are recorded
 * together: one action by the shopkeeper, one place it can be wrong.
 */
import { db, transaction } from '../db.js';
import { round2 } from './currency.js';
import { getSettings } from './settings.js';
import {
  currentSession,
  needsOfficeCash,
  openingOfficeCash,
  recordMovement,
  settlementAccountId,
} from './cash.js';
import { postExpense } from './postings.js';

/**
 * Categories are a fixed list rather than free text: a month's spending that
 * cannot be grouped cannot be compared with last month's.
 */
export const EXPENSE_CATEGORIES = [
  'rent',
  'utilities',
  'wages',
  'supplies',
  'transport',
  'maintenance',
  'marketing',
  'fees',
  'tax',
  'other',
];

export const PAID_WITH = ['cash', 'bank', 'card', 'other'];

/** Total in USD, converting pounds at the rate recorded on the expense. */
export function expenseTotal(row) {
  const rate = Number(row.exchange_rate);
  const lbpAsUsd = rate > 0 ? Number(row.amount_lbp || 0) / rate : 0;
  return round2(Number(row.amount_usd || 0) + lbpAsUsd);
}

const withTotal = (row) => ({ ...row, total_usd: expenseTotal(row) });

/**
 * Every expense in a period, unpaged, for adding up.
 *
 * `spent_on` rather than `created_at`, because an expense is dated by the day
 * the money went — a shopkeeper entering Friday's electricity bill on Monday
 * means it to land on Friday, and the date box is there for exactly that.
 */
function allExpensesIn({ from = null, to = null, branchId = null } = {}) {
  const where = [];
  const params = [];
  if (from) {
    where.push('spent_on >= ?');
    params.push(from);
  }
  if (to) {
    where.push('spent_on <= ?');
    params.push(to);
  }
  if (branchId) {
    where.push('branch_id = ?');
    params.push(branchId);
  }
  return db
    .prepare(`SELECT * FROM expenses ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`)
    .all(...params)
    .map(withTotal);
}

/**
 * What was spent while the drawer was open, by when it was written down.
 *
 * A sitting is a stretch of hours, not a date, and the two are different every
 * time somebody opens the till at nine having paid the water bill at eight.
 * The register's own profit figure is about *this* sitting, so it counts what
 * was recorded during it — the alternative, everything dated that day, put the
 * morning's bill against the afternoon's cashier, and on a drawer still open
 * it counted every expense from the day it opened onwards.
 */
export function expensesDuring({ from, to = null, branchId = null } = {}) {
  const where = ['created_at >= ?'];
  const params = [from];
  if (to) {
    where.push('created_at <= ?');
    params.push(to);
  }
  if (branchId) {
    where.push('branch_id = ?');
    params.push(branchId);
  }
  const rows = db
    .prepare(`SELECT * FROM expenses WHERE ${where.join(' AND ')}`)
    .all(...params)
    .map(withTotal);

  return summarise(rows);
}

/** The shape both summaries answer in. */
function summarise(rows) {
  const byCategory = {};
  for (const row of rows) {
    const entry = (byCategory[row.category] ||= { category: row.category, count: 0, total: 0 });
    entry.count += 1;
    entry.total = round2(entry.total + row.total_usd);
  }
  return {
    total: round2(rows.reduce((sum, r) => sum + r.total_usd, 0)),
    count: rows.length,
    byCategory: Object.values(byCategory).sort((a, b) => b.total - a.total),
  };
}

export function listExpenses({ from = null, to = null, category = null, branchId = null, limit = 500 } = {}) {
  let sql = `
    SELECT e.*, u.name AS user_name, s.name AS supplier_name
    FROM expenses e
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN suppliers s ON s.id = e.supplier_id
    WHERE 1=1`;
  const params = [];

  if (from) {
    sql += ' AND e.spent_on >= ?';
    params.push(from);
  }
  if (to) {
    sql += ' AND e.spent_on <= ?';
    params.push(to);
  }
  if (category) {
    sql += ' AND e.category = ?';
    params.push(category);
  }
  // Null means the whole company; a branch's own figures need its own spending.
  if (branchId) {
    sql += ' AND e.branch_id = ?';
    params.push(branchId);
  }
  sql += ' ORDER BY e.spent_on DESC, e.id DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 500, 1000));

  return db.prepare(sql).all(...params).map(withTotal);
}

export function getExpense(id) {
  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  return row ? withTotal(row) : null;
}

function validate({ category, paidWith, amountUsd, amountLbp }) {
  if (!EXPENSE_CATEGORIES.includes(category)) {
    throw new Error(`Category must be one of: ${EXPENSE_CATEGORIES.join(', ')}`);
  }
  if (!PAID_WITH.includes(paidWith)) {
    throw new Error(`Paid with must be one of: ${PAID_WITH.join(', ')}`);
  }
  const usd = round2(Number(amountUsd) || 0);
  const lbp = Math.round(Number(amountLbp) || 0);
  if (usd < 0 || lbp < 0) throw new Error('An expense cannot be negative');
  if (usd === 0 && lbp === 0) throw new Error('Enter an amount in dollars, pounds, or both');
  return { usd, lbp };
}

/**
 * Record an expense.
 *
 * Paid in cash with the drawer open, it comes out of the drawer as well — the
 * money really did leave the till, and a close that ignored it would come up
 * short for no visible reason.
 *
 * With the drawer shut it used to come out of nothing. The cash movement was
 * written only `if (session)`, so an owner paying the electricity bill before
 * opening time got the expense in the books, in the profit figure and in the
 * ledger — and not one cash record anywhere. The shop's cash on hand stayed
 * exactly as high as it had been the moment before the money left.
 *
 * So the money always goes somewhere. The open drawer if there is one, because
 * that is the till the note was taken out of; otherwise the office's own cash
 * (see `settlementAccountId`), which is where a bill paid at a desk comes from
 * and which needs nothing opened.
 */
export function addExpense({
  branchId = null,
  spentOn = null,
  category,
  amountUsd = 0,
  amountLbp = 0,
  paidWith = 'cash',
  supplierId = null,
  note = null,
  userId = null,
}) {
  const { usd, lbp } = validate({ category, paidWith, amountUsd, amountLbp });
  const { exchange_rate: rate } = getSettings();

  return transaction(() => {
    let movementId = null;
    // This branch's drawer, not the company's first one — an expense paid at
    // the second shop comes out of the till standing in front of the person
    // paying it.
    const session = paidWith === 'cash' ? currentSession(null, branchId) : null;
    let account = null;
    if (paidWith === 'cash') {
      // The open drawer if there is one, because that is the till the note came
      // out of. Otherwise the office's own cash, which is where a bill paid at a
      // desk with the shop shut comes from — named on the spot if it has to be.
      account = session?.account_id ?? settlementAccountId(branchId);
      if (needsOfficeCash(account)) account = openingOfficeCash(branchId);
    }

    if (account) {
      /*
       * More than the drawer holds is recorded, not refused — the same rule as
       * a manual pay-out, and for the same reason: the money has gone either
       * way, and a refusal only stops the shop writing that down. The caller
       * reports it; see SHORT_DRAWER_WARNING.
       */
      movementId = recordMovement({
        accountId: account,
        sessionId: session?.id ?? null,
        kind: 'cash_out',
        amountUsd: -usd,
        amountLbp: -lbp,
        reason: category === 'wages' ? 'wages' : 'expense',
        note: note ? `${category} — ${note}` : category,
        userId,
      });
    }

    const info = db
      .prepare(
        `INSERT INTO expenses
           (spent_on, category, amount_usd, amount_lbp, exchange_rate, paid_with, supplier_id, note,
            cash_movement_id, user_id, branch_id)
         VALUES (COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        spentOn || null, category, usd, lbp, rate, paidWith, supplierId || null, note, movementId, userId,
        // Which shop paid for it — a branch's net profit has to carry its own
        // rent and its own electricity, not the other branch's.
        branchId ?? null,
      );

    const saved = getExpense(info.lastInsertRowid);
    // The books, in the same transaction — see lib/postings.js.
    postExpense({ expense: saved, tillAccountId: account, userId });
    return saved;
  })();
}

/**
 * Delete an expense, and undo the drawer movement it caused.
 *
 * Leaving the movement behind would make the till short by an expense the books
 * no longer believe in.
 */
export function deleteExpense(id, userId = null) {
  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  if (!expense) throw new Error('Expense not found');

  return transaction(() => {
    if (expense.cash_movement_id) {
      const movement = db
        .prepare('SELECT * FROM cash_movements WHERE id = ?')
        .get(expense.cash_movement_id);
      if (movement) {
        recordMovement({
          sessionId: movement.session_id,
          kind: 'correction',
          amountUsd: -movement.amount_usd,
          amountLbp: -movement.amount_lbp,
          reason: 'correction',
          note: `Deleted expense: ${expense.category}`,
          userId,
        });
      }
    }
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    return { ok: true };
  })();
}

/** Spending in a period, per category and in total. */
export function expenseSummary({ from = null, to = null, branchId = null } = {}) {
  /*
   * Every one of them, not the first thousand.
   *
   * This used to lean on `listExpenses`, which takes a limit because it draws
   * a table — so a shop with more than a thousand expenses in the period had
   * the rest quietly dropped, and the profit it was shown was too good. A
   * summary has no page to fill, so it reads the lot.
   */
  const rows = allExpensesIn({ from, to, branchId });

  return summarise(rows);
}

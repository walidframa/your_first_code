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
import { currentSession, expectedIn, recordMovement } from './cash.js';

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

export function listExpenses({ from = null, to = null, category = null, limit = 500 } = {}) {
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
 */
export function addExpense({
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
    const session = paidWith === 'cash' ? currentSession() : null;

    if (session) {
      /*
       * Money that is not in the drawer cannot have come out of it. Without
       * this the till goes negative and every count afterwards is wrong — and
       * an expense really paid from somewhere else should say so.
       */
      const held = expectedIn(session.id);
      if (usd > held.usd || lbp > held.lbp) {
        throw new Error(
          `The drawer only holds ${held.usd.toFixed(2)} USD and ${held.lbp.toLocaleString()} LL — ` +
            'record this as paid by bank, or put cash in first',
        );
      }

      movementId = recordMovement({
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
            cash_movement_id, user_id)
         VALUES (COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(spentOn || null, category, usd, lbp, rate, paidWith, supplierId || null, note, movementId, userId);

    return getExpense(info.lastInsertRowid);
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
export function expenseSummary({ from = null, to = null } = {}) {
  const rows = listExpenses({ from, to, limit: 1000 });

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

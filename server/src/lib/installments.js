/**
 * Paying for a phone over months — تقسيط.
 *
 * A four-hundred-dollar handset goes out for a hundred and fifty down and the
 * rest over four months. The shop already knows how to put that on a customer's
 * account; what it could not do was say **when** it expects the money, which is
 * the only question that matters once a dozen customers are doing it.
 *
 * So a plan is a schedule laid over a debt that already exists in
 * `account_entries`, never a second set of books. That ledger stays the one
 * true answer to what is owed — a customer who pays cash at the counter without
 * anybody mentioning the plan still owes less, and the plan must not disagree.
 * Allocation is a bookkeeping convenience on top: it says which month the money
 * was for, not whether it arrived.
 */
import { db, transaction } from '../db.js';
import { round2 } from './currency.js';

/** Cash-flow instalments split as evenly as money allows, remainder first. */
export function split(total, count) {
  const cents = Math.round(round2(total) * 100);
  const base = Math.floor(cents / count);
  const over = cents - base * count;

  /*
   * The odd cents go on the **first** payment rather than the last. A shop
   * would rather be a cent ahead early than explain a different final figure to
   * somebody who has been paying the same amount for four months.
   */
  return Array.from({ length: count }, (_, i) => round2((base + (i < over ? 1 : 0)) / 100));
}

/** The same day of each following month, clamped so the 31st survives February. */
export function monthlyDates(start, count) {
  const first = new Date(`${start}T00:00:00Z`);
  const day = first.getUTCDate();

  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1));
    // The last day of that month, when the month is too short for the day.
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString().slice(0, 10);
  });
}

export function createPlan({
  customerId,
  orderId = null,
  total,
  count,
  startDate,
  note = null,
  branchId = null,
  userId = null,
}) {
  const amount = round2(Number(total));
  if (!(amount > 0)) throw new Error('Say how much is being paid off');
  const months = Number(count);
  if (!Number.isInteger(months) || months < 1 || months > 60) {
    throw new Error('A plan runs between 1 and 60 payments');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) {
    throw new Error('Say when the first payment is due');
  }

  return transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO installment_plans (customer_id, order_id, total_usd, note, branch_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(customerId, orderId, amount, note, branchId, userId);

    const planId = info.lastInsertRowid;
    const amounts = split(amount, months);
    const dates = monthlyDates(startDate, months);
    const insert = db.prepare(
      'INSERT INTO installment_dues (plan_id, due_date, amount_usd) VALUES (?, ?, ?)',
    );
    for (const [i, due] of amounts.entries()) insert.run(planId, dates[i], due);

    return planId;
  })();
}

/**
 * Put a payment against the months it covers, oldest first.
 *
 * Nothing here moves money — the payment has already been recorded against the
 * customer's account by the ordinary route. This only marks which instalments
 * it settles, so the shop can see what is still outstanding rather than only
 * how much is.
 *
 * Anything left over after the last due is simply not allocated: a customer who
 * pays more than the plan is ahead on their account, which the ledger already
 * says, and inventing a due to hold it would be inventing debt.
 */
export function allocate(planId, amount) {
  let left = round2(amount);
  if (!(left > 0)) return 0;

  const dues = db
    .prepare(
      'SELECT * FROM installment_dues WHERE plan_id = ? AND paid_usd < amount_usd ORDER BY due_date, id',
    )
    .all(planId);

  let allocated = 0;
  for (const due of dues) {
    if (left <= 0) break;
    const owing = round2(due.amount_usd - due.paid_usd);
    const put = Math.min(owing, left);
    const nowPaid = round2(due.paid_usd + put);

    db.prepare('UPDATE installment_dues SET paid_usd = ?, paid_at = ? WHERE id = ?').run(
      nowPaid,
      nowPaid >= due.amount_usd ? new Date().toISOString().slice(0, 10) : null,
      due.id,
    );

    left = round2(left - put);
    allocated = round2(allocated + put);
  }

  settleIfDone(planId);
  return allocated;
}

/** A plan with nothing outstanding is finished, and stops being chased. */
export function settleIfDone(planId) {
  const { owing } = db
    .prepare(
      'SELECT COALESCE(SUM(amount_usd - paid_usd), 0) AS owing FROM installment_dues WHERE plan_id = ?',
    )
    .get(planId);

  db.prepare('UPDATE installment_plans SET status = ? WHERE id = ? AND status != ?').run(
    owing <= 0 ? 'settled' : 'active',
    planId,
    'cancelled',
  );
  return round2(owing);
}

/** One plan with its schedule and where it stands. */
export function planWithDues(planId) {
  const plan = db
    .prepare(
      `SELECT p.*, c.name AS customer_name, c.phone AS customer_phone, o.order_number
       FROM installment_plans p
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN orders o ON o.id = p.order_id
       WHERE p.id = ?`,
    )
    .get(planId);
  if (!plan) return null;

  const dues = db
    .prepare('SELECT * FROM installment_dues WHERE plan_id = ? ORDER BY due_date, id')
    .all(planId);

  return { ...plan, dues, ...standing(dues) };
}

/**
 * Where a plan stands, as the counter would put it.
 *
 * "Overdue" is measured against today rather than stored, so a plan that goes
 * late overnight is late in the morning without anything having run.
 */
export function standing(dues, today = new Date().toISOString().slice(0, 10)) {
  const paid = round2(dues.reduce((sum, d) => sum + d.paid_usd, 0));
  const total = round2(dues.reduce((sum, d) => sum + d.amount_usd, 0));
  const outstanding = round2(total - paid);

  const unpaid = dues.filter((d) => d.paid_usd < d.amount_usd);
  const overdue = unpaid.filter((d) => d.due_date < today);

  return {
    paidUsd: paid,
    outstandingUsd: outstanding,
    overdueUsd: round2(overdue.reduce((sum, d) => sum + (d.amount_usd - d.paid_usd), 0)),
    overdueCount: overdue.length,
    nextDue: unpaid[0] ? { date: unpaid[0].due_date, amount: round2(unpaid[0].amount_usd - unpaid[0].paid_usd) } : null,
  };
}

/** Every plan, newest first, each with where it stands. */
export function listPlans({ status = null } = {}) {
  const plans = db
    .prepare(
      `SELECT p.*, c.name AS customer_name, c.phone AS customer_phone, o.order_number
       FROM installment_plans p
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN orders o ON o.id = p.order_id
       ${status ? 'WHERE p.status = ?' : ''}
       ORDER BY p.created_at DESC, p.id DESC`,
    )
    .all(...(status ? [status] : []));

  const dues = db.prepare('SELECT * FROM installment_dues ORDER BY due_date, id').all();
  const byPlan = new Map();
  for (const d of dues) {
    if (!byPlan.has(d.plan_id)) byPlan.set(d.plan_id, []);
    byPlan.get(d.plan_id).push(d);
  }

  return plans.map((p) => ({ ...p, dues: byPlan.get(p.id) || [], ...standing(byPlan.get(p.id) || []) }));
}

/**
 * The cash drawers.
 *
 * One open session at a time *per till*. A shop with a register, a transfer
 * desk and a safe has three piles of money, counted by different people at
 * different times; one figure covering all of them is a figure nobody can
 * check. So a sitting belongs to a till, and so does every movement.
 *
 * Everything that moves physical money records a movement, so at any moment a
 * till's expected contents is its opening float plus its movements — a figure
 * that can be checked against a count rather than trusted.
 *
 * Dollars and pounds are tracked side by side, never converted into one
 * another. A drawer holding $100 and 2,000,000 LL is right or wrong in each
 * currency independently, and folding them together would make yesterday's
 * correct count look short after the rate moves.
 */
import { db, transaction } from '../db.js';
import { round2, roundLbp } from './currency.js';
import { getSettings } from './settings.js';

/**
 * Why cash left the drawer, beyond the sale itself. Free text alone would make
 * a month's spending impossible to add up.
 */
export const CASH_OUT_REASONS = [
  'supplier',
  'expense',
  'wages',
  'owner_draw',
  'bank_drop',
  'refund',
  'other',
];

export const CASH_IN_REASONS = ['petty_cash', 'owner_funds', 'customer_payment', 'correction', 'other'];

/** Notes in circulation, for counting a drawer without adding up in your head. */
export const DENOMINATIONS = {
  USD: [100, 50, 20, 10, 5, 1],
  LBP: [100000, 50000, 20000, 10000, 5000, 1000],
};

/**
 * The till everything falls back to.
 *
 * Every caller that does not care which drawer — a sale at the register, a
 * supplier paid from the back office — gets this one, which is what lets tills
 * be added without touching any of them.
 */
export function defaultAccountId(branchId = null) {
  /*
   * A branch's own drawer first. Two shops sharing a till would mean the second
   * one's takings landing in the first one's count — and neither could be
   * closed against what is physically in it.
   */
  if (branchId) {
    const theirs = db
      .prepare('SELECT id FROM cash_accounts WHERE branch_id = ? AND active = 1 ORDER BY is_default DESC, id LIMIT 1')
      .get(branchId);
    if (theirs) return theirs.id;
  }
  return db.prepare('SELECT id FROM cash_accounts WHERE is_default = 1').get()?.id ?? null;
}

export function currentSession(accountId = null, branchId = null) {
  const id = accountId ?? defaultAccountId(branchId);
  return db
    .prepare(
      `SELECT s.*, u.name AS opened_by_name, a.name AS account_name
       FROM cash_sessions s
       LEFT JOIN users u ON u.id = s.opened_by
       LEFT JOIN cash_accounts a ON a.id = s.account_id
       WHERE s.status = 'open' AND s.account_id = ? ORDER BY s.id DESC LIMIT 1`,
    )
    .get(id);
}

export function sessionById(id) {
  return db
    .prepare(
      `SELECT s.*, u.name AS opened_by_name, c.name AS closed_by_name, a.name AS account_name
       FROM cash_sessions s
       LEFT JOIN users u ON u.id = s.opened_by
       LEFT JOIN users c ON c.id = s.closed_by
       LEFT JOIN cash_accounts a ON a.id = s.account_id
       WHERE s.id = ?`,
    )
    .get(id);
}

export function requiresSession() {
  return getSettings().require_cash_session !== 'false';
}

/**
 * Open the drawer.
 *
 * The float is the money already in it — yesterday's carried-over change, or
 * petty cash put in now. Recording it as a movement rather than only a column
 * means the drawer's contents is one sum from one place.
 */
export function openSession({
  userId,
  openingUsd = 0,
  openingLbp = 0,
  note = null,
  accountId = null,
  branchId = null,
}) {
  const account = accountId ?? defaultAccountId(branchId);
  if (currentSession(account)) throw new Error('That cashbox is already open');

  const usd = round2(Number(openingUsd) || 0);
  const lbp = Math.round(Number(openingLbp) || 0);
  if (usd < 0 || lbp < 0) throw new Error('An opening float cannot be negative');

  const { exchange_rate: rate } = getSettings();

  return transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO cash_sessions (account_id, opened_by, opening_usd, opening_lbp, opening_note, exchange_rate)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(account, userId, usd, lbp, note || null, rate);

    if (usd > 0 || lbp > 0) {
      db.prepare(
        `INSERT INTO cash_movements (session_id, account_id, kind, amount_usd, amount_lbp, reason, note, user_id)
         VALUES (?, ?, 'opening_float', ?, ?, 'petty_cash', ?, ?)`,
      ).run(info.lastInsertRowid, account, usd, lbp, note || 'Opening float', userId);
    }

    return sessionById(info.lastInsertRowid);
  })();
}

/**
 * Record money moving in or out.
 *
 * Called by the register and the back office alike, so a supplier paid from the
 * till and a sale rung up land in the same place. Silently does nothing when no
 * session is open: a card sale should not fail because the drawer is shut, and
 * cash sales are stopped earlier, where the message can say why.
 */
export function recordMovement({
  kind,
  amountUsd = 0,
  amountLbp = 0,
  reason = null,
  note = null,
  orderId = null,
  documentId = null,
  userId = null,
  sessionId = null,
  accountId = null,
  branchId = null,
}) {
  const usd = round2(Number(amountUsd) || 0);
  const lbp = Math.round(Number(amountLbp) || 0);
  if (usd === 0 && lbp === 0) return null;

  const account = accountId ?? defaultAccountId(branchId);
  const session = sessionId ? sessionById(sessionId) : currentSession(account);
  if (!session) return null;

  const info = db
    .prepare(
      `INSERT INTO cash_movements
         (session_id, account_id, kind, amount_usd, amount_lbp, reason, note, order_id, document_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(session.id, session.account_id ?? account, kind, usd, lbp, reason, note, orderId, documentId, userId);

  return info.lastInsertRowid;
}

export function movementsFor(sessionId) {
  return db
    .prepare(
      `SELECT m.*, u.name AS user_name, o.order_number, d.doc_number
       FROM cash_movements m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN orders o ON o.id = m.order_id
       LEFT JOIN documents d ON d.id = m.document_id
       WHERE m.session_id = ? ORDER BY m.created_at, m.id`,
    )
    .all(sessionId);
}

/** What should be in the drawer: every movement, added up per currency. */
export function expectedIn(sessionId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) AS usd, COALESCE(SUM(amount_lbp), 0) AS lbp
       FROM cash_movements WHERE session_id = ?`,
    )
    .get(sessionId);
  return { usd: round2(row.usd), lbp: Math.round(row.lbp) };
}

/**
 * Whether the drawer has been taken below zero.
 *
 * A fact rather than a figure, so it can be told to a cashier who counts blind
 * without handing them the number the count is supposed to produce. Money going
 * out that is not there is allowed — refusing it does not put the money back,
 * it only stops the shop writing down what happened — but it is never silent.
 */
export function drawerShort(sessionId) {
  const held = expectedIn(sessionId);
  return held.usd < 0 || held.lbp < 0;
}

/** Said the same way wherever the drawer has just gone below zero. */
export const SHORT_DRAWER_WARNING =
  'That is more than the drawer holds. It is recorded — the till is now showing less than ' +
  'nothing, so something earlier is missing.';

/**
 * Everything a shopkeeper wants to see about one sitting: what came in, what
 * went out, and — once closed — whether the drawer agreed.
 *
 * This is the Z-report every till produces at the end of a shift.
 */
export function sessionSummary(sessionId) {
  const session = sessionById(sessionId);
  if (!session) return null;

  const movements = movementsFor(sessionId);
  const expected = expectedIn(sessionId);

  const byKind = {};
  for (const m of movements) {
    const entry = (byKind[m.kind] ||= { kind: m.kind, count: 0, usd: 0, lbp: 0 });
    entry.count += 1;
    entry.usd = round2(entry.usd + m.amount_usd);
    entry.lbp += m.amount_lbp;
  }

  // Sales in the sitting, however they were paid — a shift report that only
  // counted cash would understate the day's takings.
  const sales = db
    .prepare(
      `SELECT payment_method, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total
       FROM orders
       WHERE status = 'completed' AND created_at >= ? AND created_at <= COALESCE(?, datetime('now'))
       GROUP BY payment_method`,
    )
    .all(session.opened_at, session.closed_at);

  const refunds = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total
       FROM orders
       WHERE status = 'refunded' AND created_at >= ? AND created_at <= COALESCE(?, datetime('now'))`,
    )
    .get(session.opened_at, session.closed_at);

  return {
    session,
    movements,
    expected,
    byKind: Object.values(byKind),
    sales: sales.map((s) => ({ ...s, total: round2(s.total) })),
    salesTotal: round2(sales.reduce((sum, s) => sum + s.total, 0)),
    refunds: { orders: refunds.orders, total: round2(refunds.total) },
  };
}

/**
 * Close the drawer against a physical count.
 *
 * The count is taken before the expected figure is shown — a blind count. Told
 * the answer first, a tired cashier will write it down whether the money is
 * there or not, and the one number the exercise exists to produce becomes
 * meaningless.
 *
 * Whatever is not carried forward as the next float has left for the bank, and
 * is recorded as such so the drawer starts the next sitting at the right figure.
 */
export function closeSession({
  sessionId,
  userId,
  countedUsd = 0,
  countedLbp = 0,
  carriedUsd = null,
  carriedLbp = null,
  note = null,
}) {
  const session = sessionById(sessionId);
  if (!session) throw new Error('That cashbox session does not exist');
  if (session.status === 'closed') throw new Error('That session is already closed');

  const counted = { usd: round2(Number(countedUsd) || 0), lbp: Math.round(Number(countedLbp) || 0) };
  if (counted.usd < 0 || counted.lbp < 0) throw new Error('A count cannot be negative');

  const expected = expectedIn(sessionId);
  const overShort = {
    usd: round2(counted.usd - expected.usd),
    lbp: Math.round(counted.lbp - expected.lbp),
  };

  // Default to leaving nothing behind; the shop decides what float to keep.
  const carried = {
    usd: round2(carriedUsd === null ? 0 : Number(carriedUsd) || 0),
    lbp: Math.round(carriedLbp === null ? 0 : Number(carriedLbp) || 0),
  };
  if (carried.usd > counted.usd || carried.lbp > counted.lbp) {
    throw new Error('You cannot carry forward more than was counted');
  }

  return transaction(() => {
    // A miscount is a real difference in the drawer, so it is recorded as a
    // movement too — otherwise the next session would start from a figure the
    // drawer never held.
    if (overShort.usd !== 0 || overShort.lbp !== 0) {
      recordMovement({
        sessionId,
        kind: 'correction',
        amountUsd: overShort.usd,
        amountLbp: overShort.lbp,
        reason: overShort.usd < 0 || overShort.lbp < 0 ? 'short' : 'over',
        note: 'Counted at close',
        userId,
      });
    }

    const banked = { usd: round2(counted.usd - carried.usd), lbp: counted.lbp - carried.lbp };
    if (banked.usd > 0 || banked.lbp > 0) {
      recordMovement({
        sessionId,
        kind: 'bank_drop',
        amountUsd: -banked.usd,
        amountLbp: -banked.lbp,
        reason: 'bank_drop',
        note: 'Taken out of the drawer at close',
        userId,
      });
    }

    db.prepare(
      `UPDATE cash_sessions SET status = 'closed', closed_by = ?, closed_at = datetime('now'),
         counted_usd = ?, counted_lbp = ?, expected_usd = ?, expected_lbp = ?,
         over_short_usd = ?, over_short_lbp = ?, carried_usd = ?, carried_lbp = ?, closing_note = ?
       WHERE id = ?`,
    ).run(
      userId,
      counted.usd,
      counted.lbp,
      expected.usd,
      expected.lbp,
      overShort.usd,
      overShort.lbp,
      carried.usd,
      carried.lbp,
      note || null,
      sessionId,
    );

    return sessionSummary(sessionId);
  })();
}

export function listSessions(limit = 50, accountId = null) {
  return db
    .prepare(
      `SELECT s.*, u.name AS opened_by_name, c.name AS closed_by_name, a.name AS account_name,
              (SELECT COUNT(*) FROM cash_movements m WHERE m.session_id = s.id) AS movement_count
       FROM cash_sessions s
       LEFT JOIN users u ON u.id = s.opened_by
       LEFT JOIN users c ON c.id = s.closed_by
       LEFT JOIN cash_accounts a ON a.id = s.account_id
       WHERE (? IS NULL OR s.account_id = ?)
       ORDER BY s.opened_at DESC, s.id DESC LIMIT ?`,
    )
    .all(accountId, accountId, Math.min(Number(limit) || 50, 200));
}

/** Total a count entered note by note, e.g. { "50000": 3, "10000": 2 }. */
export function totalDenominations(counts, currency) {
  const allowed = new Set(DENOMINATIONS[currency] || []);
  let total = 0;
  for (const [note, quantity] of Object.entries(counts || {})) {
    const value = Number(note);
    const n = Number(quantity) || 0;
    if (!allowed.has(value) || n < 0) continue;
    total += value * n;
  }
  return currency === 'LBP' ? roundLbp(total, 1) : round2(total);
}

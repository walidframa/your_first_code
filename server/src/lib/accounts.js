import { db } from '../db.js';
import { round2, tenderTotals, validatePayments } from './currency.js';
import { getSettings } from './settings.js';

export const PARTY_TABLES = { customer: 'customers', supplier: 'suppliers' };

/**
 * Outstanding balance for one party, in USD.
 *
 * Positive means money is owed: by the customer to the shop, or by the shop to
 * the supplier. The sign convention is baked into the ledger, so both sides of
 * the book use the same query.
 */
export function balanceOf(partyType, partyId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) AS balance
       FROM account_entries WHERE party_type = ? AND party_id = ?`,
    )
    .get(partyType, partyId);
  return round2(row.balance);
}

/** Balances for every party of a type, keyed by id — avoids a query per row. */
export function balanceMap(partyType) {
  const rows = db
    .prepare(
      `SELECT party_id, COALESCE(SUM(amount_usd), 0) AS balance
       FROM account_entries WHERE party_type = ? GROUP BY party_id`,
    )
    .all(partyType);
  return new Map(rows.map((r) => [r.party_id, round2(r.balance)]));
}

export function listEntries(partyType, partyId, limit = 100) {
  return db
    .prepare(
      `SELECT e.*, u.name AS user_name, o.order_number
       FROM account_entries e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN orders o ON o.id = e.order_id
       WHERE e.party_type = ? AND e.party_id = ?
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ?`,
    )
    .all(partyType, partyId, Math.min(Number(limit) || 100, 500));
}

export function addEntry({
  partyType,
  partyId,
  kind,
  amountUsd,
  paidUsd = 0,
  paidLbp = 0,
  exchangeRate = null,
  orderId = null,
  note = null,
  userId = null,
}) {
  const info = db
    .prepare(
      `INSERT INTO account_entries
         (party_type, party_id, kind, amount_usd, paid_usd, paid_lbp, exchange_rate, order_id, note, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(partyType, partyId, kind, round2(amountUsd), round2(paidUsd), Math.round(paidLbp), exchangeRate, orderId, note, userId);
  return info.lastInsertRowid;
}

/**
 * Turn a dual-currency payment into a ledger entry that reduces the balance.
 * Returns { entryId, amountUsd } or throws with a user-facing message.
 */
export function recordPayment({ partyType, partyId, payments, note, userId }) {
  const invalid = validatePayments(payments || []);
  if (invalid) throw new Error(invalid);

  const { exchange_rate: rate } = getSettings();
  const totals = tenderTotals(payments, rate);
  if (totals.totalUsdEquivalent <= 0) {
    throw new Error('Payment must be greater than zero');
  }

  const entryId = addEntry({
    partyType,
    partyId,
    kind: 'payment',
    // Negative: a payment reduces what is outstanding.
    amountUsd: -totals.totalUsdEquivalent,
    paidUsd: totals.paidUsd,
    paidLbp: totals.paidLbp,
    exchangeRate: rate,
    note,
    userId,
  });

  return { entryId, amountUsd: totals.totalUsdEquivalent, ...totals };
}

/**
 * Whether a credit sale of `amountUsd` fits inside the customer's limit.
 * A limit of 0 means no credit is allowed at all; there is no "unlimited".
 */
export function creditCheck(customerId, amountUsd) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND active = 1').get(customerId);
  if (!customer) return { ok: false, error: 'Customer not found' };

  const balance = balanceOf('customer', customerId);
  const projected = round2(balance + Number(amountUsd));

  if (projected > round2(customer.credit_limit)) {
    return {
      ok: false,
      error:
        `${customer.name} would owe ${projected.toFixed(2)} USD, over their ` +
        `${Number(customer.credit_limit).toFixed(2)} USD credit limit`,
      balance,
      projected,
    };
  }
  return { ok: true, customer, balance, projected };
}

/** Receivables, payables and the net position. */
export function accountsSummary() {
  const side = (partyType) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_usd), 0) AS total,
                COUNT(DISTINCT party_id) AS parties
         FROM account_entries WHERE party_type = ?`,
      )
      .get(partyType);

  const receivable = side('customer');
  const payable = side('supplier');

  const overdue = db
    .prepare(
      `SELECT c.id, c.name, c.credit_limit, COALESCE(SUM(e.amount_usd), 0) AS balance
       FROM customers c
       JOIN account_entries e ON e.party_id = c.id AND e.party_type = 'customer'
       WHERE c.active = 1
       GROUP BY c.id
       HAVING balance > 0
       ORDER BY balance DESC
       LIMIT 10`,
    )
    .all()
    .map((r) => ({ ...r, balance: round2(r.balance) }));

  return {
    receivable: round2(receivable.total),
    receivableParties: receivable.parties,
    payable: round2(payable.total),
    payableParties: payable.parties,
    net: round2(receivable.total - payable.total),
    topDebtors: overdue,
  };
}

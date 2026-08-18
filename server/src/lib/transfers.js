/**
 * The money transfer counter.
 *
 * Agency work — OMT, Whish, Western Union — running out of the same drawer as
 * the shop. It is not selling: nothing leaves the shelf, and the money handed
 * over is not the shop's. What the shop keeps is the fee.
 *
 * Which is exactly why it belongs here rather than in a notebook. Every one of
 * these moves cash in or out of the till, and a drawer counted at the end of a
 * day with thirty unrecorded transfers in it will never agree with anything.
 *
 * The sign convention is the operator's own view of the cash box:
 *
 *   send    the customer hands over the amount and the fee     → cash in
 *   payout  the shop counts out the amount, keeping any fee    → cash out
 *
 * so a transfer's effect on the drawer is one signed figure per currency, and
 * the day's takings are a sum rather than an exercise in interpretation.
 */
import { db, transaction } from '../db.js';
import { round2 } from './currency.js';
import { getSettings } from './settings.js';
import { currentSession, defaultAccountId, recordMovement, requiresSession } from './cash.js';
import { addEntry } from './accounts.js';
import { balanceEffect, companyByName, createCompany } from './transferCompanies.js';

export const TRANSFER_DIRECTIONS = ['send', 'payout'];

/**
 * The agents a Lebanese shop usually is. Free text as well, because the list
 * changes faster than a release does.
 */
export const TRANSFER_COMPANIES = ['OMT', 'Whish', 'Western Union', 'BOB Finance', 'CashUnited', 'Other'];

/** What a transfer does to the drawer, per currency. */
export function cashEffect({ direction, amountUsd = 0, amountLbp = 0, feeUsd = 0, feeLbp = 0 }) {
  if (direction === 'send') {
    return { usd: round2(amountUsd + feeUsd), lbp: Math.round(amountLbp + feeLbp) };
  }
  // A payout fee is kept out of the money counted across the counter, so the
  // drawer only loses the difference.
  return { usd: round2(feeUsd - amountUsd), lbp: Math.round(feeLbp - amountLbp) };
}

export function transferById(id) {
  return db
    .prepare(
      `SELECT t.*, u.name AS operator_name
       FROM transfers t LEFT JOIN users u ON u.id = t.operator_id
       WHERE t.id = ?`,
    )
    .get(id);
}

/**
 * Record one transfer and move the cash it caused.
 *
 * The cash movement is written in the same transaction as the transfer: a
 * transfer without its movement is a drawer that will not add up, and a
 * movement without its transfer is money nobody can explain.
 */
export function recordTransfer({
  reference = null,
  company,
  direction,
  customerName = null,
  customerPhone = null,
  customerIdNo = null,
  counterparty = null,
  destination = null,
  amountUsd = 0,
  amountLbp = 0,
  feeUsd = 0,
  feeLbp = 0,
  note = null,
  accountId = null,
  userId = null,
}) {
  if (!company || !String(company).trim()) throw new Error('Which company is this transfer with?');
  if (!TRANSFER_DIRECTIONS.includes(direction)) {
    throw new Error(`direction must be one of: ${TRANSFER_DIRECTIONS.join(', ')}`);
  }

  const amounts = {
    amountUsd: round2(Number(amountUsd) || 0),
    amountLbp: Math.round(Number(amountLbp) || 0),
    feeUsd: round2(Number(feeUsd) || 0),
    feeLbp: Math.round(Number(feeLbp) || 0),
  };

  if (Object.values(amounts).some((v) => v < 0)) {
    throw new Error('Amounts cannot be negative — a payout is a direction, not a minus sign');
  }
  if (amounts.amountUsd === 0 && amounts.amountLbp === 0) {
    throw new Error('Enter the amount being transferred');
  }

  /*
   * The money is physically counted, so there has to be an open drawer to count
   * it into or out of. Told afterwards, the operator has already handed it over.
   */
  if (requiresSession() && !currentSession(accountId)) {
    throw new Error('The cashbox is closed — open it before taking or paying out money');
  }

  const { exchange_rate: rate } = getSettings();
  const effect = cashEffect({ direction, ...amounts });

  return transaction(() => {
    /*
     * The agency is an account, and one gets opened the first time its name is
     * typed. Asking an operator to go and create OMT before they can record the
     * transfer a customer is standing there waiting for is not a trade-off
     * worth making — and the name is the same name either way.
     */
    const agency = companyByName(company) || createCompany({ name: company, userId });

    const info = db
      .prepare(
        `INSERT INTO transfers (
           reference, company, company_id, direction, customer_name, customer_phone, customer_id_no,
           counterparty, destination, amount_usd, amount_lbp, fee_usd, fee_lbp,
           exchange_rate, note, operator_id, account_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reference?.trim() || null,
        String(company).trim(),
        agency.id,
        direction,
        customerName?.trim() || null,
        customerPhone?.trim() || null,
        customerIdNo?.trim() || null,
        counterparty?.trim() || null,
        destination?.trim() || null,
        amounts.amountUsd,
        amounts.amountLbp,
        amounts.feeUsd,
        amounts.feeLbp,
        rate,
        note?.trim() || null,
        userId,
        accountId ?? defaultAccountId(),
      );

    const movementId = recordMovement({
      accountId,
      kind: 'transfer',
      amountUsd: effect.usd,
      amountLbp: effect.lbp,
      reason: direction,
      note: `${company} ${direction}${reference ? ` · ${reference}` : ''}`,
      userId,
    });

    if (movementId) {
      db.prepare('UPDATE transfers SET cash_movement_id = ? WHERE id = ?').run(
        movementId,
        info.lastInsertRowid,
      );
    }

    /*
     * And the agency's side of it. The drawer knows the cash moved; this is the
     * other half of the same fact — money the shop is holding for them, or has
     * laid out on their behalf. The fee is not in it: that is the shop's.
     */
    addEntry({
      partyType: 'transfer_company',
      partyId: agency.id,
      kind: direction === 'send' ? 'bill' : 'payment',
      amountUsd: balanceEffect({ direction, ...amounts, rate }),
      /*
       * And the same fact in the currencies it actually happened in. A send of
       * a million pounds leaves the shop owing a million pounds, not $11.24 —
       * which is what the agency's rider will ask for at the end of the day.
       */
      nativeUsd: (direction === 'send' ? 1 : -1) * (amounts.amountUsd || 0),
      nativeLbp: (direction === 'send' ? 1 : -1) * (amounts.amountLbp || 0),
      exchangeRate: rate,
      note: `${direction === 'send' ? 'Sent' : 'Paid out'}${reference ? ` · ${reference}` : ''}`,
      userId,
    });

    return transferById(info.lastInsertRowid);
  })();
}

/**
 * Undo one.
 *
 * Kept rather than deleted, and reversed with an opposite movement rather than
 * by removing the original: a drawer that was briefly wrong is part of what
 * happened, and a cancelled transfer somebody has to explain to the company is
 * exactly the row worth keeping.
 */
export function cancelTransfer(id, userId = null) {
  const transfer = transferById(id);
  if (!transfer) throw new Error('That transfer does not exist');
  if (transfer.status === 'cancelled') throw new Error('That transfer is already cancelled');

  const effect = cashEffect({
    direction: transfer.direction,
    amountUsd: transfer.amount_usd,
    amountLbp: transfer.amount_lbp,
    feeUsd: transfer.fee_usd,
    feeLbp: transfer.fee_lbp,
  });

  return transaction(() => {
    recordMovement({
      accountId: transfer.account_id,
      kind: 'transfer',
      amountUsd: -effect.usd,
      amountLbp: -effect.lbp,
      reason: 'cancelled',
      note: `Cancelled ${transfer.company} ${transfer.direction}${transfer.reference ? ` · ${transfer.reference}` : ''}`,
      userId,
    });

    // The agency's side comes back with it, or a cancelled transfer would sit
    // on their balance for ever as money the shop never actually moved.
    if (transfer.company_id) {
      addEntry({
        partyType: 'transfer_company',
        partyId: transfer.company_id,
        kind: 'adjustment',
        amountUsd: -balanceEffect({
          direction: transfer.direction,
          amountUsd: transfer.amount_usd,
          amountLbp: transfer.amount_lbp,
          rate: transfer.exchange_rate || 0,
        }),
        // Both piles come back too, or a cancelled transfer would leave pounds
        // on the agency's account that nobody ever sent.
        nativeUsd: -(transfer.direction === 'send' ? 1 : -1) * (transfer.amount_usd || 0),
        nativeLbp: -(transfer.direction === 'send' ? 1 : -1) * (transfer.amount_lbp || 0),
        exchangeRate: transfer.exchange_rate,
        note: `Cancelled${transfer.reference ? ` · ${transfer.reference}` : ''}`,
        userId,
      });
    }

    db.prepare("UPDATE transfers SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?").run(
      transfer.id,
    );
    return transferById(transfer.id);
  })();
}

/**
 * Named periods, so the counter is one tap rather than two dates.
 *
 * Qualified by table alias: `users` is joined in and has a `created_at` of its
 * own, so a bare column name would be ambiguous.
 */
export function rangeFor(preset, alias = 't') {
  const clauses = {
    today: `date(${alias}.created_at) = date('now')`,
    week: `date(${alias}.created_at) >= date('now', '-6 days')`,
    month: `strftime('%Y-%m', ${alias}.created_at) = strftime('%Y-%m', 'now')`,
  };
  return clauses[preset] || null;
}

export function listTransfers({ preset = 'today', search = '', operatorId = null, limit = 200 } = {}) {
  const where = ['1=1'];
  const params = [];

  const range = rangeFor(preset);
  if (range) where.push(range);

  if (search) {
    where.push('(t.reference LIKE ? OR t.customer_name LIKE ? OR t.customer_phone LIKE ? OR t.counterparty LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (operatorId) {
    where.push('t.operator_id = ?');
    params.push(operatorId);
  }

  return db
    .prepare(
      `SELECT t.*, u.name AS operator_name
       FROM transfers t LEFT JOIN users u ON u.id = t.operator_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT ?`,
    )
    .all(...params, Math.min(Number(limit) || 200, 500));
}

/**
 * The counter's own day: what came in, what went out, and what the shop kept.
 *
 * Cancelled rows are left out of the totals but stay in the list — they are
 * history, not takings.
 */
export function summarise(transfers) {
  const live = transfers.filter((t) => t.status === 'completed');
  const totals = {
    count: live.length,
    sends: live.filter((t) => t.direction === 'send').length,
    payouts: live.filter((t) => t.direction === 'payout').length,
    inUsd: 0,
    inLbp: 0,
    outUsd: 0,
    outLbp: 0,
    feeUsd: 0,
    feeLbp: 0,
  };

  for (const t of live) {
    if (t.direction === 'send') {
      totals.inUsd += t.amount_usd;
      totals.inLbp += t.amount_lbp;
    } else {
      totals.outUsd += t.amount_usd;
      totals.outLbp += t.amount_lbp;
    }
    totals.feeUsd += t.fee_usd;
    totals.feeLbp += t.fee_lbp;
  }

  return {
    ...totals,
    inUsd: round2(totals.inUsd),
    outUsd: round2(totals.outUsd),
    feeUsd: round2(totals.feeUsd),
    inLbp: Math.round(totals.inLbp),
    outLbp: Math.round(totals.outLbp),
    feeLbp: Math.round(totals.feeLbp),
  };
}

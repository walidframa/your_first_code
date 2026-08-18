/**
 * Money moving from one account to another.
 *
 * Everything that is neither a sale nor a purchase order: wages, rent, an owner
 * putting money in, a supplier settled in cash, a customer paying off what they
 * owe, credit bought for a wallet, a run to the safe. A shop that only records
 * selling ends the day with a drawer nobody can explain.
 *
 * A voucher names **both ends**. That is the whole idea: money never simply
 * appears or vanishes, it leaves one account and arrives at another, and until
 * both are written down somebody has to remember which drawer it came out of.
 *
 * Two kinds of account meet here:
 *
 *   the shop's own    a till, a wallet — a record of money that is actually there
 *   somebody else's   a customer, a supplier, a name typed in words
 *
 * Which makes the kind of voucher a consequence rather than a choice: out of
 * ours into theirs is a payment, the reverse is a receipt, and between two of
 * ours it is a transfer.
 */
import { db, transaction } from '../db.js';
import { round2 } from './currency.js';
import { getSettings } from './settings.js';
import { addEntry } from './accounts.js';
import { currentSession, recordMovement, requiresSession } from './cash.js';
import { recordMovement as recordWalletMovement } from './wallets.js';

export const VOUCHER_KINDS = ['payment', 'receipt', 'transfer'];
export const ACCOUNT_TYPES = ['cash', 'wallet', 'customer', 'supplier', 'transfer_company', 'other'];

/** The shop's own money, as opposed to a record of what somebody owes. */
export const OWN_TYPES = ['cash', 'wallet'];

/**
 * Why the money moved. Free text alone makes a month impossible to add up, and
 * "other" with a note covers whatever this list does not.
 */
export const VOUCHER_REASONS = [
  'supplier',
  'customer',
  'transfer_agency',
  'wages',
  'rent',
  'utilities',
  'owner_draw',
  'owner_funds',
  'refund',
  'deposit',
  'wallet_top_up',
  'bank_drop',
  'other',
];

const PARTY_TABLES = {
  customer: 'customers',
  supplier: 'suppliers',
  transfer_company: 'transfer_companies',
};

/** PV / RV / TV, sequential within its own series. */
export function nextVoucherNumber(kind) {
  const prefix = { payment: 'PV', receipt: 'RV', transfer: 'TV' }[kind];
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE kind = ?').get(kind);

  // Numbers stay unique even after a deletion, so step past any clash.
  const exists = db.prepare('SELECT 1 FROM vouchers WHERE voucher_number = ?');
  let seq = n + 1;
  let candidate = `${prefix}-${String(seq).padStart(4, '0')}`;
  while (exists.get(candidate)) {
    seq += 1;
    candidate = `${prefix}-${String(seq).padStart(4, '0')}`;
  }
  return candidate;
}

/** What kind of voucher two sides add up to. */
export function kindFor(fromType, toType) {
  const fromOurs = OWN_TYPES.includes(fromType);
  const toOurs = OWN_TYPES.includes(toType);
  if (fromOurs && toOurs) return 'transfer';
  if (fromOurs) return 'payment';
  if (toOurs) return 'receipt';
  return null;
}

/**
 * Resolve one end and give it a name.
 *
 * The name is copied rather than joined: a slip printed today must still read
 * the same after the contact is renamed or the till is put away.
 */
function resolveSide(type, id, typedName, what) {
  if (!ACCOUNT_TYPES.includes(type)) {
    throw new Error(`${what} must be one of: ${ACCOUNT_TYPES.join(', ')}`);
  }

  if (type === 'other') {
    const name = String(typedName || '').trim();
    if (!name) throw new Error(`Name ${what === 'from' ? 'who the money came from' : 'who it is going to'}`);
    return { type, id: null, name };
  }

  if (type === 'cash') {
    const till = db.prepare('SELECT * FROM cash_accounts WHERE id = ?').get(id);
    if (!till) throw new Error('That till does not exist');
    return { type, id: till.id, name: till.name, till };
  }

  if (type === 'wallet') {
    const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(id);
    if (!wallet) throw new Error('That wallet does not exist');
    return { type, id: wallet.id, name: wallet.name, wallet };
  }

  const party = db.prepare(`SELECT * FROM ${PARTY_TABLES[type]} WHERE id = ?`).get(id);
  if (!party) throw new Error(`That ${type.replace('_', ' ')} does not exist`);
  return { type, id: party.id, name: party.name };
}

/**
 * How a party's balance moves.
 *
 * A customer's balance is what they owe the shop; a supplier's is what the shop
 * owes them. So money *from* a customer reduces their debt while money from a
 * supplier increases what the shop owes — and each reverses when the money goes
 * the other way. `direction` is +1 when the account is the destination.
 */
export function partySign(type, direction) {
  if (type === 'customer') return direction;
  /*
   * A transfer agency runs the same way round as a supplier: the shop holding
   * their money owes them, and paying it over clears it. Which is exactly what
   * settling up at the end of a week is.
   */
  if (type === 'supplier' || type === 'transfer_company') return -direction;
  return 0;
}

/**
 * Apply one end of a voucher.
 *
 * `direction` is −1 for the side the money left and +1 for the side it reached,
 * so both ends run through the same code and cannot disagree about the sign.
 */
function applySide(side, direction, { usd, lbp, usdEquivalent, rate, number, note, userId }) {
  if (side.type === 'cash') {
    return {
      movementId: recordMovement({
        accountId: side.id,
        kind: 'voucher',
        amountUsd: round2(direction * usd),
        amountLbp: Math.round(direction * lbp),
        reason: direction > 0 ? 'in' : 'out',
        note: `${number}${note ? ` · ${note}` : ''}`,
        userId,
      }),
      entryId: null,
    };
  }

  if (side.type === 'wallet') {
    const amount =
      side.wallet.currency === 'USD' ? usdEquivalent : Math.round(usdEquivalent * (rate || 0));
    recordWalletMovement({
      walletId: side.id,
      kind: direction > 0 ? 'top_up' : 'withdrawal',
      amount: direction * amount,
      amountUsd: round2(direction * usdEquivalent),
      note: `${number}${note ? ` · ${note}` : ''}`,
      userId,
    });
    return { movementId: null, entryId: null };
  }

  const sign = partySign(side.type, direction);
  if (sign === 0) return { movementId: null, entryId: null };

  const entryId = addEntry({
    partyType: side.type,
    partyId: side.id,
    // Both directions are money moving against the account; which way is in
    // the sign, so one ledger kind serves both.
    kind: 'payment',
    amountUsd: sign * usdEquivalent,
    paidUsd: usd,
    paidLbp: lbp,
    // What was counted out, kept apart: settling with a transfer agency means
    // handing over dollars and pounds, and the account has to say how much of
    // each is still owed rather than one converted total.
    nativeUsd: sign * usd,
    nativeLbp: sign * lbp,
    exchangeRate: rate,
    note: `${number}${note ? ` · ${note}` : ''}`,
    userId,
  });
  return { movementId: null, entryId };
}

export function voucherById(id) {
  return db
    .prepare(
      `SELECT v.*, u.name AS user_name FROM vouchers v
       LEFT JOIN users u ON u.id = v.user_id WHERE v.id = ?`,
    )
    .get(id);
}

/**
 * Write one voucher and everything it causes.
 *
 * All inside one transaction: a voucher whose movement failed is a drawer that
 * will not count, and a movement with no voucher behind it is money nobody can
 * explain.
 */
export function recordVoucher({
  fromType,
  fromId = null,
  fromName = null,
  toType,
  toId = null,
  toName = null,
  amountUsd = 0,
  amountLbp = 0,
  reason = null,
  reference = null,
  note = null,
  issuedOn = null,
  userId = null,
}) {
  const usd = round2(Number(amountUsd) || 0);
  const lbp = Math.round(Number(amountLbp) || 0);
  if (usd < 0 || lbp < 0) {
    throw new Error('Amounts cannot be negative — the direction is the two accounts, not a minus sign');
  }
  if (usd === 0 && lbp === 0) throw new Error('Enter an amount');

  const from = resolveSide(fromType, fromId, fromName, 'from');
  const to = resolveSide(toType, toId, toName, 'to');

  if (from.type === to.type && from.id !== null && from.id === to.id) {
    throw new Error('The money has to go somewhere else');
  }

  const kind = kindFor(from.type, to.type);
  if (!kind) {
    throw new Error('One end has to be the shop — a till or a wallet');
  }

  /*
   * Cash needs a drawer to come out of or go into. Told afterwards, the money
   * has already been counted across the counter.
   */
  for (const side of [from, to]) {
    if (side.type === 'cash' && requiresSession() && !currentSession(side.id)) {
      throw new Error(`${side.name} is closed — open its cashbox first`);
    }
  }

  const { exchange_rate: rate } = getSettings();
  const usdEquivalent = round2(usd + (rate > 0 ? lbp / rate : 0));

  return transaction(() => {
    const number = nextVoucherNumber(kind);
    const info = db
      .prepare(
        `INSERT INTO vouchers (
           voucher_number, kind, from_type, from_id, from_name, to_type, to_id, to_name,
           amount_usd, amount_lbp, exchange_rate, reason, reference, note, user_id, issued_on
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, date('now')))`,
      )
      .run(
        number,
        kind,
        from.type,
        from.id,
        from.name,
        to.type,
        to.id,
        to.name,
        usd,
        lbp,
        rate,
        reason || null,
        reference?.trim() || null,
        note?.trim() || null,
        userId,
        issuedOn || null,
      );

    const voucherId = info.lastInsertRowid;
    const context = { usd, lbp, usdEquivalent, rate, number, note, userId };

    const out = applySide(from, -1, context);
    const arrived = applySide(to, 1, context);

    /*
     * One of each is kept on the row for traceability, and each has to be the
     * right kind of id — an entry column holding a cash movement's id would
     * point at whichever entry happened to share the number.
     *
     * A transfer between two tills has two movements and keeps the one it
     * arrived at, which is the end somebody is looking for when they ask where
     * the money went.
     */
    db.prepare('UPDATE vouchers SET cash_movement_id = ?, entry_id = ? WHERE id = ?').run(
      arrived.movementId ?? out.movementId ?? null,
      arrived.entryId ?? out.entryId ?? null,
      voucherId,
    );

    return voucherById(voucherId);
  })();
}

/**
 * The slip for money taken or paid on an invoice.
 *
 * An invoice settled at the counter moves the drawer and the party's ledger the
 * moment it is confirmed — but it did so silently, and an owner looking down
 * the vouchers for what came in today saw everything except the invoices, which
 * are usually the largest of it.
 *
 * So this writes the paper and nothing else. The movement and the entry already
 * exist; their ids are handed in and kept on the row, and no side is applied,
 * because applying one here would take the same money out of the drawer twice.
 *
 * Cash only, deliberately. A card payment never reaches a till, and inventing a
 * receipt against one would make the cashbox disagree with the money in it.
 */
export function recordDocumentVoucher({ doc, movementId = null, entryId = null, userId = null }) {
  const buying = doc.doc_type === 'purchase_invoice';
  const till = db.prepare('SELECT * FROM cash_accounts WHERE id = ?').get(
    db.prepare('SELECT account_id FROM cash_movements WHERE id = ?').get(movementId)?.account_id ?? null,
  );
  if (!till) return null;

  // Named from the table rather than from whatever the caller's row carried:
  // some callers hold the joined document and some only the raw one.
  const party = resolveSide(doc.party_type, doc.party_id, null, 'from');
  // Out of our till to a supplier is a payment; in from a customer, a receipt.
  const from = buying ? { type: 'cash', id: till.id, name: till.name } : party;
  const to = buying ? party : { type: 'cash', id: till.id, name: till.name };
  const kind = buying ? 'payment' : 'receipt';

  const number = nextVoucherNumber(kind);
  const info = db
    .prepare(
      `INSERT INTO vouchers (
         voucher_number, kind, from_type, from_id, from_name, to_type, to_id, to_name,
         amount_usd, amount_lbp, exchange_rate, reason, reference, note, user_id, issued_on,
         cash_movement_id, entry_id, document_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, date('now'), ?, ?, ?)`,
    )
    .run(
      number,
      kind,
      from.type,
      from.id,
      from.name,
      to.type,
      to.id,
      to.name,
      round2(doc.paid_usd || 0),
      Math.round(doc.paid_lbp || 0),
      doc.exchange_rate || null,
      buying ? 'supplier' : 'customer',
      doc.doc_number,
      `Paid on ${doc.doc_number}`,
      userId,
      movementId,
      entryId,
      doc.id,
    );

  return voucherById(info.lastInsertRowid);
}

/** Void every voucher an invoice wrote, without touching the money again. */
export function cancelDocumentVouchers(documentId) {
  db.prepare(
    `UPDATE vouchers SET status = 'cancelled', cancelled_at = datetime('now')
     WHERE document_id = ? AND status = 'posted'`,
  ).run(documentId);
}

/**
 * Void one.
 *
 * Reversed rather than deleted, and with opposite entries rather than by
 * removing the originals: a voucher already signed and handed over is part of
 * what happened, and its number must not be reused by the next one.
 */
export function cancelVoucher(id, userId = null) {
  const voucher = voucherById(id);
  if (!voucher) throw new Error('That voucher does not exist');
  if (voucher.status === 'cancelled') throw new Error('That voucher is already cancelled');
  /*
   * An invoice's receipt is a view of the invoice, not a movement of its own.
   * Cancelling it here would reverse money the invoice still says was paid, so
   * the correction has to be made where the payment was made.
   */
  if (voucher.document_id) {
    throw new Error(
      `${voucher.voucher_number} was written for ${voucher.reference || 'an invoice'} — cancel that invoice instead`,
    );
  }

  const rate = voucher.exchange_rate || getSettings().exchange_rate;
  const usdEquivalent = round2(voucher.amount_usd + (rate > 0 ? voucher.amount_lbp / rate : 0));

  const from = resolveSide(voucher.from_type, voucher.from_id, voucher.from_name, 'from');
  const to = resolveSide(voucher.to_type, voucher.to_id, voucher.to_name, 'to');

  const context = {
    usd: voucher.amount_usd,
    lbp: voucher.amount_lbp,
    usdEquivalent,
    rate,
    number: `Cancelled ${voucher.voucher_number}`,
    note: null,
    userId,
  };

  return transaction(() => {
    // Both ends, both signs flipped.
    applySide(from, 1, context);
    applySide(to, -1, context);

    db.prepare(
      "UPDATE vouchers SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?",
    ).run(voucher.id);

    return voucherById(voucher.id);
  })();
}

/** Named periods, qualified by alias — `users` has a `created_at` of its own. */
export function rangeFor(preset, alias = 'v') {
  const clauses = {
    today: `date(${alias}.created_at) = date('now')`,
    week: `date(${alias}.created_at) >= date('now', '-6 days')`,
    month: `strftime('%Y-%m', ${alias}.created_at) = strftime('%Y-%m', 'now')`,
  };
  return clauses[preset] || null;
}

export function listVouchers({ preset = 'month', kind = null, search = '', limit = 200 } = {}) {
  const where = ['1=1'];
  const params = [];

  const range = rangeFor(preset);
  if (range) where.push(range);
  if (VOUCHER_KINDS.includes(kind)) {
    where.push('v.kind = ?');
    params.push(kind);
  }
  if (search) {
    where.push(
      '(v.voucher_number LIKE ? OR v.from_name LIKE ? OR v.to_name LIKE ? OR v.note LIKE ? OR v.reference LIKE ?)',
    );
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  return db
    .prepare(
      `SELECT v.*, u.name AS user_name FROM vouchers v
       LEFT JOIN users u ON u.id = v.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY v.created_at DESC, v.id DESC
       LIMIT ?`,
    )
    .all(...params, Math.min(Number(limit) || 200, 500));
}

/**
 * Out, in, and the net.
 *
 * A transfer between two of the shop's own accounts is counted in neither: the
 * money did not leave, and showing it as both would double the day.
 */
export function summarise(vouchers) {
  const live = vouchers.filter((v) => v.status === 'posted');
  const totals = {
    payments: 0,
    receipts: 0,
    transfers: 0,
    paidUsd: 0,
    paidLbp: 0,
    receivedUsd: 0,
    receivedLbp: 0,
  };

  for (const v of live) {
    if (v.kind === 'payment') {
      totals.payments += 1;
      totals.paidUsd += v.amount_usd;
      totals.paidLbp += v.amount_lbp;
    } else if (v.kind === 'receipt') {
      totals.receipts += 1;
      totals.receivedUsd += v.amount_usd;
      totals.receivedLbp += v.amount_lbp;
    } else {
      totals.transfers += 1;
    }
  }

  return {
    ...totals,
    paidUsd: round2(totals.paidUsd),
    paidLbp: Math.round(totals.paidLbp),
    receivedUsd: round2(totals.receivedUsd),
    receivedLbp: Math.round(totals.receivedLbp),
    netUsd: round2(totals.receivedUsd - totals.paidUsd),
    netLbp: Math.round(totals.receivedLbp - totals.paidLbp),
  };
}

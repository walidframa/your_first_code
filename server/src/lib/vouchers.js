/**
 * Payment and receipt vouchers.
 *
 * Every movement of money that is neither a sale nor a purchase order: wages,
 * rent, the owner putting money in, a supplier settled in cash, a customer
 * paying off what they owe, credit bought for a wallet. A shop that only
 * records selling ends the day with a drawer nobody can explain.
 *
 * There are exactly two, and the difference is the direction:
 *
 *   payment   money leaves the shop and goes to the account named
 *   receipt   money comes into the shop from the account named
 *
 * Which side of the ledger that lands on depends on who the account is, and the
 * one rule below covers all four combinations. It is worth reading once:
 *
 *   A customer's balance is what they owe the shop. Paying them money makes
 *   them owe more; being paid makes them owe less.
 *   A supplier's balance is what the shop owes them. Paying them makes the
 *   shop owe less; being paid by them (a refund) makes the shop owe more.
 */
import { db, transaction } from '../db.js';
import { round2 } from './currency.js';
import { getSettings } from './settings.js';
import { addEntry } from './accounts.js';
import { currentSession, recordMovement, requiresSession } from './cash.js';
import { recordMovement as recordWalletMovement } from './wallets.js';

export const VOUCHER_KINDS = ['payment', 'receipt'];
export const ACCOUNT_TYPES = ['customer', 'supplier', 'wallet', 'other'];
export const VOUCHER_METHODS = ['cash', 'bank', 'card', 'other'];

/**
 * Why the money moved. Free text alone makes a month impossible to add up, and
 * "other" with a note covers whatever this list does not.
 */
export const PAYMENT_REASONS = [
  'supplier',
  'wages',
  'rent',
  'utilities',
  'owner_draw',
  'refund',
  'wallet_top_up',
  'other',
];

export const RECEIPT_REASONS = [
  'customer',
  'owner_funds',
  'deposit',
  'refund',
  'wallet_withdrawal',
  'other',
];

const PARTY_TABLES = { customer: 'customers', supplier: 'suppliers' };

/** PV-0001 for a payment, RV-0001 for a receipt. Sequential per kind. */
export function nextVoucherNumber(kind) {
  const prefix = kind === 'payment' ? 'PV' : 'RV';
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

/**
 * Which way the named account's balance moves, per the rule at the top.
 *
 * Positive always means "more outstanding" — the sign convention the ledger
 * already uses for both sides of the book.
 */
export function ledgerDirection(kind, accountType) {
  if (accountType !== 'customer' && accountType !== 'supplier') return 0;
  const outward = kind === 'payment' ? -1 : 1;
  return outward * (accountType === 'supplier' ? 1 : -1);
}

/** What a voucher does to the drawer: signed, per currency. Cash only. */
export function cashEffect({ kind, method, amountUsd = 0, amountLbp = 0 }) {
  if (method !== 'cash') return { usd: 0, lbp: 0 };
  const sign = kind === 'payment' ? -1 : 1;
  return { usd: round2(sign * amountUsd), lbp: Math.round(sign * amountLbp) };
}

export function voucherById(id) {
  return db
    .prepare(
      `SELECT v.*, u.name AS user_name FROM vouchers v
       LEFT JOIN users u ON u.id = v.user_id WHERE v.id = ?`,
    )
    .get(id);
}

/** Resolve and name the account, so the slip cannot be orphaned by a rename. */
function resolveAccount(accountType, accountId, typedName) {
  if (accountType === 'other') {
    const name = String(typedName || '').trim();
    if (!name) throw new Error('Name who the money is going to or coming from');
    return { id: null, name };
  }

  if (accountType === 'wallet') {
    const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(accountId);
    if (!wallet) throw new Error('That wallet does not exist');
    return { id: wallet.id, name: wallet.name, wallet };
  }

  const table = PARTY_TABLES[accountType];
  const party = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(accountId);
  if (!party) throw new Error(`That ${accountType} does not exist`);
  return { id: party.id, name: party.name };
}

/**
 * Write one voucher and everything it causes.
 *
 * All inside one transaction: a voucher whose cash movement failed is a drawer
 * that will not count, and a movement with no voucher behind it is money nobody
 * can explain.
 */
export function recordVoucher({
  kind,
  accountType,
  accountId = null,
  accountName = null,
  amountUsd = 0,
  amountLbp = 0,
  method = 'cash',
  reason = null,
  reference = null,
  note = null,
  issuedOn = null,
  userId = null,
}) {
  if (!VOUCHER_KINDS.includes(kind)) {
    throw new Error(`kind must be one of: ${VOUCHER_KINDS.join(', ')}`);
  }
  if (!ACCOUNT_TYPES.includes(accountType)) {
    throw new Error(`accountType must be one of: ${ACCOUNT_TYPES.join(', ')}`);
  }
  if (!VOUCHER_METHODS.includes(method)) {
    throw new Error(`method must be one of: ${VOUCHER_METHODS.join(', ')}`);
  }

  const usd = round2(Number(amountUsd) || 0);
  const lbp = Math.round(Number(amountLbp) || 0);
  if (usd < 0 || lbp < 0) {
    throw new Error('Amounts cannot be negative — the direction is the voucher, not a minus sign');
  }
  if (usd === 0 && lbp === 0) throw new Error('Enter an amount');

  const account = resolveAccount(accountType, accountId, accountName);

  /*
   * Cash needs a drawer to come out of or go into. A bank transfer does not,
   * so it is not blocked — refusing it would stop the shop recording something
   * that already happened.
   */
  if (method === 'cash' && requiresSession() && !currentSession()) {
    throw new Error('The cashbox is closed — open it before paying out or taking cash in');
  }

  const { exchange_rate: rate } = getSettings();
  const effect = cashEffect({ kind, method, amountUsd: usd, amountLbp: lbp });
  const usdEquivalent = round2(usd + (rate > 0 ? lbp / rate : 0));

  return transaction(() => {
    const number = nextVoucherNumber(kind);
    const info = db
      .prepare(
        `INSERT INTO vouchers (
           voucher_number, kind, account_type, account_id, account_name,
           amount_usd, amount_lbp, exchange_rate, method, reason, reference, note,
           user_id, issued_on
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, date('now')))`,
      )
      .run(
        number,
        kind,
        accountType,
        account.id,
        account.name,
        usd,
        lbp,
        rate,
        method,
        reason || null,
        reference?.trim() || null,
        note?.trim() || null,
        userId,
        issuedOn || null,
      );

    const voucherId = info.lastInsertRowid;

    const movementId = recordMovement({
      kind: 'voucher',
      amountUsd: effect.usd,
      amountLbp: effect.lbp,
      reason: kind,
      note: `${number} · ${account.name}`,
      userId,
    });

    /*
     * The party's ledger. `paid_usd` and `paid_lbp` record what actually
     * changed hands, so a statement shows the pounds as pounds rather than as
     * a converted figure that moves with the rate.
     */
    let entryId = null;
    const direction = ledgerDirection(kind, accountType);
    if (direction !== 0) {
      entryId = addEntry({
        partyType: accountType,
        partyId: account.id,
        // Both directions are money moving against the account; which way it
        // moved is already in the sign, so one ledger kind serves both.
        kind: 'payment',
        amountUsd: direction * usdEquivalent,
        paidUsd: usd,
        paidLbp: lbp,
        exchangeRate: rate,
        note: `${number}${note ? ` · ${note}` : ''}`,
        userId,
      });
    }

    // A wallet is credit, so paying money to one buys credit and being paid by
    // one is credit taken back out.
    if (accountType === 'wallet') {
      const walletAmount =
        account.wallet.currency === 'USD' ? usdEquivalent : Math.round(usdEquivalent * (rate || 0));
      recordWalletMovement({
        walletId: account.wallet.id,
        kind: kind === 'payment' ? 'top_up' : 'withdrawal',
        amount: kind === 'payment' ? walletAmount : -walletAmount,
        amountUsd: kind === 'payment' ? usdEquivalent : -usdEquivalent,
        note: `${number}${note ? ` · ${note}` : ''}`,
        userId,
      });
    }

    if (movementId || entryId) {
      db.prepare('UPDATE vouchers SET cash_movement_id = ?, entry_id = ? WHERE id = ?').run(
        movementId,
        entryId,
        voucherId,
      );
    }

    return voucherById(voucherId);
  })();
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

  const effect = cashEffect({
    kind: voucher.kind,
    method: voucher.method,
    amountUsd: voucher.amount_usd,
    amountLbp: voucher.amount_lbp,
  });

  const rate = voucher.exchange_rate || getSettings().exchange_rate;
  const usdEquivalent = round2(voucher.amount_usd + (rate > 0 ? voucher.amount_lbp / rate : 0));

  return transaction(() => {
    recordMovement({
      kind: 'voucher',
      amountUsd: -effect.usd,
      amountLbp: -effect.lbp,
      reason: 'cancelled',
      note: `Cancelled ${voucher.voucher_number}`,
      userId,
    });

    const direction = ledgerDirection(voucher.kind, voucher.account_type);
    if (direction !== 0) {
      addEntry({
        partyType: voucher.account_type,
        partyId: voucher.account_id,
        kind: 'adjustment',
        amountUsd: -direction * usdEquivalent,
        exchangeRate: rate,
        note: `Cancelled ${voucher.voucher_number}`,
        userId,
      });
    }

    if (voucher.account_type === 'wallet') {
      const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(voucher.account_id);
      if (wallet) {
        const walletAmount =
          wallet.currency === 'USD' ? usdEquivalent : Math.round(usdEquivalent * (rate || 0));
        recordWalletMovement({
          walletId: wallet.id,
          kind: 'adjustment',
          amount: voucher.kind === 'payment' ? -walletAmount : walletAmount,
          amountUsd: voucher.kind === 'payment' ? -usdEquivalent : usdEquivalent,
          note: `Cancelled ${voucher.voucher_number}`,
          userId,
        });
      }
    }

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
    where.push('(v.voucher_number LIKE ? OR v.account_name LIKE ? OR v.note LIKE ? OR v.reference LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
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

/** Paid out, taken in, and the net — cancelled rows excluded from all three. */
export function summarise(vouchers) {
  const live = vouchers.filter((v) => v.status === 'posted');
  const totals = { paidUsd: 0, paidLbp: 0, receivedUsd: 0, receivedLbp: 0, payments: 0, receipts: 0 };

  for (const v of live) {
    if (v.kind === 'payment') {
      totals.payments += 1;
      totals.paidUsd += v.amount_usd;
      totals.paidLbp += v.amount_lbp;
    } else {
      totals.receipts += 1;
      totals.receivedUsd += v.amount_usd;
      totals.receivedLbp += v.amount_lbp;
    }
  }

  return {
    payments: totals.payments,
    receipts: totals.receipts,
    paidUsd: round2(totals.paidUsd),
    paidLbp: Math.round(totals.paidLbp),
    receivedUsd: round2(totals.receivedUsd),
    receivedLbp: Math.round(totals.receivedLbp),
    netUsd: round2(totals.receivedUsd - totals.paidUsd),
    netLbp: Math.round(totals.receivedLbp - totals.paidLbp),
  };
}

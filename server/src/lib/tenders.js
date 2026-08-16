/**
 * How a sale was paid for, when it took more than one thing.
 *
 * A Lebanese counter settles in pieces: some dollars, some pounds, a card, a
 * Whish transfer, and whatever is left on the customer's account until Friday.
 * The app used to record one method per sale, so a cashier had to pick the
 * biggest piece and the rest was never written down — and a customer who was
 * short had to be rung up twice or turned away.
 *
 * A tender is one of those pieces:
 *
 *     { method: 'cash',    amountUsd: 20, amountLbp: 500000 }
 *     { method: 'card',    amountUsd: 30, label: 'Whish' }
 *     { method: 'account', amountUsd: 15 }
 *
 * Three methods and no more, because they are the three things that actually
 * happen to money: it goes in the drawer, it arrives electronically, or it does
 * not arrive yet. Whish, OMT and Visa are all the middle one — the shop is not
 * holding the notes and is not owed by the customer — and `label` says which,
 * so a shop that wants to know how much came through which app can be told.
 */
import { db } from '../db.js';
import { round2 } from './currency.js';

export const TENDER_METHODS = ['cash', 'card', 'account'];

/**
 * Read a payment list into something that can be checked and applied.
 *
 * Throws with a message meant for whoever is standing at the till. Amounts are
 * per tender and in both currencies, because a customer handing over a fifty
 * and two hundred thousand pounds is one payment, not two.
 */
export function readTenders(tenders, rate) {
  if (!Array.isArray(tenders) || tenders.length === 0) return null;

  const lines = [];
  for (const raw of tenders) {
    const method = String(raw?.method || '').trim();
    if (!TENDER_METHODS.includes(method)) {
      throw new Error(`A payment must be one of: ${TENDER_METHODS.join(', ')}`);
    }

    const usd = round2(Number(raw.amountUsd) || 0);
    const lbp = Math.round(Number(raw.amountLbp) || 0);
    if (usd < 0 || lbp < 0) {
      throw new Error('A payment cannot be negative — money going back is a refund');
    }
    if (usd === 0 && lbp === 0) continue;

    lines.push({
      method,
      amountUsd: usd,
      amountLbp: lbp,
      // Only worth keeping on the electronic ones; "cash · cash" reads as noise.
      label: method === 'card' ? String(raw.label || '').trim() || null : null,
      /*
       * What this piece is worth in dollars, at the rate the sale was priced
       * at. Stored nowhere — it is a working figure for the arithmetic below,
       * and recomputing it later from a moved rate would change history.
       */
      usdEquivalent: round2(usd + (rate > 0 ? lbp / rate : 0)),
    });
  }

  return lines.length > 0 ? lines : null;
}

/** What each kind of tender came to, in dollars. */
export function tenderSplit(lines) {
  const by = (method) =>
    round2(lines.filter((l) => l.method === method).reduce((sum, l) => sum + l.usdEquivalent, 0));

  const cash = lines.filter((l) => l.method === 'cash');
  return {
    cash: by('cash'),
    card: by('card'),
    account: by('account'),
    total: round2(lines.reduce((sum, l) => sum + l.usdEquivalent, 0)),
    /* The drawer moves in the currencies it was actually handed, never in a
       converted figure — the notes in it are dollars and pounds, not an
       average of the two. */
    cashUsd: round2(cash.reduce((sum, l) => sum + l.amountUsd, 0)),
    cashLbp: Math.round(cash.reduce((sum, l) => sum + l.amountLbp, 0)),
  };
}

/**
 * Which single method a split is best described as.
 *
 * `orders.payment_method` is one column and every report and receipt written
 * before splits existed reads it, so it keeps holding the main way the sale was
 * paid. Cash wins when there is any, because that is the half somebody counting
 * a drawer is looking for; an account remainder is only the answer when nothing
 * was handed over at all.
 */
export function dominantMethod(split) {
  if (split.cash > 0) return 'cash';
  if (split.card > 0) return 'card';
  return 'account';
}

export function recordTenders(orderId, lines) {
  const insert = db.prepare(
    `INSERT INTO order_payments (order_id, method, amount_usd, amount_lbp, label)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const l of lines) {
    insert.run(orderId, l.method, l.amountUsd, l.amountLbp, l.label);
  }
}

export function tendersFor(orderId) {
  return db
    .prepare('SELECT * FROM order_payments WHERE order_id = ? ORDER BY id')
    .all(orderId);
}

/**
 * Dual-currency helpers.
 *
 * USD is the base: products are priced in USD and every total is computed in
 * USD. LBP is always derived from the current exchange rate, so there is only
 * ever one number to keep up to date and the two price lists cannot drift.
 *
 * LBP amounts are rounded to a configurable step (banknotes are large, so
 * quoting to the pound is meaningless — 1,000 LBP is a sensible default).
 */

export const CURRENCIES = ['USD', 'LBP'];

/**
 * How change can be given back. `SPLIT` is not a currency — it is some dollars
 * and the rest in pounds, which is how a till with a thinning stack of notes
 * actually settles up.
 */
export const CHANGE_MODES = [...CURRENCIES, 'SPLIT'];

/** Round a USD amount to cents. */
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Round an LBP amount to the nearest `step` pounds (step <= 1 disables it). */
export function roundLbp(amount, step = 1000) {
  const value = Number(amount) || 0;
  const s = Number(step);
  if (!Number.isFinite(s) || s <= 1) return Math.round(value);
  return Math.round(value / s) * s;
}

/** Convert USD to LBP at `rate`, rounded to the display step. */
export function usdToLbp(usd, rate, step = 1000) {
  return roundLbp((Number(usd) || 0) * Number(rate), step);
}

/** Convert LBP to its USD equivalent (unrounded beyond cents). */
export function lbpToUsd(lbp, rate) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return 0;
  return round2((Number(lbp) || 0) / r);
}

/**
 * Total what the customer handed over, expressed in USD.
 *
 * `payments` is a list of { currency, amount }. LBP legs are converted at
 * `rate`. Returns the USD-equivalent total plus the per-currency sums, so the
 * order can record exactly which notes crossed the counter.
 */
export function tenderTotals(payments, rate) {
  let usd = 0;
  let lbp = 0;

  for (const payment of payments) {
    const amount = Number(payment.amount) || 0;
    if (payment.currency === 'USD') usd += amount;
    else lbp += amount;
  }

  // Divide the LBP total once rather than per leg, so rounding does not compound.
  const lbpAsUsd = Number(rate) > 0 ? lbp / Number(rate) : 0;

  return {
    paidUsd: round2(usd),
    paidLbp: Math.round(lbp),
    totalUsdEquivalent: round2(usd + lbpAsUsd),
  };
}

/**
 * What a pile of dollars and a pile of pounds are worth together, in USD.
 *
 * The only place the two currencies are ever added up. Everywhere the money is
 * counted — the drawer, the Z-report — they stay apart, because a drawer is
 * right or wrong in each currency on its own. But change handed across the
 * counter is a single debt settled with two kinds of note, so here they sum.
 */
export function combinedUsd(usd, lbp, rate) {
  const r = Number(rate);
  return round2((Number(usd) || 0) + (r > 0 ? (Number(lbp) || 0) / r : 0));
}

/**
 * Split change: hand back some dollars and some pounds, together worth what is
 * owed.
 *
 * A till rarely holds enough of either note to give change cleanly in one
 * currency — the dollars run out before the day does. The cashier names both
 * piles, because which notes are actually in the drawer is something only they
 * can see: 2,500,000 LL may be four notes while the exact remainder is seven.
 *
 * Naming only the dollars still works: leave `lbpPart` out and the rest of the
 * change converts, rounded to a note the shop can really give. That is the
 * common case and stays one number to type.
 *
 * Neither pile is capped against what is owed. Rounding to a giveable note
 * means the two halves rarely land on the exact figure, and the cashier is the
 * one who decides which way to round. The order records what actually crossed
 * the counter, so the difference shows up in the drawer at close instead of
 * being hidden in the arithmetic.
 */
export function splitChange(changeUsdEquivalent, rate, step = 1000, usdPart = null, lbpPart = null) {
  const due = Math.max(0, Number(changeUsdEquivalent) || 0);
  const dollars = Math.max(0, round2(Number(usdPart) || 0));

  if (lbpPart === null || lbpPart === undefined) {
    const capped = Math.min(dollars, due);
    return { changeUsd: capped, changeLbp: usdToLbp(round2(due - capped), rate, step) };
  }

  return { changeUsd: dollars, changeLbp: Math.max(0, Math.round(Number(lbpPart) || 0)) };
}

/**
 * Work out change for `changeUsdEquivalent`, given back in `currency` — one of
 * `CHANGE_MODES`. `USD` and `LBP` put the whole amount in that currency and
 * leave the other field zero; `SPLIT` hands back both, see `splitChange`.
 */
export function changeBreakdown(
  changeUsdEquivalent,
  currency,
  rate,
  step = 1000,
  usdPart = null,
  lbpPart = null,
) {
  const due = Math.max(0, Number(changeUsdEquivalent) || 0);

  if (currency === 'SPLIT') return splitChange(due, rate, step, usdPart, lbpPart);

  if (currency === 'LBP') {
    return { changeUsd: 0, changeLbp: usdToLbp(due, rate, step) };
  }
  return { changeUsd: round2(due), changeLbp: 0 };
}

/** Validate a tender list, returning an error message or null. */
export function validatePayments(payments) {
  if (!Array.isArray(payments) || payments.length === 0) {
    return 'At least one payment is required';
  }
  for (const payment of payments) {
    if (!CURRENCIES.includes(payment?.currency)) {
      return `Payment currency must be one of: ${CURRENCIES.join(', ')}`;
    }
    const amount = Number(payment.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return 'Payment amounts must be non-negative numbers';
    }
  }
  if (payments.every((p) => (Number(p.amount) || 0) === 0)) {
    return 'At least one payment must be greater than zero';
  }
  return null;
}

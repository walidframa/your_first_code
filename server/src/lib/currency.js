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
 * Work out change for `changeUsdEquivalent`, given back in `currency`.
 * The other currency's field is zero — change is never split.
 */
export function changeBreakdown(changeUsdEquivalent, currency, rate, step = 1000) {
  const due = Math.max(0, Number(changeUsdEquivalent) || 0);
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

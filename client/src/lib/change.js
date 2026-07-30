/**
 * Split-change arithmetic.
 *
 * Kept out of the payment sheet so the one rule that is easy to get wrong —
 * how close counts as exact — can be tested on its own.
 */

/** What a pile of dollars and a pile of pounds come to together, in USD. */
export function combinedUsd(usd, lbp, rate) {
  const r = Number(rate);
  return (Number(usd) || 0) + (r > 0 ? (Number(lbp) || 0) / r : 0);
}

/**
 * How the two piles the cashier named stand against the change owed.
 *
 * `exact` has to be as wide as half the smallest note the shop can give.
 * Change of $3.50 at 89,000 is 311,500 LL, and a drawer holding 1,000 LL notes
 * pays 312,000 — half a cent over, unavoidably. A tighter tolerance would let
 * the sheet fill the pounds itself and then flag its own figure as wrong.
 *
 * `over` is the separate question of whether this is a slipped digit rather
 * than a rounding. It allows a whole rounding step, matching what the server
 * accepts, so the button never enables a request the API will refuse.
 */
export function splitStatus({ changeDue, usd, lbp, rate, step = 1000 }) {
  const due = Math.max(0, Number(changeDue) || 0);
  const dollars = Math.max(0, Number(usd) || 0);
  const pounds = Math.max(0, Number(lbp) || 0);

  const total = combinedUsd(dollars, pounds, rate);
  const slack = rate > 0 ? step / 2 / rate + 1e-6 : 0.005;
  const diff = due - total;
  const left = Math.abs(diff) <= slack ? 0 : diff;

  const overBy = rate > 0 ? step / rate + 0.01 : 0.01;

  return {
    usd: dollars,
    lbp: pounds,
    total,
    left,
    exact: left === 0,
    over: -diff > overBy,
  };
}

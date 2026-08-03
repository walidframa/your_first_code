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

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Round pounds to a note the drawer can actually pay out. */
function toNote(lbp, step) {
  const s = Number(step);
  return !Number.isFinite(s) || s <= 1 ? Math.round(lbp) : Math.round(lbp / s) * s;
}

/**
 * Fill in whichever pile the cashier has not named.
 *
 * The counter conversation is one-sided: "your change is $29.13 — here's $25,
 * and the rest in pounds." The cashier knows the note they are pulling out;
 * working out what is left is arithmetic, and arithmetic is the till's job.
 *
 * So the untouched field follows the touched one. Type dollars and the pounds
 * come to meet them; type pounds instead and the dollars do. Touch both and
 * neither is suggested any more — two deliberate figures are the cashier
 * rounding to the notes they hold, and the sheet reports the difference rather
 * than overwriting either one.
 *
 * The dollar side is never capped at what is owed. Typing $50 back against
 * $29.13 of change should read as $20.87 over, not be quietly corrected.
 */
export function suggestSplit({ changeDue, usd, lbp, usdTouched, lbpTouched, rate, step = 1000 }) {
  const due = Math.max(0, Number(changeDue) || 0);
  const typedUsd = Math.max(0, Number(usd) || 0);
  const typedLbp = Math.max(0, Number(lbp) || 0);
  const r = Number(rate) > 0 ? Number(rate) : 0;

  if (!lbpTouched) {
    const rest = Math.max(0, due - typedUsd);
    return { usd: typedUsd, lbp: r ? toNote(rest * r, step) : 0, suggested: 'lbp' };
  }

  if (!usdTouched) {
    const rest = Math.max(0, due - (r ? typedLbp / r : 0));
    return { usd: round2(rest), lbp: typedLbp, suggested: 'usd' };
  }

  return { usd: typedUsd, lbp: typedLbp, suggested: null };
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

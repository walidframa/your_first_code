/**
 * Counting a till against what the app thinks is in it.
 *
 * Kept out of the dialog because the one part that is easy to get wrong is the
 * combined figure: dollars and pounds are separate piles that are right or
 * wrong on their own, and adding them together is only meaningful through the
 * rate. Both readings matter — the per-currency ones are what get recorded, the
 * combined one is what a shopkeeper means by "am I short".
 */
import { combinedUsd } from './change.js';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * What the count comes to against the expected figure.
 *
 * Positive is over, negative is short, and `combined` is null when there is no
 * rate — with no rate the two piles simply cannot be added, and a zero would
 * read as "the drawer agrees".
 */
export function countDifference({ expected, counted, rate }) {
  if (!expected) return null;

  const usd = round2((Number(counted?.usd) || 0) - (Number(expected.usd) || 0));
  const lbp = Math.round((Number(counted?.lbp) || 0) - (Number(expected.lbp) || 0));

  const usable = Number(rate) > 0;
  return {
    usd,
    lbp,
    expectedCombined: usable ? round2(combinedUsd(expected.usd, expected.lbp, rate)) : null,
    countedCombined: usable ? round2(combinedUsd(counted?.usd, counted?.lbp, rate)) : null,
    combined: usable ? round2(combinedUsd(usd, lbp, rate)) : null,
  };
}

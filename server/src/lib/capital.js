/**
 * What the shop is worth, and how the months have moved it.
 *
 * A shopkeeper's own question, and it is not one the ledgers answer on their
 * own: "I put this much in. Am I ahead?"
 *
 * The figure starts where the owner says it starts — usually what the stock on
 * the shelves cost them, because for a shop that is what the money went into —
 * and then each month's **net profit** is added to it. Nothing else moves it.
 * That is the whole point: the rise from one month to the next is exactly what
 * the shop earned that month, so a good month looks like a good month.
 *
 * Two things it deliberately is not.
 *
 * It is not a live valuation. Buying stock does not raise it and paying a
 * supplier does not lower it, because neither made the shop any richer — the
 * money changed shape. A figure that moved every time a delivery arrived would
 * make a strong month look flat, which is the opposite of useful.
 *
 * And it is not the till. What is in the drawer this evening is a cashbox
 * question with its own screen.
 *
 * **Only finished months count.** The month you are standing in is still
 * happening; its profit is shown beside the total, clearly marked as not yet
 * counted, because adding it would mean the headline figure fell every time
 * somebody recorded an expense.
 */
import { db } from '../db.js';
import { round2 } from './currency.js';
import { getSettings } from './settings.js';
import { profitReport } from './profit.js';

/** The first day of the month `date` falls in, as YYYY-MM-01. */
const monthStart = (date) => `${String(date).slice(0, 7)}-01`;

/** The first day of the month after the one `ym` (YYYY-MM) names. */
function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** The last day of the month `ym` names. */
function monthEnd(ym) {
  const next = new Date(`${nextMonth(ym)}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}

/**
 * What the shelves cost.
 *
 * Offered when the opening figure is being set, because "what my stock cost me"
 * is what most shops mean by the money they have in the business — and adding
 * it up by hand across nine hundred products is how the figure ends up being a
 * guess.
 *
 * At the product's recorded cost rather than at an average of deliveries: this
 * is a starting point somebody is about to type over, not an accounting
 * position, and the recorded cost is the number they will recognise.
 */
export function stockAtCost() {
  const { value } = db
    .prepare(
      `SELECT COALESCE(SUM(p.cost * p.stock), 0) AS value
       FROM products p
       WHERE p.active = 1 AND p.stock > 0 AND p.wallet_id IS NULL`,
    )
    .get();
  return round2(value);
}

/** The months from `startYm` up to but not including the one `today` is in. */
function finishedMonths(startYm, today) {
  const out = [];
  const current = String(today).slice(0, 7);
  let ym = startYm;
  // Guarded rather than while(true): a settings row with a date in 1970 would
  // otherwise build six hundred months of report on every page load.
  for (let i = 0; i < 240 && ym < current; i += 1) {
    out.push(ym);
    ym = nextMonth(ym).slice(0, 7);
  }
  return out;
}

/**
 * The opening figure and every month since, with the running total.
 *
 * `today` is a parameter so the arithmetic can be tested without waiting for a
 * calendar month to pass.
 */
export function capitalHistory({ today = new Date().toISOString().slice(0, 10), branchId = null } = {}) {
  const settings = getSettings();
  const opening = Number(settings.capital_opening) || 0;
  const openedOn = settings.capital_opening_date
    ? monthStart(settings.capital_opening_date)
    : null;

  if (!openedOn) {
    return { set: false, opening: 0, openedOn: null, months: [], capital: 0, thisMonth: null };
  }

  let running = round2(opening);
  const months = finishedMonths(openedOn.slice(0, 7), today).map((ym) => {
    const report = profitReport({ from: `${ym}-01`, to: monthEnd(ym), branchId });
    running = round2(running + report.netProfit);
    return {
      month: ym,
      revenue: report.revenue,
      grossProfit: report.grossProfit,
      expenses: report.expenses.total,
      netProfit: report.netProfit,
      capital: running,
    };
  });

  /*
   * The month in hand, kept out of the total on purpose. Counting it would
   * make the headline fall every time somebody wrote down an expense, which is
   * the one thing that would stop anybody trusting it.
   */
  const currentYm = String(today).slice(0, 7);
  const inProgress =
    currentYm >= openedOn.slice(0, 7)
      ? profitReport({ from: `${currentYm}-01`, to: today, branchId })
      : null;

  return {
    set: true,
    opening: round2(opening),
    openedOn,
    months,
    capital: running,
    thisMonth: inProgress
      ? {
          month: currentYm,
          revenue: inProgress.revenue,
          netProfit: inProgress.netProfit,
          // What it would stand at if the month ended today.
          wouldBe: round2(running + inProgress.netProfit),
        }
      : null,
  };
}

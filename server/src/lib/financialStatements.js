/**
 * The two statements a shop is actually asked for.
 *
 * The books already produced a trial balance, which is a working paper: it
 * proves the ledger adds up and tells a bookkeeper nothing is lost. It is not
 * what anybody outside the shop wants. An accountant, a bank, a partner and the
 * tax office all ask the same two questions — what did it earn over a period,
 * and what does it own and owe on a date — and until now the answer was a
 * hundred-row list of account balances and an invitation to add them up.
 *
 * Both are read straight off the posted journal. Nothing here stores a figure,
 * so a statement cannot drift from the ledger it came from, and running one for
 * last March next year gives the same answer it gave last April.
 */
import { db } from '../db.js';
import { round2 } from './currency.js';
import { signedBalance } from './ledger.js';

/**
 * Cost of sales, as distinct from the cost of being open.
 *
 * Read from the account's code rather than a flag: 5100 is Cost of goods sold
 * in the chart this app seeds, and a shop that adds its own — 5110 freight in,
 * 5120 customs — files them under it. Everything else in the fifties is what
 * the shop spends to keep the door open, which is the line gross profit is
 * drawn above.
 *
 * A shop that has renamed or removed 5100 still gets a correct statement: cost
 * of sales is nil, gross profit equals revenue, and every expense sits in
 * operating. Less informative, never wrong.
 */
const COST_OF_SALES = /^51/;

/** Posted lines only, optionally one branch's, between two dates. */
function balances({ types, from = null, to = null, branchId = null }) {
  const marks = types.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT a.id, a.code, a.name, a.type,
              COALESCE(SUM(l.debit_usd), 0) AS debit,
              COALESCE(SUM(l.credit_usd), 0) AS credit
       FROM gl_accounts a
       JOIN journal_lines l ON l.account_id = a.id
       JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
       WHERE a.type IN (${marks})
         AND (? IS NULL OR e.entry_date >= ?)
         AND (? IS NULL OR e.entry_date <= ?)
         AND (? IS NULL OR e.branch_id = ?)
         /* A heading holds nothing of its own; its children carry the money,
            and adding both would count every figure twice. */
         AND a.is_group = 0
       GROUP BY a.id
       ORDER BY a.code`,
    )
    .all(...types, from, from, to, to, branchId, branchId)
    .map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      amount: signedBalance(r.type, round2(r.debit), round2(r.credit)),
    }))
    .filter((r) => r.amount !== 0);
}

const total = (rows) => round2(rows.reduce((sum, r) => sum + r.amount, 0));

/**
 * What the shop earned over a period.
 *
 * Gross profit is revenue less what the goods cost; operating profit is that
 * less the cost of being open. Both lines are given rather than only the last
 * one, because a shop whose profit fell wants to know which of the two moved —
 * and they are fixed by completely different decisions.
 */
export function incomeStatement({ from = null, to = null, branchId = null } = {}) {
  const rows = balances({ types: ['income', 'expense'], from, to, branchId });

  const revenue = rows.filter((r) => r.type === 'income');
  const costOfSales = rows.filter((r) => r.type === 'expense' && COST_OF_SALES.test(r.code));
  const operating = rows.filter((r) => r.type === 'expense' && !COST_OF_SALES.test(r.code));

  const revenueTotal = total(revenue);
  const costTotal = total(costOfSales);
  const operatingTotal = total(operating);
  const grossProfit = round2(revenueTotal - costTotal);

  return {
    from,
    to,
    revenue,
    costOfSales,
    operating,
    totals: {
      revenue: revenueTotal,
      costOfSales: costTotal,
      grossProfit,
      /* Nil revenue is a shop that did not trade, not a shop with no margin —
         a percentage of nothing is a number that means nothing. */
      grossMargin: revenueTotal === 0 ? null : round2((grossProfit / revenueTotal) * 100),
      operating: operatingTotal,
      netProfit: round2(grossProfit - operatingTotal),
    },
  };
}

/**
 * What the shop owns and owes on a date.
 *
 * The part that is easy to get wrong: **the profit since the last closing has
 * to appear inside equity, or the statement does not balance.** Closing is what
 * empties the income and expense accounts into retained earnings, and between
 * one closing and the next their balances are the shop's earnings sitting
 * outside the equity accounts. A balance sheet drawn without them is out by
 * exactly the profit — which reads as a bookkeeping error and is not one.
 *
 * So it is stated as its own line, `Profit since the last closing`, rather than
 * quietly folded into retained earnings: it is the figure that has not been
 * closed yet, and saying so is the difference between a statement somebody can
 * check and one they have to trust.
 */
export function balanceSheet({ asAt = null, branchId = null } = {}) {
  const assets = balances({ types: ['asset'], to: asAt, branchId });
  const liabilities = balances({ types: ['liability'], to: asAt, branchId });
  const equity = balances({ types: ['equity'], to: asAt, branchId });
  const earned = balances({ types: ['income', 'expense'], to: asAt, branchId });

  const income = round2(earned.filter((r) => r.type === 'income').reduce((s, r) => s + r.amount, 0));
  const expense = round2(
    earned.filter((r) => r.type === 'expense').reduce((s, r) => s + r.amount, 0),
  );
  const result = round2(income - expense);

  const assetTotal = total(assets);
  const equityTotal = round2(total(equity) + result);
  const fundedBy = round2(total(liabilities) + equityTotal);

  return {
    asAt,
    assets,
    liabilities,
    equity,
    result,
    totals: {
      assets: assetTotal,
      liabilities: total(liabilities),
      equity: equityTotal,
      fundedBy,
      /*
       * Stated, not assumed. Double entry makes this true by construction, so
       * a false here is the books being wrong rather than the statement — and
       * a shop is better off seeing that on the page than not being told.
       */
      difference: round2(assetTotal - fundedBy),
    },
    balanced: round2(assetTotal - fundedBy) === 0,
  };
}

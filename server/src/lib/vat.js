/**
 * The VAT return.
 *
 * Two figures and their difference: what the shop **charged** on what it sold,
 * less what it **paid** on what it bought. The rest is showing the working.
 *
 * Read out of the ledger rather than recomputed from orders and documents, and
 * that is the whole reason the books had to come first. A return worked out by
 * adding up sales again is a second derivation of the same period, and when it
 * disagrees with the accounts — which it will, the first time somebody voids a
 * sale or writes a correction by hand — there is no way to tell which of the
 * two is right. Off the ledger, there is only one answer and it is the same
 * one the trial balance gives.
 *
 * ## What it deliberately does not do
 *
 * It does not file anything, and it does not decide what is taxable. This
 * shows a shop what its own books say it owes, so that a person can check it
 * and act. A POS that quietly decided a shop's tax position would be a POS
 * making a claim it cannot stand behind.
 */
import { db } from '../db.js';
import { round2 } from './currency.js';
import { getSettings, taxRate } from './settings.js';

/** Movements on one account over a period, both columns. */
function movement(code, { from = null, to = null } = {}) {
  /* Defaulted here rather than at every call: SQLite cannot bind `undefined`,
     and "the whole of time" is a perfectly good period to ask about. */
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_usd), 0) AS debit, COALESCE(SUM(l.credit_usd), 0) AS credit
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
       JOIN gl_accounts a ON a.id = l.account_id
       WHERE a.code = ?
         AND (? IS NULL OR e.entry_date >= ?) AND (? IS NULL OR e.entry_date <= ?)`,
    )
    .get(code, from, from, to, to);
  return { debit: round2(row.debit), credit: round2(row.credit) };
}

/**
 * The return for a period.
 *
 * `from` and `to` are dates, not a quarter number, because what a period is
 * differs by country and by shop and this app has no business deciding it. The
 * screen offers the usual ones; the figures come from whatever two dates it is
 * given.
 */
export function vatReturn({ from = null, to = null } = {}) {
  const settings = getSettings();

  const charged = movement('2200', { from, to });
  const paid = movement('1250', { from, to });

  /*
   * Both directions on each account, not just the one that usually moves. A
   * credit note reverses tax that was charged, and a purchase returned reverses
   * tax that was paid — a return that only counted the usual direction would
   * overstate what is owed by exactly the corrections the shop made.
   */
  const output = round2(charged.credit - charged.debit);
  const input = round2(paid.debit - paid.credit);
  const due = round2(output - input);

  // What those figures were charged on, so the return can be checked rather
  // than only believed.
  const sales = movement('4100', { from, to });
  const netSales = round2(sales.credit - sales.debit);

  return {
    from,
    to,
    rate: taxRate(settings) * 100,
    taxName: settings.tax_name || 'Tax',
    enabled: String(settings.tax_enabled) === 'true',
    /** Charged on sales, and held for somebody else. */
    output,
    /** Paid on purchases, and reclaimable against the above. */
    input,
    /** Positive: the shop owes it. Negative: the shop is owed it. */
    due,
    netSales,
    /*
     * What is standing on the two accounts right now, regardless of period.
     *
     * Different from the period figures and worth showing beside them: a shop
     * that has never settled a return has a payable holding every quarter it
     * has ever traded, and seeing only this quarter's figure would let it think
     * it owed a tenth of what it does.
     */
    standing: {
      output: round2(movement('2200', {}).credit - movement('2200', {}).debit),
      input: round2(movement('1250', {}).debit - movement('1250', {}).credit),
    },
  };
}

/**
 * The entry that settles it.
 *
 * Both accounts are cleared to nothing for the period and the difference is
 * paid or reclaimed — which is what settling a return *is*, and why it has to
 * be a real entry rather than a note on a screen. A shop that pays its VAT and
 * leaves the payable standing will see the same money owed again next quarter.
 *
 * The lines are built from the period's own figures, so settling twice cannot
 * silently double the payment: the second one finds nothing left to clear.
 */
export function settlementLines({ from = null, to = null } = {}) {
  const { output, input, due } = vatReturn({ from, to });
  if (output === 0 && input === 0) return null;

  return {
    output,
    input,
    due,
    /* Positive due means paying it out; negative means claiming it back. */
    lines: [
      ...(output !== 0 ? [{ code: '2200', debit: output, credit: 0, memo: 'Tax charged, cleared' }] : []),
      ...(input !== 0 ? [{ code: '1250', debit: 0, credit: input, memo: 'Tax paid, reclaimed' }] : []),
    ],
  };
}

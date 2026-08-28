/**
 * Which shop a request is asking about.
 *
 * One definition, used by every list that has to be separated, because four
 * copies of this rule is four chances for one screen to quietly show a manager
 * the other branch's trade. It had grown up as an inline expression in the
 * reports route and nowhere else, which is precisely how the documents list,
 * the sales list, the tills and the cash-flow feed came to show everything to
 * everybody.
 *
 * The rule: you get the counter you are standing at. `?branch=all` widens it to
 * the whole company, and only for somebody holding `branches` — in practice the
 * owner. A branch manager reading another branch's invoices as their own is
 * worse than showing them nothing.
 *
 * Returns null for "every branch", which is what the SQL below expects:
 *
 *     WHERE (? IS NULL OR branch_id = ?)
 *
 * written that way so one query serves both cases rather than two queries that
 * can disagree.
 */
import { can } from './permissions.js';

export function branchScope(req) {
  if (req.query?.branch === 'all' && can(req.user, 'branches')) return null;
  return req.branchId ?? null;
}

/**
 * The pair of parameters that clause wants.
 *
 * Bound twice because SQLite has no named parameters here, and getting the two
 * out of step is the bug this exists to make impossible.
 */
export function branchParams(req) {
  const id = branchScope(req);
  return [id, id];
}

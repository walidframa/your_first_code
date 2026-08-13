/**
 * What a shop has actually bought.
 *
 * A different question from what any one person in the shop may do. Permissions
 * decide whether *this cashier* may open the cashbox; modules decide whether
 * this *shop* has the transfer desk at all. A shop that never paid for repairs
 * should not see a Repairs screen it cannot use, and its owner — who passes
 * every permission there is — should not be able to reach it either.
 *
 * Kept in the vendor's control database beside the licence, for the same reason
 * the licence is: a shop's own admin has full rights over every table in their
 * own database, so a list of paid-for features stored there is a list they can
 * edit. This file is not theirs.
 */

/**
 * Everything that can be sold separately, and what it is called on the screen.
 *
 * The register, the catalogue, stock and the cashbox are deliberately not here.
 * They are the till: a shop with those switched off has not bought a cheaper
 * copy of this app, it has bought nothing, and building the switch invites
 * somebody to try.
 */
export const MODULES = [
  ['repairs', 'Repairs', 'Take phones in for repair, print tickets, track them'],
  ['transfers', 'Transfer desk', 'OMT, Whish and the rest, with the fees and the drawer'],
  ['vouchers', 'Vouchers', 'Money in and out between accounts, with a printed slip'],
  ['sims', 'SIM cards', 'Lines stocked and sold by the number on the card'],
  ['credit', 'Calling credit', 'Sending credit by SMS from a carrier balance'],
  ['cards', 'Recharge cards', 'Cards and validity sold from a carrier balance'],
  ['installments', 'Instalments', 'Selling on a plan and chasing what is due'],
  ['documents', 'Quotes and invoices', 'Quotations, purchase and sales invoices'],
  ['branches', 'More than one branch', 'A second shop, its own stock and its own drawer'],
  ['shopify', 'Shopify', 'Keeping an online shop in step with this one'],
  ['imports', 'Catalogue import', 'Bringing a catalogue in from a spreadsheet'],
  ['labels', 'Labels', 'Printing barcode and price labels'],
];

export const MODULE_KEYS = MODULES.map(([key]) => key);

/**
 * Which of them this shop has.
 *
 * `null` — the column never set — means **all of them**. Every shop already
 * running was sold the whole app, and a column added underneath them must not
 * quietly take away the transfer desk they have been using all year.
 */
export function parseModules(stored) {
  if (stored === null || stored === undefined || stored === '') return [...MODULE_KEYS];
  try {
    const list = JSON.parse(stored);
    if (!Array.isArray(list)) return [...MODULE_KEYS];
    // Filtered against the known list so a key removed from the app later
    // cannot leave a shop holding something that no longer exists.
    return MODULE_KEYS.filter((key) => list.includes(key));
  } catch {
    /*
     * Unreadable is treated as everything, not as nothing.
     *
     * A corrupted column must not take a working shop's features away in the
     * middle of a trading day. The vendor can see and fix it; the shop should
     * not find out by a screen disappearing.
     */
    return [...MODULE_KEYS];
  }
}

export const serialiseModules = (keys) =>
  JSON.stringify(MODULE_KEYS.filter((key) => keys.includes(key)));

/**
 * Which routes belong to which module.
 *
 * Prefixes rather than a list of endpoints: a route added to an existing screen
 * later is covered without anybody remembering, and the failure of forgetting
 * would be a feature the shop has not paid for quietly working.
 */
export const MODULE_ROUTES = [
  ['/api/repairs', 'repairs'],
  ['/api/transfers', 'transfers'],
  ['/api/vouchers', 'vouchers'],
  ['/api/sims', 'sims'],
  ['/api/credit', 'credit'],
  ['/api/wallets', 'cards'],
  ['/api/installments', 'installments'],
  ['/api/documents', 'documents'],
  /*
   * `/api/branches` is deliberately absent, and putting it here once took a
   * live shop's register down to a page of grey rectangles.
   *
   * Every shop has a branch — the one it is standing in — whether or not it
   * ever bought the second one. The app asks which before it can show a shelf,
   * because stock is held per branch, so a 403 here is not a feature being
   * withheld: it is the till failing to load, with no message, on a screen
   * whose whole job is selling.
   *
   * What the module actually sells is *more than one* branch, and that lives
   * behind the routes below and behind the `branches` permission on the ones
   * that create and rename them.
   */
  ['/api/stock-transfers', 'branches'],
  ['/api/shopify', 'shopify'],
  ['/api/imports', 'imports'],
];

/** The module a request belongs to, or null when it belongs to the till. */
export function moduleForPath(path) {
  const hit = MODULE_ROUTES.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  return hit ? hit[1] : null;
}

/** What to call it when telling somebody they cannot have it. */
export const moduleName = (key) => MODULES.find(([k]) => k === key)?.[1] ?? key;

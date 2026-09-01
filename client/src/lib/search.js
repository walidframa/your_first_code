/**
 * Finding a thing by typing some of what it is called.
 *
 * Every search in this app used to be `name.includes(what you typed)`, which
 * asks the shopkeeper to type a contiguous run of the product's name in the
 * order the product happens to carry it. That is not how anybody searches. A
 * shop looking for "PHONE NEW CASE" types "phone case", gets nothing, and
 * concludes the product is not in the catalogue — with a customer waiting and
 * the product on the shelf behind them.
 *
 * So a query is words, and every word has to be in there **somewhere**. Order
 * does not matter, and neither does what falls between them:
 *
 *     "phone case"   finds  PHONE NEW CASE
 *     "case phone"   finds  PHONE NEW CASE
 *     "sam 20"       finds  Samsung A20 charger
 *
 * Across all the fields together rather than each on its own, which is the
 * other half of the same idea: "samsung CBL-01" is a name and a code, and
 * somebody typing both means "the one that is both", not "a product whose name
 * contains that whole string".
 *
 * Still a substring per word, not a fuzzy match. A shop typing "case" should
 * not be shown "cash" — at a counter a near-miss that looks like a hit is worse
 * than a miss, because it is rung up.
 */
export function matchesSearch(query, ...fields) {
  const words = terms(query);
  if (words.length === 0) return true;

  const haystack = fields
    .flat(Infinity)
    .filter((f) => f !== null && f !== undefined && f !== '')
    .join(' ')
    .toLowerCase();

  return words.every((word) => haystack.includes(word));
}

/**
 * The words in a query, lower-cased.
 *
 * Exported because a couple of callers want to know whether anything was typed
 * at all before they go to the trouble of filtering a catalogue of two
 * thousand.
 */
export function terms(query) {
  return String(query ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

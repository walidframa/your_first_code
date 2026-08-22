/**
 * Times, shown on the clock the person is holding.
 *
 * Every timestamp in this app is stored by SQLite as `datetime('now')`, which
 * is **UTC**, written as `2026-08-22 14:05:00` — no `Z`, no offset, nothing to
 * say which clock it belongs to. Printed as it stands it is simply wrong for
 * anybody not in London in winter: a shop in Beirut rings up a sale at five in
 * the afternoon and the Sales list says it happened at two.
 *
 * Worse, it is wrong *quietly*. Nobody checks the seconds on a receipt, so the
 * error is invisible until somebody is reconciling a day's takings against a
 * bank statement, or asking which shift a refund happened on.
 *
 * There is a second trap under the first. JavaScript parses
 * `new Date('2026-08-22 14:05:00')` — no zone marker — as **local** time, so
 * the naive fix of handing the string to `Date` produces a value that is right
 * on a server running in UTC and wrong on every phone in the shop. The string
 * has to be *told* it is UTC before it is parsed, which is what `parse` below
 * exists to do.
 *
 * Formatting then follows the device, deliberately, because that is the whole
 * point: the app should agree with the clock in the corner of the phone's own
 * screen, in that phone's timezone and in the format its owner has chosen.
 * That is the opposite of the decision taken for money, which is pinned to one
 * format because `$` is what the shop writes on its price tags whatever the
 * phone thinks. A clock is the device's business; a currency is the shop's.
 */

/**
 * A stored timestamp as a real point in time.
 *
 * Handles both shapes the app carries: SQLite's `YYYY-MM-DD HH:MM:SS`, which
 * means UTC and does not say so, and a proper ISO string that already carries
 * its zone — the offline queue writes those with `toISOString()`, and adding a
 * second `Z` to one would make it unparseable.
 */
function parse(value) {
  if (!value) return null;

  const text = String(value).trim();
  if (!text) return null;

  // Already says which clock it is on: a trailing Z, or a +02:00 / -0500.
  const carriesZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(text);
  const iso = text.includes('T') ? text : text.replace(' ', 'T');

  const at = new Date(carriesZone ? iso : `${iso}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The day and the time, as this device writes them. */
export function when(value, fallback = '—') {
  const at = parse(value);
  if (!at) return fallback;
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Just the time — for a list where every row is from today anyway. */
export function atTime(value, fallback = '—') {
  const at = parse(value);
  if (!at) return fallback;
  return at.toLocaleTimeString(undefined, { timeStyle: 'short' });
}

/** Just the day. */
export function onDate(value, fallback = '—') {
  const at = parse(value);
  if (!at) return fallback;
  return at.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/**
 * The day, in the form a date input and a range filter both understand.
 *
 * `YYYY-MM-DD` **in the device's timezone**, not UTC's. `toISOString().slice`
 * is the usual way to write this and it is wrong for exactly the hours that
 * matter: at nine in the evening in Beirut it still says today, but at one in
 * the morning it says yesterday — so "today's sales" quietly loses the last
 * two hours of the shop's day.
 */
export function isoDay(value = new Date()) {
  const at = value instanceof Date ? value : parse(value);
  if (!at) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

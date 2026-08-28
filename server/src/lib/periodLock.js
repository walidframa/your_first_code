/**
 * Which dates are shut.
 *
 * Its own module, and a very small one, because both sides of the closing need
 * it: the ledger has to refuse a date that is shut, and the closing that shuts
 * it is written by the ledger. Putting these three functions in either file
 * would make the two import each other, and a cycle that happens to work today
 * is a crash waiting for somebody to reorder an import.
 */
import { db } from '../db.js';

/**
 * The last date that is shut, or null if nothing is.
 *
 * One date rather than a list of periods: closings run forward, so a shop that
 * has closed 2024 and then 2025 has everything up to the end of 2025 shut, and
 * asking "is this date closed" is one comparison rather than a search.
 */
export function closedThrough() {
  const row = db
    .prepare('SELECT MAX(period_end) AS end FROM book_closings WHERE reopened_at IS NULL')
    .get();
  return row?.end ?? null;
}

/** Whether a date falls in a period that has been shut. */
export function isClosed(date) {
  const shut = closedThrough();
  if (!shut || !date) return false;
  return String(date).slice(0, 10) <= shut;
}

/**
 * The first date something may be posted on.
 *
 * Null when nothing is shut, which means "anywhere".
 */
export function firstOpenDate() {
  const shut = closedThrough();
  if (!shut) return null;
  const next = new Date(`${shut}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * Move a date forward out of a closed period, or leave it where it is.
 *
 * What the automatic postings use, and the reason a closed year cannot stop a
 * shop trading. An invoice confirmed today for goods received in a closed
 * December belongs in the books — it just does not belong in December any
 * more. Refusing it instead would mean a sale that cannot be rung up because
 * the accountant shut a year, which is the tail wagging the dog.
 */
export function afterClose(date) {
  if (!date || !isClosed(date)) return date;
  return firstOpenDate();
}

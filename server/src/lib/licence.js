/**
 * Whether a shop that rents this app has paid for it.
 *
 * The whole of the rule lives here, as arithmetic on two dates, so that the
 * question "is this shop locked?" has exactly one answer wherever it is asked —
 * the banner in the till, the middleware that refuses a sale, and the console
 * the vendor is looking at.
 *
 * **Where this is read from matters more than what it says.** A licence stored
 * in the shop's own database is a licence the shop's own admin can edit, and
 * they have full rights over every table in it. It lives in the vendor's
 * control database, which a tenant's process opens read-only and never writes.
 *
 * Dates are plain `YYYY-MM-DD`, compared as strings. A licence is about which
 * day it is in the shop, not which instant it is in UTC — a shop in Beirut
 * should not lock at three in the afternoon because a server in Frankfurt has
 * already reached midnight.
 */

export const PLANS = {
  monthly: { months: 1, label: 'Monthly' },
  yearly: { months: 12, label: 'Yearly' },
};

/** Days past the deadline before selling stops. */
export const GRACE_DAYS = 10;

/** How long before the deadline the till starts saying so. */
export const WARN_DAYS = 14;

export const today = () => new Date().toISOString().slice(0, 10);

/** Whole days from one plain date to another, negative when the second is earlier. */
export function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * The day a licence runs to after another period is paid for.
 *
 * Counted from the day already paid through rather than from today, so a shop
 * that pays a week late does not silently buy itself a week less — and one that
 * pays early does not lose the remainder.
 *
 * Month lengths are clamped: a licence paid through the 31st renews to the 28th
 * in February rather than sliding into March.
 */
export function extend(paidThrough, plan, times = 1) {
  const months = PLANS[plan]?.months;
  if (!months) throw new Error(`Unknown plan: ${plan}`);

  const from = new Date(`${paidThrough}T00:00:00Z`);
  /*
   * Refused rather than rolled.
   *
   * Javascript reads the 29th of a non-leap February as the 1st of March and
   * says nothing, so a licence recorded a day that does not exist would renew
   * from a month later than anybody typed — and the error would show up a year
   * on, as a date nobody can account for. Round-tripping the string is the
   * cheapest way to catch it at the moment it is written.
   */
  if (Number.isNaN(from.getTime()) || from.toISOString().slice(0, 10) !== paidThrough) {
    throw new Error(`Not a date: ${paidThrough}`);
  }

  const day = from.getUTCDate();
  const moved = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months * times, 1),
  );
  const lastOfMonth = new Date(
    Date.UTC(moved.getUTCFullYear(), moved.getUTCMonth() + 1, 0),
  ).getUTCDate();
  moved.setUTCDate(Math.min(day, lastOfMonth));
  return moved.toISOString().slice(0, 10);
}

/**
 * Where a licence stands, as one object the whole app can read.
 *
 * Four states, and the two in the middle are the point of the thing:
 *
 *   active   — nothing to say.
 *   due      — paid, but the deadline is close. The till says so and keeps
 *              selling; nobody is interrupted.
 *   overdue  — the deadline has passed and the grace days are running. Still
 *              selling, and now saying so loudly with a date on it.
 *   locked   — grace is spent. Selling stops.
 *
 * `suspended` is the vendor's own switch and jumps straight to locked, so a
 * shop can be stopped without waiting for a date, and started again the same
 * way.
 */
export function licenceState(licence, now = today()) {
  if (!licence) {
    // No licence record at all is the vendor's own shop, or a copy somebody
    // runs for themselves. Not everything is rented.
    return { state: 'active', unlicensed: true, daysLeft: null, lockedOn: null };
  }

  if (licence.suspended) {
    return {
      state: 'locked',
      reason: 'suspended',
      daysLeft: null,
      lockedOn: null,
      paidThrough: licence.paid_through || null,
    };
  }

  const paidThrough = licence.paid_through;
  if (!paidThrough || daysBetween(paidThrough, now) === null) {
    // A tenant with no date recorded has never paid for a first period. Locked
    // rather than free: the failure of a vendor to fill something in should not
    // hand out the app.
    return { state: 'locked', reason: 'never_paid', daysLeft: null, lockedOn: null };
  }

  const graceDays = Number.isInteger(licence.grace_days) ? licence.grace_days : GRACE_DAYS;
  const daysLeft = daysBetween(now, paidThrough);
  const lockedOn = addDays(paidThrough, graceDays + 1);

  if (daysLeft >= 0) {
    return {
      state: daysLeft <= WARN_DAYS ? 'due' : 'active',
      daysLeft,
      paidThrough,
      lockedOn,
      plan: licence.plan,
    };
  }

  const daysOver = -daysLeft;
  return {
    state: daysOver > graceDays ? 'locked' : 'overdue',
    reason: daysOver > graceDays ? 'unpaid' : undefined,
    daysLeft,
    daysOver,
    graceLeft: Math.max(0, graceDays - daysOver + 1),
    paidThrough,
    lockedOn,
    plan: licence.plan,
  };
}

export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The short sentence a till shows. Kept here so every surface says the same. */
export function licenceMessage(status) {
  switch (status.state) {
    case 'due':
      return status.daysLeft === 0
        ? 'The licence for this shop runs out today.'
        : `The licence for this shop runs out in ${status.daysLeft} day${status.daysLeft === 1 ? '' : 's'}.`;
    case 'overdue':
      return `The licence for this shop ran out on ${status.paidThrough}. Selling stops on ${status.lockedOn}.`;
    case 'locked':
      return status.reason === 'suspended'
        ? 'This shop has been suspended.'
        : 'The licence for this shop has run out, and selling has stopped.';
    default:
      return '';
  }
}

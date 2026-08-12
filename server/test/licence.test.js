/**
 * The arithmetic that decides whether a shop can sell today.
 *
 * Worth this much care because both ways of getting it wrong are expensive: a
 * day early and a paying customer's till stops in front of their customers; a
 * day late and the vendor's only lever is soft. Every boundary here is a real
 * morning in somebody's shop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRACE_DAYS,
  addDays,
  daysBetween,
  extend,
  licenceMessage,
  licenceState,
} from '../src/lib/licence.js';

const paid = (through, extra = {}) => ({ paid_through: through, plan: 'monthly', ...extra });

/* ------------------------------------------------------------ the states */

test('a licence with time left is simply active', () => {
  const status = licenceState(paid('2026-12-31'), '2026-08-12');
  assert.equal(status.state, 'active');
  assert.equal(status.daysLeft, 141);
});

test('the till starts saying so a fortnight out, and not before', () => {
  // Fifteen days is silence; fourteen is the first word about it. A warning
  // that starts too early is one nobody reads by the time it matters.
  assert.equal(licenceState(paid('2026-08-27'), '2026-08-12').state, 'active');
  assert.equal(licenceState(paid('2026-08-26'), '2026-08-12').state, 'due');
});

test('the last paid day is still a paid day', () => {
  // Paid *through* the 12th means the 12th is covered. Locking somebody out on
  // the morning of the day they paid for is the kind of off-by-one that costs a
  // customer.
  const status = licenceState(paid('2026-08-12'), '2026-08-12');
  assert.equal(status.state, 'due');
  assert.equal(status.daysLeft, 0);
});

test('the day after is overdue, and still selling', () => {
  const status = licenceState(paid('2026-08-12'), '2026-08-13');
  assert.equal(status.state, 'overdue');
  assert.equal(status.daysOver, 1);
});

/* ------------------------------------------------------- the grace period */

test('ten days of grace means the tenth day still sells', () => {
  const status = licenceState(paid('2026-08-12'), '2026-08-22');
  assert.equal(status.daysOver, 10);
  assert.equal(status.state, 'overdue', 'the tenth day is still inside the grace');
});

test('the eleventh day is where it stops', () => {
  const status = licenceState(paid('2026-08-12'), '2026-08-23');
  assert.equal(status.daysOver, 11);
  assert.equal(status.state, 'locked');
  assert.equal(status.reason, 'unpaid');
});

test('the date the till will stop is worked out in advance, and does not move', () => {
  // It goes in front of the shopkeeper while they can still act on it, so it
  // has to be the same date every time it is shown.
  const first = licenceState(paid('2026-08-12'), '2026-08-13');
  const later = licenceState(paid('2026-08-12'), '2026-08-20');
  assert.equal(first.lockedOn, '2026-08-23');
  assert.equal(later.lockedOn, '2026-08-23');
});

test('a shop can be given longer, or less, than the usual ten days', () => {
  assert.equal(licenceState(paid('2026-08-12', { grace_days: 30 }), '2026-08-23').state, 'overdue');
  assert.equal(licenceState(paid('2026-08-12', { grace_days: 0 }), '2026-08-13').state, 'locked');
});

/* ------------------------------------------------------- the vendor's switch */

test('a suspended shop is locked whatever its dates say', () => {
  const status = licenceState(paid('2099-01-01', { suspended: 1 }), '2026-08-12');
  assert.equal(status.state, 'locked');
  assert.equal(status.reason, 'suspended');
});

test('a tenant with no date recorded is locked, not free', () => {
  // A vendor forgetting to fill something in must not hand out the app.
  assert.equal(licenceState({ plan: 'monthly' }, '2026-08-12').state, 'locked');
  assert.equal(licenceState(paid('not-a-date'), '2026-08-12').state, 'locked');
});

test('no licence at all is the vendor’s own shop, and sells', () => {
  // Not every copy is rented. The one the vendor runs has no control database
  // behind it and must not lock itself out.
  const status = licenceState(null, '2026-08-12');
  assert.equal(status.state, 'active');
  assert.equal(status.unlicensed, true);
});

/* ------------------------------------------------------------- renewing */

test('paying extends from the day already paid for, not from today', () => {
  // A shop that pays a week late has still bought a whole month; one that pays
  // early keeps the remainder. Extending from today would quietly take both.
  assert.equal(extend('2026-08-12', 'monthly'), '2026-09-12');
  assert.equal(extend('2026-08-12', 'yearly'), '2027-08-12');
});

test('a short month clamps rather than sliding into the next one', () => {
  assert.equal(extend('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(extend('2028-01-31', 'monthly'), '2028-02-29', 'leap year');
  assert.equal(extend('2026-03-31', 'monthly'), '2026-04-30');
});

test('paying for several periods at once', () => {
  assert.equal(extend('2026-08-12', 'monthly', 3), '2026-11-12');
  assert.equal(extend('2028-02-29', 'yearly', 1), '2029-02-28', 'leap day to a year with none');
});

test('an unknown plan is refused rather than guessed', () => {
  assert.throws(() => extend('2026-08-12', 'weekly'));
});

test('a day that does not exist is refused, not quietly moved', () => {
  // Javascript reads the 29th of a non-leap February as the 1st of March
  // without complaint, which would renew a licence from a month nobody typed —
  // and the mistake would only surface a year later.
  assert.throws(() => extend('2026-02-29', 'monthly'), /Not a date/);
  assert.throws(() => extend('2026-13-01', 'monthly'), /Not a date/);
  assert.throws(() => extend('2026-04-31', 'monthly'), /Not a date/);
});

/* -------------------------------------------------------------- the words */

test('what the shop is told names a date it can act on', () => {
  const overdue = licenceState(paid('2026-08-12'), '2026-08-15');
  const words = licenceMessage(overdue);
  assert.match(words, /2026-08-12/);
  assert.match(words, /2026-08-23/, 'the day it stops, so it is not a surprise');

  assert.match(licenceMessage(licenceState(paid('2026-08-12'), '2026-08-12')), /today/);
  assert.match(licenceMessage(licenceState(paid('2026-08-13'), '2026-08-12')), /1 day\b/);
  assert.equal(licenceMessage(licenceState(paid('2026-12-31'), '2026-08-12')), '');
});

/* ------------------------------------------------------------ the helpers */

test('days between plain dates ignore clocks and daylight saving', () => {
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2, 'the clocks go forward in between');
  assert.equal(daysBetween('2026-08-12', '2026-08-12'), 0);
  assert.equal(daysBetween('2026-08-13', '2026-08-12'), -1);
  assert.equal(daysBetween('nonsense', '2026-08-12'), null);
});

test('adding days crosses months and years', () => {
  assert.equal(addDays('2026-12-28', 5), '2027-01-02');
  assert.equal(addDays('2026-02-27', GRACE_DAYS), '2026-03-09');
});

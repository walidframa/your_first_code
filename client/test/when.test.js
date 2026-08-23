/**
 * Turning a stored timestamp into the clock on the phone in your hand.
 *
 * Every time in this app is written by SQLite as `datetime('now')` — UTC, as
 * `2026-08-22 14:05:00`, with nothing in the string saying so. Two ways to get
 * that wrong, and the app had both:
 *
 * Printed as it stands, it is simply the wrong time for anybody outside UTC. A
 * shop in Beirut rang up a sale at five in the afternoon and the sales list
 * said two.
 *
 * And handed to `new Date()` as it stands, JavaScript reads a string with no
 * zone marker as **local** — so the obvious fix produces a value that is right
 * on a server running in UTC and three hours wrong on the counter.
 *
 * These run in a UTC container, which is exactly where a timezone bug hides,
 * so nothing here asserts a rendered wall-clock string. What is asserted is
 * the *instant* — which is the thing that was wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { atTime, isoDay, onDate, when } from '../src/lib/when.js';

/** The instant a rendering refers to, recovered for comparison. */
const instant = (value) => Date.parse(value);

test("a stored timestamp means UTC, whatever the string forgot to say", () => {
  /*
   * The whole bug in one assertion: `2026-08-22 14:05:00` is 14:05 UTC, and
   * must not be read as 14:05 wherever the reader happens to be standing.
   */
  const rendered = when('2026-08-22 14:05:00');
  const expected = new Date(Date.UTC(2026, 7, 22, 14, 5, 0));
  assert.equal(rendered, expected.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
});

test('a string that already carries its zone is not given a second one', () => {
  /*
   * The offline queue writes `toISOString()`, which ends in Z. Appending
   * another would make it unparseable — and the sale held while the server was
   * away would show no time at all.
   */
  assert.notEqual(when('2026-08-22T14:05:00.000Z'), '—');
  assert.equal(
    instant('2026-08-22T14:05:00.000Z'),
    Date.UTC(2026, 7, 22, 14, 5, 0),
    'the fixture itself is 14:05 UTC',
  );

  // And an explicit offset is honoured rather than overwritten: +02:00 at
  // 14:05 is 12:05 UTC, not 14:05 UTC.
  assert.equal(
    when('2026-08-22T14:05:00+02:00'),
    new Date(Date.UTC(2026, 7, 22, 12, 5, 0)).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
  );
});

test('nothing, and nonsense, come back as a dash rather than "Invalid Date"', () => {
  for (const junk of [null, undefined, '', '   ', 'not a date', 0]) {
    assert.equal(when(junk), '—', `${JSON.stringify(junk)} should be a dash`);
    assert.equal(onDate(junk), '—');
    assert.equal(atTime(junk), '—');
  }
  // The caller can ask for its own blank — a receipt wants an empty cell, not
  // a dash, where a sitting has not been closed.
  assert.equal(atTime(null, ''), '');
});

test('the day is the device\'s day, not UTC\'s', () => {
  /*
   * `toISOString().slice(0, 10)` is the usual way to write this and it is
   * wrong for exactly the hours that matter. Late evening east of UTC is still
   * today locally and already tomorrow in UTC — so "today's sales" would drop
   * the last hours of the shop's day, which is when a shop is busiest.
   */
  const evening = new Date(2026, 7, 22, 23, 30, 0); // 23:30 local, whatever local is
  assert.equal(isoDay(evening), '2026-08-22');

  const earlyMorning = new Date(2026, 7, 22, 0, 30, 0);
  assert.equal(isoDay(earlyMorning), '2026-08-22');
});

test('a time-only rendering is still the right instant', () => {
  const rendered = atTime('2026-08-22 14:05:00');
  const expected = new Date(Date.UTC(2026, 7, 22, 14, 5, 0));
  assert.equal(rendered, expected.toLocaleTimeString(undefined, { timeStyle: 'short' }));
});

/**
 * The one-second seam between a password change and a token.
 *
 * JWT issue times are whole seconds; a password change is a millisecond. Within
 * the second they overlap there is no telling a session opened just before from
 * one opened just after, and which way that tie falls decides whether the app
 * is usable:
 *
 *   round up   — changing your own password logs you out, because the login
 *                that follows lands in the same second the change claims to be
 *                after. Locked out of your own till for typing quickly.
 *
 *   round down — a session opened in that same second survives the change. A
 *                window under a second wide, needing the old password, which
 *                whoever is being locked out already had.
 *
 * Pinned here because the wrong choice is the tempting one — it looks stricter —
 * and its symptom, an owner unable to sign in after doing the responsible
 * thing, does not obviously point back to this line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { tokenPredatesPassword } = await import('../src/lib/passwords.js');

const at = (ms) => ({ password_changed_at: new Date(ms).toISOString() });

test('a session from before the change is refused', () => {
  const changed = 1_700_000_000_000;
  assert.equal(tokenPredatesPassword(at(changed), changed / 1000 - 1), true);
  assert.equal(tokenPredatesPassword(at(changed), changed / 1000 - 3600), true);
});

test('a session from the same second is let through', () => {
  const changed = 1_700_000_000_000;
  assert.equal(tokenPredatesPassword(at(changed), changed / 1000), false);
});

test('a session from after the change is let through', () => {
  const changed = 1_700_000_000_000;
  assert.equal(tokenPredatesPassword(at(changed), changed / 1000 + 1), false);
});

test('a change recorded mid-second does not refuse that whole second', () => {
  // The stored value is floored on the way in, but a row written by an older
  // build — or by hand — may carry milliseconds. Comparing without flooring
  // would refuse a token issued in the same second, which is the fresh login.
  const changed = 1_700_000_000_500;
  assert.equal(tokenPredatesPassword(at(changed), 1_700_000_000), false);
  assert.equal(tokenPredatesPassword(at(changed), 1_699_999_999), true);
});

test('a missing or unreadable timestamp doubts nothing', () => {
  // Refusing every request over a malformed column would shut a shop out of its
  // own till over a field that has nothing to do with selling.
  assert.equal(tokenPredatesPassword({}, 1_700_000_000), false);
  assert.equal(tokenPredatesPassword({ password_changed_at: 'never' }, 1_700_000_000), false);
  assert.equal(tokenPredatesPassword(null, 1_700_000_000), false);
  assert.equal(tokenPredatesPassword(at(1_700_000_000_000), undefined), false);
});

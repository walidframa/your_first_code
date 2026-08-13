import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { checkPassword, normalisePassword, SEEDED_PASSWORDS } from './passwordRules.js';

// Re-exported so the callers that already ask this module for them do not have
// to care that the rules moved somewhere with no database attached.
export { checkPassword, normalisePassword, SEEDED_PASSWORDS };

/**
 * Setting a password, in the one place that knows the rules.
 *
 * Two routes need this — changing your own, and an owner resetting somebody
 * else's — and they must agree on every part of it, because the half that gets
 * forgotten in a second copy is always the bookkeeping: the timestamp that
 * ends old sessions, and the flag that stops the nagging.
 */

/**
 * Does this password open this account?
 *
 * Tries the normalised form first, then the exact bytes supplied. The second
 * attempt is for hashes written before any of this existed: somebody whose
 * stored hash was made from decomposed input types the same keys and must
 * still get in. `stale` says the hash is one of those, so the caller can
 * quietly write it back in the settled form and the fallback stops being
 * needed.
 *
 * Both attempts are made every time, so a wrong password costs the same work
 * as a right one and the timing says nothing.
 */
export function verifyPassword(supplied, hash) {
  if (typeof hash !== 'string' || !hash) return { ok: false, stale: false };
  const settled = bcrypt.compareSync(normalisePassword(supplied), hash);
  const asTyped = bcrypt.compareSync(String(supplied ?? ''), hash);
  return { ok: settled || asTyped, stale: !settled && asTyped };
}

/**
 * Write the hash in the settled form, without touching anything else.
 *
 * Deliberately not `setPassword`: this is the same password, so it must not
 * move `password_changed_at` — that would sign the person out of the very
 * session they just signed into, over a repair they did not ask for.
 */
export function restorePasswordHash(userId, password) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    bcrypt.hashSync(normalisePassword(password), 10),
    userId,
  );
}

/**
 * Write it down, and note when — to the second, on purpose.
 *
 * JWT issue times are whole seconds, so within the second a password changes
 * there is no telling a token minted just before it from one minted just after.
 * Something has to give, and the two ways of giving are not equal:
 *
 * Round *up*, and the honest case breaks — change your password, sign straight
 * back in, and be refused by the rule meant to protect you, because the login
 * landed in the same second the change claims to be after.
 *
 * Round *down*, and a token issued in the same second as the change survives
 * it. That is a window under a second wide, needing the old password, which
 * whoever is being locked out already had. It buys them nothing.
 *
 * So: down. A session from an hour ago is refused, and nobody is locked out of
 * their own till for typing quickly.
 */
export function setPassword(userId, password) {
  const changedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  db.prepare(
    `UPDATE users
        SET password_hash = ?, password_changed_at = ?, must_change_password = 0
      WHERE id = ?`,
  ).run(bcrypt.hashSync(normalisePassword(password), 10), changedAt, userId);
  return changedAt;
}

/**
 * Was this token issued before the password behind it changed?
 *
 * Both sides in whole seconds, and strictly less than — see `setPassword` for
 * why the same second counts as after.
 *
 * An unparseable or absent timestamp means "no reason to doubt it". Refusing
 * every request over a malformed column would lock a shop out of its own till
 * over a field that has nothing to do with selling.
 */
export function tokenPredatesPassword(user, issuedAtSeconds) {
  if (!user?.password_changed_at || !issuedAtSeconds) return false;
  const changed = Date.parse(user.password_changed_at);
  if (Number.isNaN(changed)) return false;
  return issuedAtSeconds < Math.floor(changed / 1000);
}

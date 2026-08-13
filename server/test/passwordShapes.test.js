/**
 * The two ways a correct password gets refused.
 *
 * Both come from the same report — "I changed my password in Settings and now
 * it says wrong password" — and neither is a mistake anybody could see. A
 * password field shows dots, so whatever went in is invisible from the moment
 * it is typed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import {
  checkPassword,
  normalisePassword,
  verifyPassword,
} from '../src/lib/passwords.js';

/* ------------------------------------------------------- the same letters */

test('the same password written two ways still opens the account', () => {
  /*
   * `é` is one code point or two, depending on the keyboard that produced it.
   * Identical in every font, different in every byte — so a password set on a
   * phone and typed at the counter is the same password and, without this,
   * does not match.
   */
  const onOneDevice = 'Café-Beirut-1'.normalize('NFC');
  const onAnother = 'Café-Beirut-1'.normalize('NFD');
  assert.notEqual(onOneDevice, onAnother, 'the fixture is not actually testing anything');

  const hash = bcrypt.hashSync(normalisePassword(onOneDevice), 10);
  assert.equal(verifyPassword(onAnother, hash).ok, true);
  assert.equal(verifyPassword(onOneDevice, hash).ok, true);
});

test('Arabic written two ways, likewise', () => {
  // These shops are in Lebanon. Arabic in a password is ordinary, and Arabic
  // has the same composed and decomposed problem.
  const composed = 'كلمةسر-أحمد'.normalize('NFC');
  const decomposed = composed.normalize('NFD');
  const hash = bcrypt.hashSync(normalisePassword(composed), 10);
  assert.equal(verifyPassword(decomposed, hash).ok, true);
});

test('a password written the old way is recognised, and reported as needing rewriting', () => {
  // Hashes already in shops were made from whatever bytes arrived. Their owners
  // must still get in, and the account should repair itself when they do.
  const typed = 'Café-Beirut-1'.normalize('NFD');
  const oldHash = bcrypt.hashSync(typed, 10);

  const attempt = verifyPassword(typed, oldHash);
  assert.equal(attempt.ok, true, 'an existing user was locked out by the fix');
  assert.equal(attempt.stale, true, 'and nothing would ever rewrite it');
});

test('a wrong password is still wrong, both ways round', () => {
  const hash = bcrypt.hashSync(normalisePassword('the-right-one'), 10);
  assert.equal(verifyPassword('the-wrong-one', hash).ok, false);
  assert.equal(verifyPassword('', hash).ok, false);
  assert.equal(verifyPassword('the-right-one', '').ok, false);
  assert.equal(verifyPassword('the-right-one', null).ok, false);
});

/* ------------------------------------------------------ the invisible space */

test('a password that starts or ends with a space is refused', () => {
  /*
   * Invisible in a field of dots, added by phone keyboards after an
   * autocorrected word, and typed into the confirm box the same way — so the
   * form is happy and every sign-in afterwards is not.
   */
  assert.match(checkPassword('secret12 '), /space/);
  assert.match(checkPassword(' secret12'), /space/);
  assert.match(checkPassword('secret12\n'), /space/);
});

test('spaces inside one are nobody else\'s business', () => {
  // A passphrase is a good password. Only the ends are the trap.
  assert.equal(checkPassword('correct horse battery'), null);
});

test('and the rules that were already there still hold', () => {
  assert.match(checkPassword('short'), /8 characters/);
  assert.match(checkPassword('admin123'), /demo password/);
  assert.equal(checkPassword('a-good-enough-one'), null);
});

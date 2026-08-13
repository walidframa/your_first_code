/**
 * What makes a password acceptable, with nothing else attached.
 *
 * Separate from `passwords.js` because that file opens the shop's database the
 * moment it is imported, and two things need these rules without wanting a
 * database: the `pos-tenant` command, which has to be able to open *any*
 * shop's file rather than the one an environment variable happened to name,
 * and the tests.
 *
 * Pure functions over strings. No state, no storage, no side effects.
 */

/** The passwords this app ships with, which are therefore public knowledge. */
export const SEEDED_PASSWORDS = ['admin123', 'cashier123'];

const MIN_LENGTH = 8;

/**
 * The same password, written the same way twice.
 *
 * Unicode has more than one way to spell the same character: `é` is either one
 * code point or an `e` followed by a combining accent, identical in every font
 * and different in every byte. Which one a keyboard produces depends on the
 * device — so a password set on a phone and typed on the counter PC can be the
 * same password and fail to match.
 *
 * Not theoretical here. These are shops in Lebanon; passwords have Arabic and
 * French letters in them, and "I changed my password and now it says wrong
 * password" is exactly what this produces.
 */
export const normalisePassword = (password) =>
  typeof password === 'string' ? password.normalize('NFC') : '';

/**
 * Is this good enough to put on a shop that is open to the internet?
 *
 * Deliberately short of a policy with symbol counts and forced rotation. Those
 * produce `Summer2024!` on a sticky note under the till. Length, and a refusal
 * to accept the ones already printed in the manual, is most of the value.
 */
export function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters`;
  }
  /*
   * A space at either end is refused rather than quietly removed.
   *
   * It is invisible in a field of dots, it survives being typed once and never
   * again, and phone keyboards add one after an autocorrected word without
   * being asked. Somebody sets `secret12 `, the confirm box gets the same space
   * because they typed it the same way, and every sign-in afterwards is "wrong
   * password" against a password they are typing correctly.
   *
   * Trimming it for them would be worse: the password stored would not be the
   * password typed, which is the same trap one level down.
   */
  if (password !== password.trim()) {
    return 'Password cannot start or end with a space — it is invisible here and impossible to type again on purpose.';
  }
  if (SEEDED_PASSWORDS.includes(password)) {
    return 'That is the demo password this app ships with. Pick another.';
  }
  return null;
}

/**
 * Which 401s mean "your session ended" and which mean "you typed it wrong".
 *
 * The interceptor sends you to the sign-in screen on a 401, which is right for
 * a token that has expired and wrong for a form whose whole job is to check a
 * password you just typed. Getting it wrong on the change-password form threw
 * people out of an app they were correctly signed in to, from a screen that
 * should simply have said "that is not your current password".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* The decision exactly as `api.js` makes it. */
const isTypedWrong = (url) =>
  String(url || '').includes('/auth/login') ||
  String(url || '').includes('/support/redeem') ||
  String(url || '').includes('/auth/password');

const isBackground = (url) => String(url || '').includes('/support/state');

/** Would a 401 on this URL end the session? */
const wouldSignOut = (url) => !isBackground(url) && !isTypedWrong(url);

test('a 401 on an ordinary request ends the session', () => {
  // The case this exists for: a token that has expired, noticed by whatever
  // request happened to be next.
  for (const url of ['/products', '/orders', '/customers', '/settings']) {
    assert.equal(wouldSignOut(url), true, `${url} should have ended the session`);
  }
});

test('a wrong password on a form that checks passwords does not', () => {
  // All three are "you typed it wrong", and each has a screen that has to be
  // able to say so in place.
  for (const url of ['/auth/login', '/support/redeem', '/auth/password']) {
    assert.equal(wouldSignOut(url), false, `${url} threw the person out`);
  }
});

test('the background poll never ends a session on its own', () => {
  // A cashier mid-sale must not be sent to the sign-in screen by a request
  // nobody made and nothing was waiting for.
  assert.equal(wouldSignOut('/support/state'), false);
});

test('changing a password is not confused with signing in', () => {
  // Both are exempt, for the same reason, but they are different requests and
  // a substring match must not be the thing holding that together by accident.
  assert.ok(isTypedWrong('/auth/password'));
  assert.ok(isTypedWrong('/auth/login'));
  assert.ok(!isTypedWrong('/auth/me'), 'a session check is not a typed password');
  assert.ok(!isTypedWrong('/auth/text-size'));
});

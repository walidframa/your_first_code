/**
 * A 401 caused by our own token being replaced is not an expired session.
 *
 * Changing a password invalidates every token issued before it — including
 * requests already in flight when the change lands. Treating those as an ended
 * session wipes the *new* token and navigates to the sign-in screen, and that
 * navigation cancels the change-password request itself, which surfaces as an
 * error with no response at all.
 *
 * From the shop it looked like this: the password changed, the app threw them
 * out, they signed in with the old one, and concluded that changing a password
 * breaks it. It took three rounds to find, so the decision is pinned here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * The decision exactly as `api.js` makes it: was this 401 caused by the token
 * being rotated underneath a request that was already on its way?
 */
function shouldRetry({ status, sentWith, holding, alreadyRetried = false }) {
  return Boolean(status === 401 && sentWith && holding && sentWith !== holding && !alreadyRetried);
}

test('a request sent with the old token is sent again with the new one', () => {
  // The whole bug: in flight when the password changed.
  assert.equal(
    shouldRetry({ status: 401, sentWith: 'Bearer old', holding: 'Bearer new' }),
    true,
  );
});

test('a genuinely expired session is not retried', () => {
  // Same token going out as we are holding: nothing was rotated, the token is
  // simply dead, and the person does need to sign in again.
  assert.equal(
    shouldRetry({ status: 401, sentWith: 'Bearer same', holding: 'Bearer same' }),
    false,
  );
});

test('it gives up after one retry', () => {
  // A second 401 carrying the current token is a real one. Without this the
  // app would sit in a loop against a server that keeps saying no.
  assert.equal(
    shouldRetry({
      status: 401,
      sentWith: 'Bearer old',
      holding: 'Bearer new',
      alreadyRetried: true,
    }),
    false,
  );
});

test('anything that is not a 401 is left alone', () => {
  for (const status of [400, 403, 404, 500, 502]) {
    assert.equal(shouldRetry({ status, sentWith: 'Bearer old', holding: 'Bearer new' }), false);
  }
});

test('a request sent with no token at all is not retried', () => {
  // Signing in carries no Authorization header. A 401 there means the password
  // was wrong, and retrying it would ask the same question twice.
  assert.equal(shouldRetry({ status: 401, sentWith: undefined, holding: 'Bearer new' }), false);
});

test('and neither is one made while signed out', () => {
  assert.equal(shouldRetry({ status: 401, sentWith: 'Bearer old', holding: undefined }), false);
});

/* ------------------------------------- caught by a rotation still in flight */

/**
 * The half the first fix missed, and the reason the form still said "the
 * server did not answer" for a password change that had already worked.
 *
 * The password POST leaves with token A. Before its reply arrives, another
 * request also sent with A comes back 401 — and at that instant the app is
 * still holding A, because the new token is in the post. Nothing looks
 * rotated, so the plain reading is "the session ended", and signing out
 * navigates away and cancels the password reply.
 *
 * Knowing a rotation is *underway* is what tells those apart.
 */
function decide({ status, url, rotating, sentWith, holding, alreadyRetried = false }) {
  if (status !== 401) return 'pass through';
  if (alreadyRetried) return 'sign out';
  // A form that checks a password reports its own refusal in place.
  if (/\/auth\/(login|password)|\/support\/redeem/.test(url)) return 'report in place';
  if (rotating > 0) return 'wait for the new token, then retry';
  if (sentWith && holding && sentWith !== holding) return 'retry with the current token';
  return 'sign out';
}

test('a 401 arriving during a password change waits rather than signing out', () => {
  assert.equal(
    decide({ status: 401, url: '/products', rotating: 1, sentWith: 'Bearer A', holding: 'Bearer A' }),
    'wait for the new token, then retry',
  );
});

test('the same 401 with no change in flight is a real expiry', () => {
  assert.equal(
    decide({ status: 401, url: '/products', rotating: 0, sentWith: 'Bearer A', holding: 'Bearer A' }),
    'sign out',
  );
});

test('the password request itself still reports its own refusal', () => {
  // Wrong current password. It must say so in the form, not wait on itself.
  assert.equal(
    decide({ status: 401, url: '/auth/password', rotating: 1, sentWith: 'Bearer A', holding: 'Bearer A' }),
    'report in place',
  );
});

test('a request already retried once is not retried again', () => {
  // Otherwise a server that keeps refusing becomes a loop.
  assert.equal(
    decide({
      status: 401,
      url: '/products',
      rotating: 1,
      sentWith: 'Bearer A',
      holding: 'Bearer B',
      alreadyRetried: true,
    }),
    'sign out',
  );
});

test('and after the change has landed, the mismatch path still catches stragglers', () => {
  assert.equal(
    decide({ status: 401, url: '/products', rotating: 0, sentWith: 'Bearer A', holding: 'Bearer B' }),
    'retry with the current token',
  );
});

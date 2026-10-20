/**
 * The count behind the loading icon.
 *
 * One number for the whole app: requests in, requests out, and a word to
 * whoever is listening when it crosses zero. The cases that matter are the
 * ones that would leave the icon stuck on — a reply handled twice, a retry —
 * and the ones that would make it flicker on an idle till — the polls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { begin, finish, isQuiet, pending, reset, subscribe } from '../src/lib/activity.js';

test.beforeEach(() => reset());

test('a request counts in and out, and the listener hears both edges', () => {
  const heard = [];
  subscribe((busy, count) => heard.push([busy, count]));

  const a = { url: '/products' };
  const b = { url: '/orders' };
  begin(a);
  begin(b);
  assert.equal(pending(), 2);
  finish(a);
  assert.equal(pending(), 1);
  finish(b);
  assert.equal(pending(), 0);

  // Told once when work started and once when it all finished — not on every
  // request, or the icon would be re-rendered a dozen times a second.
  assert.deepEqual(heard, [
    [true, 1],
    [false, 0],
  ]);
});

test('a reply handled twice is counted out once', () => {
  const config = { url: '/products' };
  begin(config);
  finish(config);
  finish(config);
  assert.equal(pending(), 0);

  // And a second request with the same config is a new request.
  begin(config);
  assert.equal(pending(), 1);
  finish(config);
  assert.equal(pending(), 0);
});

test('a retried request is counted for each attempt', () => {
  // The token rotated under it: finished (401), then sent again through the
  // request interceptor with the same config object.
  const config = { url: '/products' };
  begin(config);
  finish(config);
  begin(config);
  assert.equal(pending(), 1, 'the retry is a request the app is waiting on');
  finish(config);
  assert.equal(pending(), 0);
});

test('the polls never turn the icon on', () => {
  for (const url of ['/health', '/support/state']) {
    assert.ok(isQuiet({ url }), `${url} should be quiet`);
    begin({ url });
  }
  assert.equal(pending(), 0);
  assert.ok(!isQuiet({ url: '/products' }));
});

test('a request can ask to be quiet', () => {
  begin({ url: '/products', quiet: true });
  assert.equal(pending(), 0);
});

test('finishing something that was never counted does nothing', () => {
  finish(undefined);
  finish({ url: '/products' });
  assert.equal(pending(), 0);
});

test('a listener can stop listening', () => {
  let calls = 0;
  const stop = subscribe(() => {
    calls += 1;
  });
  begin({ url: '/a' });
  stop();
  finish({ url: '/a' });
  assert.equal(calls, 1);
});

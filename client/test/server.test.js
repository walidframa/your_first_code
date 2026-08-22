/**
 * Turning what a shopkeeper types into an address the app can call.
 *
 * The first screen of the phone app, and the one with no second chance: get
 * this wrong and somebody who typed their own address correctly is looking at
 * "cannot connect" on a fresh install, with nothing to do about it.
 *
 * So the rule is that every reasonable way of writing the same shop has to
 * arrive at the same address, and anything that is not an address at all has to
 * be refused rather than half-accepted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiBase, isNative, normalise } from '../src/lib/server.js';

test('the ways a person writes their own shop all mean the same shop', () => {
  /*
   * Bare hostname is what somebody types from memory; the https form is what
   * they get from pasting the browser's address bar; the trailing slash and
   * the path come from pasting while standing on a page inside the app.
   */
  const same = [
    'xtechpos.com',
    'https://xtechpos.com',
    'https://xtechpos.com/',
    'https://xtechpos.com/admin/capital',
    '  xtechpos.com  ',
    'HTTPS://xtechpos.com',
  ];
  for (const written of same) {
    assert.equal(normalise(written), 'https://xtechpos.com', `${written} should be the same shop`);
  }
});

test('https is assumed, but plain http is honoured when asked for by name', () => {
  // A shop on the counter's own wifi with no certificate is a real
  // arrangement. Silently upgrading it to https would break it.
  assert.equal(normalise('192.168.1.20:4000'), 'https://192.168.1.20:4000');
  assert.equal(normalise('http://192.168.1.20:4000'), 'http://192.168.1.20:4000');
});

test('a port is part of which server this is, and is kept', () => {
  assert.equal(normalise('xtechpos.com:4100'), 'https://xtechpos.com:4100');
});

test('what is not an address is refused rather than half-accepted', () => {
  // Empty string rather than a guess: the caller shows "that does not look
  // like a web address", which is more use than a request to nowhere.
  for (const junk of ['', '   ', 'https://', 'not a url at all', '://x']) {
    assert.equal(normalise(junk), '', `${JSON.stringify(junk)} should be refused`);
  }
});

test('on the web the app talks to wherever it was served from', () => {
  /*
   * The whole reason this is relative and not configured: on the web the app
   * is served *by* the server it is calling, so `/api` is correct by
   * construction and keeps working if the shop changes domain. Only the phone
   * app, which carries its pages inside itself, has to be told.
   */
  assert.equal(isNative(), false);
  assert.equal(apiBase(), '/api');
});

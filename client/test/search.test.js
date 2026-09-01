/**
 * Finding a thing by typing some of what it is called.
 *
 * Reported from the shop, in these words: *"if i search 'phone case' and the
 * item is 'phone new case' it will show nothing"*. Every search in the app was
 * a substring test, which asks the shopkeeper to type a contiguous run of the
 * product's name in the order the product happens to carry it — and nobody
 * searches like that. They type the two words they remember, get nothing, and
 * conclude the product is not in the catalogue while it is on the shelf behind
 * them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesSearch, terms } from '../src/lib/search.js';

test('the words can be in any order, with anything between them', () => {
  // The complaint itself.
  assert.ok(matchesSearch('phone case', 'PHONE NEW CASE'));
  assert.ok(matchesSearch('case phone', 'PHONE NEW CASE'));
  assert.ok(matchesSearch('new phone', 'PHONE NEW CASE'));
  assert.ok(matchesSearch('phone', 'PHONE NEW CASE'));
});

test('a word that is not there means no match', () => {
  /*
   * The other half, and the more important one at a counter: a near-miss that
   * looks like a hit gets rung up. Every word has to be in there — this is a
   * looser search, not a fuzzy one.
   */
  assert.ok(!matchesSearch('phone charger', 'PHONE NEW CASE'));
  assert.ok(!matchesSearch('case', 'CASH DRAWER'), 'case must not find cash');
});

test('the words may fall in different fields', () => {
  /*
   * "samsung CBL-01" is a name and a code, and somebody typing both means "the
   * one that is both" — not "a product whose name contains that whole string",
   * which is nothing.
   */
  assert.ok(matchesSearch('samsung CBL-01', 'Samsung cable', 'CBL-01'));
  assert.ok(matchesSearch('cbl samsung', 'Samsung cable', 'CBL-01'));
});

test('a barcode is searched as it is typed', () => {
  // Arrays flatten, so a product answering to several codes is found by any.
  assert.ok(matchesSearch('629104', 'Braided cable', 'CBL-01', ['6291041500213', '5012345000301']));
  assert.ok(matchesSearch('5012345000301', 'Braided cable', 'CBL-01', ['6291041500213', '5012345000301']));
});

test('nothing typed matches everything', () => {
  /* The filters call this on every row before anything is typed; an empty box
     is not a filter. */
  assert.ok(matchesSearch('', 'Anything'));
  assert.ok(matchesSearch('   ', 'Anything'));
  assert.ok(matchesSearch(null, 'Anything'));
});

test('missing fields are not the string "null"', () => {
  /*
   * A product with no barcode and no supplier used to be joined as
   * "null undefined" — and a shop searching for "null" would have found every
   * one of them.
   */
  assert.ok(!matchesSearch('null', 'Bagel', null, undefined, ''));
  assert.ok(!matchesSearch('undefined', 'Bagel', null, undefined, ''));
  assert.ok(matchesSearch('bagel', 'Bagel', null, undefined, ''));
});

test('case and spacing do not matter', () => {
  assert.ok(matchesSearch('  PHONE   case  ', 'phone new case'));
  assert.deepEqual(terms('  PHONE   case  '), ['phone', 'case']);
  assert.deepEqual(terms(''), []);
});

test('a name in Arabic is searched the same way', () => {
  // The catalogue this was written against has both.
  assert.ok(matchesSearch('الأمن الداخلي', 'المديرية العامة لقوى الأمن الداخلي'));
  assert.ok(matchesSearch('الداخلي المديرية', 'المديرية العامة لقوى الأمن الداخلي'));
});

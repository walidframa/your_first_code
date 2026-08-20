/**
 * Which columns a table shows.
 *
 * The thing worth testing here is what happens to a shop that saved a layout
 * and then took an update: a stored choice must not freeze their table at the
 * columns that existed the day they made it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hiddenFor, setHiddenFor, visibleColumns } from '../src/lib/tableColumns.js';

/** A browser's localStorage, near enough for what this module does with it. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test.beforeEach(() => {
  globalThis.localStorage = fakeStorage();
});

const COLUMNS = [
  { key: 'product', label: 'Product', fixed: true },
  { key: 'price', label: 'Price' },
  { key: 'cost', label: 'Cost' },
  { key: 'actions', label: 'Actions', fixed: true },
];

test('a table nobody has touched shows everything', () => {
  assert.deepEqual(hiddenFor('products'), []);
  assert.deepEqual(
    visibleColumns(COLUMNS, hiddenFor('products')).map((c) => c.key),
    ['product', 'price', 'cost', 'actions'],
  );
});

test('what is hidden is remembered, per table', () => {
  setHiddenFor('products', ['cost']);
  assert.deepEqual(hiddenFor('products'), ['cost']);
  // Another table's choice is its own — the same column name means a different
  // thing on the orders screen.
  assert.deepEqual(hiddenFor('orders'), []);

  assert.deepEqual(
    visibleColumns(COLUMNS, hiddenFor('products')).map((c) => c.key),
    ['product', 'price', 'actions'],
  );
});

test('a column added in a later version shows up for a shop that saved a layout', () => {
  // The reason what is stored is the *hidden* set rather than the shown one: a
  // shop that hid the cost in March must still see the average cost added in
  // April, without being told to go and reset their columns.
  setHiddenFor('products', ['cost']);
  const withNewColumn = [...COLUMNS, { key: 'avgCost', label: 'Average cost' }];

  assert.ok(
    visibleColumns(withNewColumn, hiddenFor('products')).some((c) => c.key === 'avgCost'),
    'a new column was hidden by a choice made before it existed',
  );
});

test('the columns that hold the row together cannot be hidden', () => {
  // Even by a stored choice that names them: a table of prices with no product
  // against them is not a table of anything.
  setHiddenFor('products', ['product', 'actions', 'price']);
  assert.deepEqual(
    visibleColumns(COLUMNS, hiddenFor('products')).map((c) => c.key),
    ['product', 'cost', 'actions'],
  );
});

test('showing them all again forgets the table rather than storing an empty list', () => {
  setHiddenFor('products', ['cost']);
  setHiddenFor('products', []);
  assert.deepEqual(hiddenFor('products'), []);
  assert.equal(globalThis.localStorage.getItem('pos_columns'), '{}');
});

test('a storage entry edited into nonsense shows every column', () => {
  globalThis.localStorage.setItem('pos_columns', 'not json');
  assert.deepEqual(hiddenFor('products'), []);

  globalThis.localStorage.setItem('pos_columns', '{"products":"cost"}');
  assert.deepEqual(hiddenFor('products'), [], 'a string where a list belongs');

  globalThis.localStorage.setItem('pos_columns', '{"products":["cost",7,null]}');
  assert.deepEqual(hiddenFor('products'), ['cost'], 'the parts that make sense survive');
});

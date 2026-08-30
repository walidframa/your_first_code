/**
 * What a tab calls the screen it is showing.
 *
 * The fallback walks up the address looking for a rail item, which is right for
 * `/admin/orders/48` and wrong for a document being raised: no rail item
 * matches `/admin/documents/new/...`, so the search walked past it to the
 * section above and labelled a half-typed invoice "Dashboard".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { titleFor } from '../src/lib/tabTitles.js';

test('a document being raised is named after the paper it is', () => {
  assert.equal(titleFor('/admin/documents/new/purchase-invoices'), 'New purchase invoice');
  assert.equal(titleFor('/admin/documents/new/sales-invoices'), 'New sales invoice');
  assert.equal(titleFor('/admin/documents/new/quotations'), 'New quotation');
});

test('and without a kind it is simply a new document', () => {
  assert.equal(titleFor('/admin/documents/new'), 'New document');
});

test('the list it came from is still called what it was', () => {
  assert.equal(titleFor('/admin/documents/purchase-invoices'), 'Purchase invoices');
});

test('an ordinary child page still borrows its parent', () => {
  assert.match(titleFor('/admin/orders/48'), /48$/);
});

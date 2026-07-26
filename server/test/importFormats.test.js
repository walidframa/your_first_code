import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber, detectFormat, buildMapping } from '../src/lib/importFormats.js';

const SHOPIFY = [
  'Handle', 'Title', 'Vendor', 'Type', 'Variant SKU', 'Variant Price',
  'Variant Inventory Qty', 'Cost per item', 'Variant Barcode', 'Image Src',
];
const SQUARE = [
  'Token', 'Item Name', 'SKU', 'Category', 'Reporting Category', 'Price',
  'Current Quantity Downtown', 'GTIN',
];
const LIGHTSPEED = [
  'System ID', 'Custom SKU', 'Description', 'Default Cost', 'Price', 'Qty', 'Category', 'UPC',
];

test('parses plain and currency-formatted numbers', () => {
  assert.equal(parseNumber('12.99'), 12.99);
  assert.equal(parseNumber('$12.99'), 12.99);
  assert.equal(parseNumber('  €8.50 '), 8.5);
  assert.equal(parseNumber('-5'), -5);
});

test('parses thousands separators in both conventions', () => {
  assert.equal(parseNumber('1,299.00'), 1299);
  assert.equal(parseNumber('1.299,50'), 1299.5);
  assert.equal(parseNumber('1,299'), 1299);
  assert.equal(parseNumber('12,99'), 12.99);
});

test('returns null for blank or non-numeric cells', () => {
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('N/A'), null);
  assert.equal(parseNumber(null), null);
  assert.equal(parseNumber(undefined), null);
});

test('detects vendor export formats from their headers', () => {
  assert.equal(detectFormat(SHOPIFY), 'shopify');
  assert.equal(detectFormat(SQUARE), 'square');
  assert.equal(detectFormat(LIGHTSPEED), 'lightspeed');
});

test('falls back to generic when no vendor signature matches', () => {
  assert.equal(detectFormat(['Product Name', 'Code', 'Sale Price', 'Quantity']), 'generic');
});

test('does not claim a vendor format on a single incidental header match', () => {
  assert.equal(detectFormat(['Price', 'Item Name', 'Notes']), 'generic');
});

test('maps Shopify columns onto canonical fields', () => {
  const mapping = buildMapping(SHOPIFY, 'shopify');
  assert.equal(mapping.name, 'Title');
  assert.equal(mapping.sku, 'Variant SKU');
  assert.equal(mapping.price, 'Variant Price');
  assert.equal(mapping.stock, 'Variant Inventory Qty');
  assert.equal(mapping.cost, 'Cost per item');
  assert.equal(mapping.supplier, 'Vendor');
  assert.equal(mapping.image_url, 'Image Src');
});

test('matches Square per-location quantity columns by prefix', () => {
  assert.equal(buildMapping(SQUARE, 'square').stock, 'Current Quantity Downtown');
});

test('maps Lightspeed description to product name', () => {
  const mapping = buildMapping(LIGHTSPEED, 'lightspeed');
  assert.equal(mapping.name, 'Description');
  assert.equal(mapping.sku, 'Custom SKU');
  assert.equal(mapping.cost, 'Default Cost');
  assert.equal(mapping.barcode, 'UPC');
});

test('maps generic CSVs through synonyms, case-insensitively', () => {
  const mapping = buildMapping(['Product Name', 'Code', 'Sale Price', 'Quantity', 'Department'], 'generic');
  assert.equal(mapping.name, 'Product Name');
  assert.equal(mapping.sku, 'Code');
  assert.equal(mapping.price, 'Sale Price');
  assert.equal(mapping.stock, 'Quantity');
  assert.equal(mapping.category, 'Department');
});

test('leaves absent fields unmapped rather than guessing', () => {
  const mapping = buildMapping(['name', 'sku', 'price'], 'generic');
  assert.equal(mapping.supplier, null);
  assert.equal(mapping.image_url, null);
});

test('falls back to generic synonyms for gaps in a vendor preset', () => {
  // A Shopify export that also carries a reorder column the preset does not list.
  const mapping = buildMapping([...SHOPIFY, 'Reorder Point'], 'shopify');
  assert.equal(mapping.reorder_point, 'Reorder Point');
});

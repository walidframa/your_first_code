import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDigit,
  codeFor,
  detectFormat,
  hasSuspectCheckDigit,
  isValidEan13,
  isValidEan8,
  isValidUpcA,
} from '../src/lib/barcode.js';

test('computes the EAN-13 check digit', () => {
  // Published examples: the check digit is the last character of each.
  assert.equal(checkDigit('400638133393'), 1, '4006381333931');
  assert.equal(checkDigit('978020137962'), 4, '9780201379624');
  assert.equal(checkDigit('501234500001'), 5);
});

test('computes the EAN-8 and UPC-A check digits', () => {
  assert.equal(checkDigit('9638507'), 4, '96385074');
  assert.equal(checkDigit('03600029145'), 2, '036000291452');
});

test('validates EAN-13', () => {
  assert.ok(isValidEan13('4006381333931'));
  assert.ok(isValidEan13('5012345000015'));
  assert.ok(!isValidEan13('5012345000011'), 'wrong check digit');
  assert.ok(!isValidEan13('501234500001'), 'too short');
  assert.ok(!isValidEan13('50123450000155'), 'too long');
  assert.ok(!isValidEan13('50123450000A5'), 'not all digits');
  assert.ok(!isValidEan13(null));
});

test('validates EAN-8 and UPC-A', () => {
  assert.ok(isValidEan8('96385074'));
  assert.ok(!isValidEan8('96385071'));
  assert.ok(isValidUpcA('036000291452'));
  assert.ok(!isValidUpcA('036000291453'));
});

test('detects the right symbology', () => {
  assert.equal(detectFormat('4006381333931'), 'EAN13');
  assert.equal(detectFormat('036000291452'), 'UPC');
  assert.equal(detectFormat('96385074'), 'EAN8');
});

test('falls back to Code 128 for anything else', () => {
  assert.equal(detectFormat('BAK-002'), 'CODE128', 'an internal SKU still prints');
  assert.equal(detectFormat('5012345000011'), 'CODE128', 'a bad check digit is not silently treated as EAN-13');
  assert.equal(detectFormat('12345'), 'CODE128');
});

test('has nothing to encode for an empty code', () => {
  assert.equal(detectFormat(''), null);
  assert.equal(detectFormat('   '), null);
  assert.equal(detectFormat(null), null);
  assert.equal(detectFormat(undefined), null);
});

test('labels a product by barcode, falling back to SKU', () => {
  assert.equal(codeFor({ barcode: '5012345000015', sku: 'BEV-001' }), '5012345000015');
  assert.equal(codeFor({ barcode: '', sku: 'BEV-001' }), 'BEV-001');
  assert.equal(codeFor({ barcode: null, sku: 'BEV-001' }), 'BEV-001');
  assert.equal(codeFor({ barcode: null, sku: null }), null);
  assert.equal(codeFor(null), null);
});

test('flags a retail-length code whose check digit is wrong', () => {
  assert.ok(hasSuspectCheckDigit('5012345000011'), 'looks like an EAN-13 but is not');
  assert.ok(!hasSuspectCheckDigit('5012345000015'), 'valid, so not suspect');
  assert.ok(!hasSuspectCheckDigit('BAK-002'), 'a SKU is not pretending to be a barcode');
  assert.ok(!hasSuspectCheckDigit('12345'), 'not a retail length');
});

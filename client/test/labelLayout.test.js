import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOM_LIMITS, LABEL_SIZES, customSize, deriveLayout, perSheet } from '../src/lib/labelLayout.js';

const PX_PER_MM = 96 / 25.4;
const PT_PER_MM = 72 / 25.4;

/**
 * The tallest the label's contents can be, in millimetres: the name (one or
 * two lines at 1.1 line-height), the price, the pounds price, the barcode, the
 * gap under it and the code number. Anything over the label's height minus its
 * padding is clipped on the printed label.
 */
function contentHeightMm(size) {
  return (
    (size.namePt * 1.1 * size.nameLines) / PT_PER_MM +
    size.pricePt / PT_PER_MM +
    size.subPt / PT_PER_MM +
    size.barcodeHeight / PX_PER_MM +
    0.3 +
    size.codePt / PT_PER_MM
  );
}

test('every preset fits its own contents', () => {
  for (const size of Object.values(LABEL_SIZES)) {
    const available = size.height - 2 * size.padding;
    assert.ok(
      contentHeightMm(size) <= available,
      `${size.label}: contents ${contentHeightMm(size).toFixed(2)}mm exceed ${available.toFixed(2)}mm`,
    );
  }
});

test('the 40 × 20 mm preset the shop actually uses is exact', () => {
  const size = LABEL_SIZES.tiny;
  assert.equal(size.width, 40);
  assert.equal(size.height, 20);
  // Under 24mm there is only room for one line of product name.
  assert.equal(size.nameLines, 1);
});

test('an EAN-13 spans most of the label without overflowing it', () => {
  for (const size of Object.values(LABEL_SIZES)) {
    const usable = size.width - 2 * size.padding;
    const barcodeMm = (95 * size.barWidth) / PX_PER_MM;
    assert.ok(barcodeMm <= usable + 0.01, `${size.label}: barcode ${barcodeMm.toFixed(2)}mm over ${usable}mm`);
    // A barcode narrower than half the label wastes the scannable area.
    assert.ok(barcodeMm >= usable / 2, `${size.label}: barcode only ${barcodeMm.toFixed(2)}mm of ${usable}mm`);
  }
});

test('type sizes stay within legible bounds at both extremes', () => {
  const smallest = deriveLayout(CUSTOM_LIMITS.minWidth, CUSTOM_LIMITS.minHeight);
  const largest = deriveLayout(CUSTOM_LIMITS.maxWidth, CUSTOM_LIMITS.maxHeight);

  assert.ok(smallest.namePt >= 4.5 && smallest.codePt >= 3.5);
  assert.ok(largest.namePt <= 9 && largest.pricePt <= 14 && largest.barcodeHeight <= 44);
  // Bars never go below the width a thermal printer can hold.
  assert.ok(smallest.barWidth >= 0.8);
});

test('a custom size is laid out exactly like a preset of the same dimensions', () => {
  const { key, label, ...customGeometry } = customSize('40', '20');
  const { key: _key, label: _label, ...presetGeometry } = LABEL_SIZES.tiny;
  assert.deepEqual(customGeometry, presetGeometry);
  assert.equal(key, 'custom');
  assert.equal(label, '40 × 20 mm');
});

test('a custom size outside the printable range is rejected', () => {
  assert.equal(customSize('', '20'), null);
  assert.equal(customSize('abc', '20'), null);
  assert.equal(customSize('9', '20'), null);
  assert.equal(customSize('40', '7'), null);
  assert.equal(customSize('211', '20'), null);
  assert.equal(customSize('40', '298'), null);
  assert.notEqual(customSize('10', '8'), null);
  assert.notEqual(customSize('210', '297'), null);
});

test('A4 sheet capacity leaves room for the gap between labels', () => {
  // 5 across (40+2 fits 4 times into 198) and 12 down (20+2 into 285).
  assert.equal(LABEL_SIZES.tiny.perRow, 4);
  assert.equal(perSheet(LABEL_SIZES.tiny), 4 * 12);

  for (const size of Object.values(LABEL_SIZES)) {
    assert.ok(size.perRow * (size.width + 2) <= 198 + 2, `${size.label} overruns the A4 width`);
    assert.ok(perSheet(size) >= 1);
  }
});

test('a label wider than the page still yields one per row', () => {
  assert.equal(deriveLayout(200, 100).perRow, 1);
  assert.equal(perSheet(deriveLayout(200, 290)), 1);
});

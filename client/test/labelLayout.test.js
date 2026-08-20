import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_LIMITS,
  DEFAULT_STYLE,
  LABEL_PARTS,
  LABEL_SIZES,
  SCALE_LIMITS,
  contentHeightMm,
  customSize,
  deriveLayout,
  normaliseStyle,
  overflows,
  perSheet,
  styleLayout,
} from '../src/lib/labelLayout.js';

const PX_PER_MM = 96 / 25.4;

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

/* ------------------------------------------------ the shop's own design */

test('a style with nothing in it is the built-in design', () => {
  assert.deepEqual(normaliseStyle(undefined), DEFAULT_STYLE);
  assert.deepEqual(normaliseStyle(null), DEFAULT_STYLE);
  assert.deepEqual(normaliseStyle('not an object'), DEFAULT_STYLE);
  // Every part the screen offers has a field behind it, or a checkbox would
  // toggle something nothing reads.
  for (const [key] of LABEL_PARTS) assert.ok(key in DEFAULT_STYLE, `${key} has no field`);
});

test('a size out of range is brought back rather than believed', () => {
  const wild = normaliseStyle({ nameScale: 40, priceScale: 0, width: 9000, height: -3 });
  assert.equal(wild.nameScale, SCALE_LIMITS.max);
  assert.equal(wild.priceScale, SCALE_LIMITS.min);
  assert.equal(wild.width, CUSTOM_LIMITS.maxWidth);
  assert.equal(wild.height, CUSTOM_LIMITS.minHeight);
  // And a mode nobody prints on is not a mode.
  assert.equal(normaliseStyle({ mode: 'carrier pigeon' }).mode, DEFAULT_STYLE.mode);
  assert.equal(normaliseStyle({ mode: 'roll' }).mode, 'roll');
});

test('a part turned off stops taking up room on the label', () => {
  const plain = styleLayout(LABEL_SIZES.tiny, DEFAULT_STYLE);
  const bare = styleLayout(LABEL_SIZES.tiny, { ...DEFAULT_STYLE, name: false, lbp: false });
  assert.ok(contentHeightMm(bare) < contentHeightMm(plain));

  // And the shop's name on top costs a line rather than being free.
  const headed = styleLayout(LABEL_SIZES.tiny, { ...DEFAULT_STYLE, shop: true });
  assert.ok(contentHeightMm(headed) > contentHeightMm(plain));
});

test('the built-in design fits every preset, and a doubled one is called out', () => {
  for (const size of Object.values(LABEL_SIZES)) {
    assert.ok(!overflows(styleLayout(size, DEFAULT_STYLE)), `${size.label} clips as it comes`);
  }
  // Which is the point of the warning: the shop is allowed to ask for this,
  // and is told what it costs rather than quietly printing half a barcode.
  const doubled = { ...DEFAULT_STYLE, nameScale: 2, priceScale: 2, barcodeScale: 2 };
  assert.ok(overflows(styleLayout(LABEL_SIZES.tiny, doubled)));
});

test('a style scales what the size worked out rather than replacing it', () => {
  const base = LABEL_SIZES.thermal;
  const bigger = styleLayout(base, { ...DEFAULT_STYLE, priceScale: 1.5 });
  assert.equal(bigger.pricePt, base.pricePt * 1.5);
  // Everything it did not touch is left exactly as derived.
  assert.equal(bigger.namePt, base.namePt);
  assert.equal(bigger.barWidth, base.barWidth);
  assert.equal(bigger.width, base.width);
});

/**
 * Reading back what this app prints.
 *
 * The decoder is checked against the encoder the label sheet already uses —
 * JsBarcode — rather than against patterns typed in beside it, so a slip in
 * either table shows up as a code that will not read. Every barcode here is
 * built by the encoder, painted into a picture the way a camera would see it,
 * and handed to the decoder with nothing in between.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CODE128_PATTERNS, decodeImage, decodeRow, rowToRuns } from '../src/lib/barcodeRead.js';

const require = createRequire(import.meta.url);
const { BARS } = require('jsbarcode/bin/barcodes/CODE128/constants.js');
const encoders = require('jsbarcode/bin/barcodes/index.js').default;

/** The binary the encoder would print for this value. */
function encode(kind, value) {
  const encoder = new encoders[kind](String(value), { flat: true });
  const result = encoder.encode();
  return result.data;
}

/**
 * A picture of that binary, the way a camera sees one: a band of bars with
 * quiet paper either side, and grey rather than pure black and white.
 */
function paint(binary, { module = 3, width = null, height = 40, dark = 40, light = 210 } = {}) {
  const quiet = module * 10;
  const w = width || binary.length * module + quiet * 2;
  const data = new Uint8ClampedArray(w * height * 4).fill(255);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const at = Math.floor((x - quiet) / module);
      const on = at >= 0 && at < binary.length && binary[at] === '1';
      const value = on ? dark : light;
      const p = (y * w + x) * 4;
      data[p] = value;
      data[p + 1] = value;
      data[p + 2] = value;
      data[p + 3] = 255;
    }
  }
  return { data, width: w, height };
}

/* ------------------------------------------------------------- the tables */

test('the Code 128 patterns are the ones the encoder prints', () => {
  // Derived from the encoder's own table, so a transcription slip cannot ship.
  const widths = BARS.map((n) => {
    const bits = String(n);
    let out = '';
    let run = 1;
    for (let i = 1; i <= bits.length; i += 1) {
      if (bits[i] === bits[i - 1]) run += 1;
      else {
        out += run;
        run = 1;
      }
    }
    return out;
  });

  assert.deepEqual(CODE128_PATTERNS, widths, 'the decoder reads what the printer writes');
});

/* ------------------------------------------------------------------ EAN */

test('an EAN-13 reads back exactly as it was printed', () => {
  const code = '5901234123457';
  const picture = paint(encode('EAN13', code.slice(0, 12)));
  assert.equal(decodeImage(picture), code);
});

test('an EAN-8 reads back', () => {
  const picture = paint(encode('EAN8', '9638507'));
  assert.equal(decodeImage(picture), '96385074');
});

test('a UPC-A comes back as the twelve digits on the box', () => {
  // Not as the thirteen an EAN-13 decoder would produce: a shop's catalogue
  // holds what is printed, and the extra zero would find no product.
  const picture = paint(encode('UPC', '03600029145'));
  assert.equal(decodeImage(picture), '036000291452');
});

test('a code held upside down is the same code', () => {
  const code = '5901234123457';
  const picture = paint(encode('EAN13', code.slice(0, 12)));

  // Mirror every row, which is what the camera sees of a label turned round.
  const flipped = { ...picture, data: new Uint8ClampedArray(picture.data.length) };
  for (let y = 0; y < picture.height; y += 1) {
    for (let x = 0; x < picture.width; x += 1) {
      const from = (y * picture.width + (picture.width - 1 - x)) * 4;
      const to = (y * picture.width + x) * 4;
      for (let c = 0; c < 4; c += 1) flipped.data[to + c] = picture.data[from + c];
    }
  }
  assert.equal(decodeImage(flipped), code);
});

/* -------------------------------------------------------------- Code 128 */

test('a Code 128 label reads back, letters and all', () => {
  const value = 'CARD-ALFA-WHOLE-379';
  const picture = paint(encode('CODE128B', value));
  assert.equal(decodeImage(picture), value);
});

test('and one the encoder packs into set C', () => {
  // A long number is encoded two digits to a symbol, which is a different path
  // through the decoder entirely.
  const value = '12345678901234';
  const picture = paint(encode('CODE128', value));
  assert.equal(decodeImage(picture), value);
});

test('a mixed label with letters and digits survives the set switches', () => {
  const value = 'SKU-9912-x';
  const picture = paint(encode('CODE128', value));
  assert.equal(decodeImage(picture), value);
});

/* ------------------------------------------------- what a camera hands over */

test('a small, dim, low-contrast picture still reads', () => {
  // One pixel per module, a grey card under a shop light: the ratios are all
  // that matter, and this is the size a phone at arm's length produces.
  const picture = paint(encode('EAN13', '590123412345'), { module: 1, dark: 90, light: 150 });
  assert.equal(decodeImage(picture), '5901234123457');
});

test('a blank wall is not a barcode', () => {
  const flat = new Uint8Array(400).fill(200);
  assert.equal(rowToRuns(flat), null);
  assert.equal(decodeRow(flat), null);
});

test('noise is not a barcode', () => {
  // A run of alternating pixels has plenty of contrast and no meaning; the
  // check digit is what stops it being read as a product.
  const noise = new Uint8Array(600);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 37) % 255;
  assert.equal(decodeRow(noise), null);
});

test('a code somewhere other than the middle of the frame is found', () => {
  // The band sits in the top third, which is where a phone held over a shelf
  // puts it as often as not.
  const bars = paint(encode('EAN13', '590123412345'), { height: 20 });
  const tall = { data: new Uint8ClampedArray(bars.width * 90 * 4).fill(255), width: bars.width, height: 90 };
  tall.data.set(bars.data, bars.width * 12 * 4);
  assert.equal(decodeImage(tall), '5901234123457');
});

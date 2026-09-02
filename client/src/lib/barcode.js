/**
 * Barcode symbology detection.
 *
 * The rendering itself is done by JsBarcode — a wrong barcode scans as the
 * wrong product, so that is not somewhere to hand-roll an implementation. What
 * we do decide here is *which* symbology a given code is, because JsBarcode
 * throws rather than guessing, and real catalogues contain a mixture: proper
 * EAN-13s, shorter EAN-8s, US UPC-A codes, internal SKUs, and codes with a
 * mistyped check digit.
 *
 * Anything that is not a valid fixed-length retail code falls back to Code 128,
 * which encodes arbitrary text — so a label always prints something scannable.
 */

const digitsOnly = (value) => /^\d+$/.test(value);

/** Modulo-10 check digit used by EAN-13, EAN-8 and UPC-A. */
export function checkDigit(digits) {
  // Weights alternate 3/1 from the right, regardless of overall length.
  let sum = 0;
  for (let i = digits.length - 1, weight = 3; i >= 0; i -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(digits[i]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

function hasValidCheckDigit(code) {
  return checkDigit(code.slice(0, -1)) === Number(code[code.length - 1]);
}

export function isValidEan13(code) {
  return typeof code === 'string' && code.length === 13 && digitsOnly(code) && hasValidCheckDigit(code);
}

export function isValidEan8(code) {
  return typeof code === 'string' && code.length === 8 && digitsOnly(code) && hasValidCheckDigit(code);
}

export function isValidUpcA(code) {
  return typeof code === 'string' && code.length === 12 && digitsOnly(code) && hasValidCheckDigit(code);
}

/**
 * Pick the symbology for `code`, or null if there is nothing to encode.
 * Falls back to CODE128 so an internal SKU still produces a usable label.
 */
export function detectFormat(code) {
  const value = String(code ?? '').trim();
  if (!value) return null;
  if (isValidEan13(value)) return 'EAN13';
  if (isValidUpcA(value)) return 'UPC';
  if (isValidEan8(value)) return 'EAN8';
  return 'CODE128';
}

/**
 * True when a search term is a number off a box rather than a name typed in.
 *
 * The question this answers is what to do when a scan finds nothing. The
 * search box is one box for both jobs — a name to look up, a code fired at it
 * by a reader — and until now everything that missed became a *name*, so
 * scanning an unknown box opened "New product" called `6291100097614` and the
 * barcode field, the one field that number belongs in, was left empty.
 *
 * Length rather than a check digit: an eight-digit-or-longer run of digits is
 * a code by any reasonable reading, while plenty of real labels — a
 * distributor's own, anything this shop printed for loose stock — carry no
 * valid EAN check digit at all and would be thrown back into the name.
 */
export function looksScanned(text) {
  const value = String(text ?? '').trim();
  return digitsOnly(value) && value.length >= 8;
}

/**
 * What to encode on a product's label: its barcode if it has one, otherwise
 * its SKU, so every product can be labelled.
 */
export function codeFor(product) {
  const value = String(product?.barcode || '').trim() || String(product?.sku || '').trim();
  return value || null;
}

/**
 * True when a code looks like a retail barcode but its check digit is wrong —
 * usually a typo. It will still print as Code 128, but a scanner expecting
 * EAN-13 will not read it as intended, so it is worth flagging.
 */
export function hasSuspectCheckDigit(code) {
  const value = String(code ?? '').trim();
  if (!digitsOnly(value)) return false;
  if (![8, 12, 13].includes(value.length)) return false;
  return !hasValidCheckDigit(value);
}

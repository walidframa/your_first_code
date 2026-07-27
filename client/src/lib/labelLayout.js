/**
 * Label geometry.
 *
 * Everything about how a label is laid out — type sizes, barcode height, how
 * many fit across an A4 sheet — is derived from its millimetre dimensions
 * rather than fixed per preset. That way a size the user types in, 40 × 20 mm
 * say, is laid out as sensibly as a built-in one.
 *
 * Kept free of JSX so it can be unit-tested directly.
 */

const A4_PRINTABLE_WIDTH_MM = 198; // A4 width less the 6mm margins each side

/** Bars are measured in CSS pixels; labels are measured in millimetres. */
const PX_PER_MM = 96 / 25.4;

/** Modules in an EAN-13 symbol, guard patterns included. */
const EAN13_MODULES = 95;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export function deriveLayout(width, height) {
  // Below this there is no room for a second line of product name.
  const tight = height < 24;
  const padding = tight ? 1 : 1.5;

  return {
    width,
    height,
    padding,
    nameLines: tight ? 1 : 2,
    perRow: Math.max(1, Math.floor(A4_PRINTABLE_WIDTH_MM / (width + 2))),
    namePt: clamp(height * 0.3, 4.5, 9),
    pricePt: clamp(height * 0.42, 7.5, 14),
    subPt: clamp(height * 0.2, 4, 8),
    codePt: clamp(height * 0.18, 3.5, 7),
    // JsBarcode heights are CSS pixels; the label's mm box scales them down.
    barcodeHeight: clamp(height * 1.1, 12, 44),
    /*
     * Bar width is chosen so an EAN-13 roughly fills the label: wider bars are
     * more tolerant of a cheap scanner and a rough print. A longer Code 128
     * overflows this and is scaled down by max-width, which is the safe
     * direction to be wrong in.
     */
    barWidth: clamp(((width - 2 * padding) * PX_PER_MM) / EAN13_MODULES, 0.8, 2.2),
  };
}

const preset = (key, label, width, height) => ({ key, label, ...deriveLayout(width, height) });

/** Common sheet and roll stock. Any other size can be entered by hand. */
export const LABEL_SIZES = {
  tiny: preset('tiny', '40 × 20 mm', 40, 20),
  small: preset('small', '38 × 21 mm', 38, 21.2),
  thermal: preset('thermal', '50 × 30 mm', 50, 30),
  medium: preset('medium', '63.5 × 34 mm', 63.5, 33.9),
  large: preset('large', '70 × 42 mm', 70, 42),
};

export const CUSTOM_LIMITS = { minWidth: 10, maxWidth: 210, minHeight: 8, maxHeight: 297 };

/**
 * A size the user typed in, laid out by the same rules as a preset. Returns
 * null while the entry is unusable so the caller can hold the previous preview
 * rather than blanking out mid-keystroke.
 */
export function customSize(width, height) {
  const w = Number(width);
  const h = Number(height);
  const { minWidth, maxWidth, minHeight, maxHeight } = CUSTOM_LIMITS;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w < minWidth || w > maxWidth || h < minHeight || h > maxHeight) return null;
  return { key: 'custom', label: `${w} × ${h} mm`, ...deriveLayout(w, h) };
}

/** How many labels of this size fit on one A4 sheet. */
export function perSheet(size) {
  return size.perRow * Math.max(1, Math.floor(285 / (size.height + 2)));
}

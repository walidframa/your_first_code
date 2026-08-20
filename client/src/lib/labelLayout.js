/**
 * Label geometry.
 *
 * Everything about how a label is laid out — type sizes, barcode height, how
 * many fit across an A4 sheet — is derived from its millimetre dimensions
 * rather than fixed per preset. That way a size the user types in, 40 × 20 mm
 * say, is laid out as sensibly as a built-in one.
 *
 * On top of that sits the shop's own style: which lines print, and how big
 * each one is relative to what the size worked out. The derived figures are
 * the starting point rather than the law — a shop that wants the price twice
 * the size and no pounds line underneath knows its own labels better than a
 * formula does. What the formula still does is say when the result no longer
 * fits, which is `overflows()` below.
 *
 * Kept free of JSX so it can be unit-tested directly.
 */

const A4_PRINTABLE_WIDTH_MM = 198; // A4 width less the 6mm margins each side

/** Bars are measured in CSS pixels; labels are measured in millimetres. */
const PX_PER_MM = 96 / 25.4;
const PT_PER_MM = 72 / 25.4;

/** Modules in an EAN-13 symbol, guard patterns included. */
const EAN13_MODULES = 95;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** The width and height a label may be given, in millimetres. */
export const CUSTOM_LIMITS = { minWidth: 10, maxWidth: 210, minHeight: 8, maxHeight: 297 };

/** Every part of a label that can be turned off, and the order it prints in. */
export const LABEL_PARTS = [
  ['shop', 'Shop name'],
  ['name', 'Product name'],
  ['price', 'Price in dollars'],
  ['lbp', 'Price in pounds'],
  ['barcode', 'Barcode'],
  ['code', 'The number under it'],
];

/**
 * How far each part can be pushed from the size it was given.
 *
 * Half to double: enough to fix a label that reads badly, not enough to turn a
 * 40mm label into something a scanner cannot find the bars on.
 */
export const SCALE_LIMITS = { min: 0.5, max: 2 };

/**
 * The shop's own label design, as it is saved and read back.
 *
 * The size and the stock it prints on live in here beside the parts, because
 * they are the same decision made on the same screen: a shop with a roll of
 * 40 × 20 labels wants that to be what comes up, not to pick it every time.
 */
export const DEFAULT_STYLE = {
  width: 40,
  height: 20,
  mode: 'sheet',
  // The shop's name across the top is off by default: on a 20mm label it costs
  // a line the product name needs, and most shops label for the scanner.
  shop: false,
  name: true,
  price: true,
  lbp: true,
  barcode: true,
  code: true,
  shopScale: 1,
  nameScale: 1,
  priceScale: 1,
  lbpScale: 1,
  barcodeScale: 1,
  codeScale: 1,
};

const SCALE_KEYS = ['shopScale', 'nameScale', 'priceScale', 'lbpScale', 'barcodeScale', 'codeScale'];
const FLAG_KEYS = LABEL_PARTS.map(([key]) => key);

/**
 * A style with every field present and in range, whatever arrived.
 *
 * Called on anything read back from the settings table as well as on what the
 * screen holds: a shop that upgrades gets the new fields defaulted rather than
 * a label with three undefined sizes on it.
 */
export function normaliseStyle(style) {
  const raw = style && typeof style === 'object' ? style : {};
  const out = { ...DEFAULT_STYLE };

  for (const key of FLAG_KEYS) {
    if (raw[key] !== undefined) out[key] = raw[key] === true || raw[key] === 'true';
  }
  for (const key of SCALE_KEYS) {
    const n = Number(raw[key]);
    if (Number.isFinite(n)) out[key] = clamp(n, SCALE_LIMITS.min, SCALE_LIMITS.max);
  }

  const w = Number(raw.width);
  const h = Number(raw.height);
  const { minWidth, maxWidth, minHeight, maxHeight } = CUSTOM_LIMITS;
  if (Number.isFinite(w)) out.width = clamp(w, minWidth, maxWidth);
  if (Number.isFinite(h)) out.height = clamp(h, minHeight, maxHeight);
  if (raw.mode === 'roll' || raw.mode === 'sheet') out.mode = raw.mode;

  return out;
}

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
    // Smaller than the product name: it is the same on every label in the shop,
    // so it is there to be recognised rather than read.
    shopPt: clamp(height * 0.22, 4, 8),
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
    style: { ...DEFAULT_STYLE, width, height },
  };
}

/**
 * The same size with the shop's style applied.
 *
 * Scales multiply the derived sizes rather than replacing them, so a style set
 * on a 40 × 20 label still reads sensibly when the same shop prints a 70 × 42
 * one. Nothing is re-clamped afterwards: a shop that asks for a price at twice
 * the size means it, and `overflows()` is what tells them the cost.
 */
export function styleLayout(size, style) {
  const s = normaliseStyle(style);
  return {
    ...size,
    shopPt: size.shopPt * s.shopScale,
    namePt: size.namePt * s.nameScale,
    pricePt: size.pricePt * s.priceScale,
    subPt: size.subPt * s.lbpScale,
    codePt: size.codePt * s.codeScale,
    barcodeHeight: size.barcodeHeight * s.barcodeScale,
    style: s,
  };
}

/**
 * How tall the contents stand, in millimetres.
 *
 * Every line that prints, at the size it prints, plus the hair of space under
 * the bars. Anything over the label's height less its padding is clipped by
 * the printer, so this is what the screen warns on and what the presets are
 * checked against.
 */
export function contentHeightMm(size) {
  const on = normaliseStyle(size.style);
  let mm = 0;
  if (on.shop) mm += (size.shopPt * 1.1) / PT_PER_MM;
  if (on.name) mm += (size.namePt * 1.1 * size.nameLines) / PT_PER_MM;
  if (on.price) mm += size.pricePt / PT_PER_MM;
  if (on.lbp) mm += size.subPt / PT_PER_MM;
  if (on.barcode) mm += size.barcodeHeight / PX_PER_MM + 0.3;
  if (on.code) mm += size.codePt / PT_PER_MM;
  return mm;
}

/** True when the contents no longer fit the label and will print clipped. */
export function overflows(size) {
  return contentHeightMm(size) > size.height - 2 * size.padding + 0.01;
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

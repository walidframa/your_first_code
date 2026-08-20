/**
 * The shop's label design, as the settings table can hold it.
 *
 * One JSON string rather than a dozen keys: which lines a label prints and how
 * big each one is, is a single decision made on one screen, and adding a
 * seventh part later should not need a migration.
 *
 * It is checked here rather than trusted from the browser for the ordinary
 * reason — this is served on every page load, and the browser is not the only
 * thing that can PUT to a settings route. The rules match the client's
 * `normaliseStyle`: unknown keys dropped, sizes clamped to half-to-double.
 */

/** Every part of a label that can be turned off. */
export const LABEL_PARTS = ['shop', 'name', 'price', 'lbp', 'barcode', 'code'];

/** How far each part can be pushed from the size the label worked out. */
export const SCALE_LIMITS = { min: 0.5, max: 2 };

export const LABEL_SCALES = [
  'shopScale',
  'nameScale',
  'priceScale',
  'lbpScale',
  'barcodeScale',
  'codeScale',
];

/** The width and height a label may be given, in millimetres. */
export const SIZE_LIMITS = { minWidth: 10, maxWidth: 210, minHeight: 8, maxHeight: 297 };

export const DEFAULT_LABEL_STYLE = {
  // The size and the stock it prints on, because they are the same decision
  // made on the same screen as the parts below.
  width: 40,
  height: 20,
  mode: 'sheet',
  // Off by default: on a 20mm label the shop's name costs a line the product
  // name needs, and most shops label for the scanner.
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

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

/**
 * A style with every field present and in range, whatever arrived.
 *
 * Takes the stored string or an object, and never throws: a settings row
 * somebody edited by hand into nonsense gives the default label back rather
 * than an unprintable one.
 */
export function normaliseLabelStyle(input) {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_LABEL_STYLE };

  const out = { ...DEFAULT_LABEL_STYLE };
  for (const key of LABEL_PARTS) {
    if (raw[key] !== undefined) out[key] = raw[key] === true || raw[key] === 'true';
  }
  for (const key of LABEL_SCALES) {
    const n = Number(raw[key]);
    if (Number.isFinite(n)) out[key] = clamp(n, SCALE_LIMITS.min, SCALE_LIMITS.max);
  }

  const w = Number(raw.width);
  const h = Number(raw.height);
  if (Number.isFinite(w)) out.width = clamp(w, SIZE_LIMITS.minWidth, SIZE_LIMITS.maxWidth);
  if (Number.isFinite(h)) out.height = clamp(h, SIZE_LIMITS.minHeight, SIZE_LIMITS.maxHeight);
  if (raw.mode === 'roll' || raw.mode === 'sheet') out.mode = raw.mode;

  return out;
}

/**
 * What actually goes in the settings row: normalised, and always the same keys
 * in the same order, so a saved style that changed nothing is byte-identical
 * to the one before it.
 */
export function serialiseLabelStyle(input) {
  return JSON.stringify(normaliseLabelStyle(input));
}

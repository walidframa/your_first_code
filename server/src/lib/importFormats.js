/**
 * Column mapping for product imports from other retail/ERP systems.
 *
 * Each preset lists, per canonical field, the source headers it may appear under.
 * Matching is case- and punctuation-insensitive; `prefix` entries match headers
 * that merely start with the token (Square emits per-location columns such as
 * "Current Quantity Downtown").
 */

export const CANONICAL_FIELDS = [
  { key: 'name', label: 'Product name', required: true },
  { key: 'sku', label: 'SKU', required: true },
  { key: 'price', label: 'Price', required: true },
  { key: 'cost', label: 'Cost', required: false },
  { key: 'stock', label: 'Stock on hand', required: false },
  { key: 'category', label: 'Category', required: false },
  { key: 'barcode', label: 'Barcode / UPC', required: false },
  { key: 'supplier', label: 'Supplier / vendor', required: false },
  { key: 'image_url', label: 'Image URL', required: false },
  { key: 'reorder_point', label: 'Reorder point', required: false },
  /*
   * The number stamped on a phone.
   *
   * Mapping it changes what the file *is*: one row per handset rather than one
   * row per product, and the quantity column stops meaning anything because a
   * serialised product's stock is the count of the phones booked into it. See
   * lib/importUnits.js.
   */
  { key: 'imei', label: 'IMEI / serial number', required: false },
  /*
   * Which currency the price column is in.
   *
   * A Lebanese system exports a mixed list — most lines in dollars and a
   * handful in pounds, with a column saying which. Without reading it, a
   * 300,000 LL cable is imported as a $300,000 cable, and nobody notices until
   * it is scanned at the till. Left unmapped, everything is taken as dollars,
   * which is what a file with no such column means.
   */
  { key: 'currency', label: 'Price currency', required: false },
  { key: 'cost_currency', label: 'Cost currency', required: false },
];

const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const PRESETS = {
  shopify: {
    label: 'Shopify product CSV',
    signature: ['Handle', 'Variant SKU', 'Variant Price'],
    fields: {
      name: ['Title'],
      sku: ['Variant SKU'],
      price: ['Variant Price'],
      cost: ['Cost per item'],
      stock: ['Variant Inventory Qty'],
      category: ['Type', 'Product Category'],
      barcode: ['Variant Barcode'],
      supplier: ['Vendor'],
      image_url: ['Image Src'],
    },
  },
  square: {
    label: 'Square catalog CSV',
    signature: ['Item Name', 'Reporting Category', 'Token'],
    fields: {
      name: ['Item Name'],
      sku: ['SKU'],
      price: ['Price'],
      cost: ['Default Unit Cost', 'Unit Cost'],
      stock: [{ prefix: 'Current Quantity' }, { prefix: 'New Quantity' }],
      category: ['Category', 'Reporting Category'],
      barcode: ['GTIN'],
      supplier: ['Vendor Name', 'Vendor'],
      image_url: [],
    },
  },
  lightspeed: {
    label: 'Lightspeed Retail CSV',
    signature: ['System ID', 'Custom SKU', 'Default Cost'],
    fields: {
      name: ['Description', 'Item Description'],
      sku: ['Custom SKU', 'Manufacturer SKU'],
      price: ['Price', 'Default Price'],
      cost: ['Default Cost', 'Average Cost'],
      stock: ['Qty', 'Quantity On Hand'],
      category: ['Category'],
      barcode: ['UPC', 'EAN'],
      supplier: ['Brand', 'Vendor'],
      image_url: [],
    },
  },
  /*
   * The item list a Lebanese shop's existing till exports.
   *
   * Distinctive because it prices in three tiers with a currency column beside
   * each — "Price 1 / Currency 1", "Price 2 / Currency 2" — and because the
   * currency genuinely varies down the column: most lines in dollars, a handful
   * in pounds. Only the first tier is taken; the others are wholesale and
   * promotional prices the register has no use for.
   *
   * The item number is the SKU rather than the barcode: it is the shop's own
   * reference and the one thing guaranteed to be there.
   */
  lebanese_items: {
    label: 'Items export (Price 1 / Currency 1)',
    signature: ['Price 1', 'Currency 1', 'Item'],
    fields: {
      name: ['Item', 'Item name'],
      sku: ['#', 'Item code', 'Code'],
      price: ['Price 1'],
      currency: ['Currency 1'],
      cost: ['Average cost', 'Last cost'],
      cost_currency: ['Currency'],
      stock: ['Qty'],
      category: ['Family'],
      barcode: ['Barcode'],
      supplier: ['Brand', 'Source'],
      image_url: [],
      imei: ['SN', 'Serial', 'IMEI'],
    },
  },
  generic: {
    label: 'Generic CSV',
    signature: [],
    fields: {
      name: ['name', 'product', 'product name', 'title', 'item', 'item name', 'description'],
      sku: ['sku', 'code', 'item code', 'product code', 'article', 'reference', 'ref'],
      price: [
        'price',
        'price 1',
        'retail',
        'retail price',
        'sell price',
        'selling price',
        'unit price',
        'sale price',
        'rrp',
      ],
      cost: [
        'cost',
        'our cost',
        'unit cost',
        'cost price',
        'average cost',
        'last cost',
        'buy price',
        'purchase price',
        'wholesale',
      ],
      stock: ['stock', 'qty', 'quantity', 'on hand', 'stock on hand', 'inventory', 'stock level'],
      category: ['category', 'type', 'department', 'group', 'product type'],
      barcode: ['barcode', 'upc', 'ean', 'gtin', 'isbn'],
      supplier: ['supplier', 'vendor', 'brand', 'manufacturer'],
      image_url: ['image', 'image url', 'image src', 'photo', 'picture'],
      reorder_point: ['reorder point', 'reorder level', 'min stock', 'minimum stock', 'par level'],
      /* `sn` is what a phone shop's export calls it more often than `imei`. */
      imei: ['imei', 'sn', 's/n', 'serial', 'serial number', 'serial no', 'imei1', 'imei 1'],
      currency: ['currency', 'currency 1', 'price currency', 'cur'],
      cost_currency: ['cost currency'],
    },
  },
};

/** Score each preset against the file's headers and return the best match. */
export function detectFormat(headers) {
  const normalized = headers.map(normalize);
  let best = 'generic';
  let bestScore = 0;

  for (const [key, preset] of Object.entries(PRESETS)) {
    if (!preset.signature.length) continue;
    const score = preset.signature.filter((sig) => normalized.includes(normalize(sig))).length;
    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }

  // Require at least two signature hits before claiming a vendor format.
  return bestScore >= 2 ? best : 'generic';
}

function findHeader(headers, candidates) {
  const normalizedHeaders = headers.map((h) => ({ raw: h, norm: normalize(h) }));

  for (const candidate of candidates) {
    if (typeof candidate === 'object' && candidate.prefix) {
      const prefix = normalize(candidate.prefix);
      const hit = normalizedHeaders.find((h) => h.norm.startsWith(prefix));
      if (hit) return hit.raw;
      continue;
    }
    const target = normalize(candidate);
    const hit = normalizedHeaders.find((h) => h.norm === target);
    if (hit) return hit.raw;
  }
  return null;
}

/**
 * Build a canonical-field → source-header mapping. The chosen preset wins;
 * anything it leaves unmapped falls back to the generic synonym list so partial
 * vendor exports still line up.
 */
export function buildMapping(headers, formatKey) {
  const preset = PRESETS[formatKey] || PRESETS.generic;
  const mapping = {};

  for (const field of CANONICAL_FIELDS) {
    const candidates = preset.fields[field.key] || [];
    mapping[field.key] =
      findHeader(headers, candidates) ||
      findHeader(headers, PRESETS.generic.fields[field.key] || []) ||
      null;
  }

  return mapping;
}

/** Parse a money/number cell that may carry currency symbols or thousands separators. */
export function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw)
    .replace(/[^\d.,-]/g, '')
    .trim();
  if (!cleaned) return null;

  let normalized = cleaned;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  if (lastComma > -1 && lastDot > -1) {
    // Whichever separator comes last is the decimal point.
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (lastComma > -1) {
    // A lone comma is a decimal separator only when it looks like one (1,50).
    const decimals = cleaned.length - lastComma - 1;
    normalized = decimals > 0 && decimals <= 2 ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

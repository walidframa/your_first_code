/**
 * The numbers a product answers to.
 *
 * A product rarely has one barcode for long. The box carries the maker's EAN,
 * the distributor sticks their own label over it, the shop prints a third for
 * loose stock, and the same charger turns up from a second supplier with a
 * fourth. Whichever is facing up when the scanner goes off has to find the
 * product — and the way shops work around a one-barcode field is to create a
 * second product, which splits the stock of one thing across two rows and makes
 * every count and every profit figure wrong.
 *
 * Position 0 is the primary: the one printed on a label and sent to Shopify.
 * `products.barcode` is a copy of it, kept in step here and nowhere else, so
 * everything that already reads that column keeps working and the two cannot
 * disagree.
 */
import { db, transaction } from '../db.js';

/**
 * Tidy a scanned or typed code.
 *
 * Scanners commonly append a newline, and a barcode pasted from a spreadsheet
 * arrives wrapped in spaces. Neither is part of the number, and a stored code
 * with a trailing space is a code that will never match a scan again.
 */
export function normaliseBarcode(code) {
  return String(code ?? '').replace(/\s+/g, '').trim();
}

export function barcodesFor(productId) {
  return db
    .prepare('SELECT barcode FROM product_barcodes WHERE product_id = ? ORDER BY position, id')
    .all(productId)
    .map((r) => r.barcode);
}

/** Every product's barcodes at once, keyed by product id — one query for a list. */
export function barcodeMap() {
  const rows = db
    .prepare('SELECT product_id, barcode FROM product_barcodes ORDER BY product_id, position, id')
    .all();
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.product_id)) map.set(row.product_id, []);
    map.get(row.product_id).push(row.barcode);
  }
  return map;
}

/** Which product a scanned code belongs to, if any. */
export function ownerOf(code) {
  const barcode = normaliseBarcode(code);
  if (!barcode) return null;
  return db.prepare('SELECT product_id FROM product_barcodes WHERE barcode = ?').get(barcode)
    ?.product_id ?? null;
}

/**
 * Replace a product's barcodes with exactly this list.
 *
 * Order is meaning: the first is the primary. Duplicates within the list are
 * dropped rather than refused — scanning the same box twice is a slip, not a
 * mistake worth stopping the form for — but a code already on a *different*
 * product is refused by name, because a scan that could mean two things is not
 * a scan.
 *
 * Passing `undefined` leaves the product alone, which is what lets a form that
 * does not know about barcodes save without silently clearing them.
 */
export function setBarcodes(productId, list) {
  if (list === undefined) return barcodesFor(productId);

  const wanted = [];
  for (const raw of list || []) {
    const barcode = normaliseBarcode(raw);
    if (barcode && !wanted.includes(barcode)) wanted.push(barcode);
  }

  const clash = wanted
    .map((barcode) =>
      db
        .prepare(
          `SELECT b.barcode, p.name, p.sku FROM product_barcodes b
           JOIN products p ON p.id = b.product_id
           WHERE b.barcode = ? AND b.product_id <> ?`,
        )
        .get(barcode, productId),
    )
    .find(Boolean);

  if (clash) {
    throw new Error(`${clash.barcode} is already on ${clash.name} (${clash.sku})`);
  }

  return transaction(() => {
    db.prepare('DELETE FROM product_barcodes WHERE product_id = ?').run(productId);
    const insert = db.prepare(
      'INSERT INTO product_barcodes (product_id, barcode, position) VALUES (?, ?, ?)',
    );
    wanted.forEach((barcode, index) => insert.run(productId, barcode, index));

    // The mirror. Written here and only here.
    db.prepare('UPDATE products SET barcode = ? WHERE id = ?').run(wanted[0] ?? null, productId);

    return wanted;
  })();
}

/**
 * What a create or update meant by "barcodes".
 *
 * Callers arrive in three shapes and all three have to keep working: the new
 * form sends `barcodes: [...]`, everything older sends a single `barcode`, and
 * an update that mentions neither means "leave them alone" rather than "remove
 * them all".
 */
export function barcodesFromBody(body, { existing = undefined } = {}) {
  if (Array.isArray(body?.barcodes)) return body.barcodes;
  if (body?.barcode !== undefined) {
    const single = normaliseBarcode(body.barcode);
    if (!single) return [];
    /*
     * A single barcode replaces the primary and leaves the rest: an import or an
     * older screen naming one number should not quietly drop the three the shop
     * added by scanning them.
     */
    const rest = (existing || []).filter((code) => code !== single);
    return [single, ...rest];
  }
  return undefined;
}

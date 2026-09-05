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
 * The product a scanned code or a typed SKU names, if any.
 *
 * Deliberately not limited to products still on sale. This answers "what is
 * this thing in my hand" for a screen about *past* sales, and a charger the
 * shop stopped stocking last year is exactly the sort of thing somebody brings
 * back. Refusing to recognise it would send them away over a flag that has
 * nothing to do with the question.
 */
export function productForCode(code) {
  const typed = String(code ?? '').trim();
  if (!typed) return null;
  return (
    db
      .prepare(
        `SELECT id, name, sku, price FROM products
          WHERE lower(sku) = lower(?)
             OR EXISTS (SELECT 1 FROM product_barcodes b
                         WHERE b.product_id = products.id AND b.barcode = ?)
          LIMIT 1`,
      )
      .get(typed, normaliseBarcode(typed)) || null
  );
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

/**
 * A barcode the shop can print, for stock that arrived without one.
 *
 * Loose stock, a used handset, a repair part out of a drawer: plenty of what a
 * shop sells has no number on it, and the shop has to invent one. Typed by
 * hand that goes wrong in two ways — a number another product already answers
 * to, and a number that is not a valid EAN-13 at all, which prints as a label
 * the shop's own scanner then refuses to believe.
 *
 * **EAN-13 in the in-store range.** GS1 reserves prefix `2` for exactly this:
 * codes that circulate inside one shop and are guaranteed never to collide
 * with a manufacturer's. Starting anywhere else invents a number that some real
 * product in the world already carries.
 *
 * The last digit is the modulo-10 check digit, computed rather than made up.
 * This app's own scanner verifies it before believing a read, so a code without
 * one would scan as nothing at all.
 */
export function generateBarcode() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let body = '2';
    for (let i = 0; i < 11; i += 1) body += Math.floor(Math.random() * 10);

    const code = body + eanCheckDigit(body);
    // Unique across every product, not merely unused as a primary: the whole
    // point of a generated number is that scanning it can only mean one thing.
    if (!db.prepare('SELECT 1 FROM product_barcodes WHERE barcode = ?').get(code)) return code;
  }
  // A trillion codes in the range and fifty draws all taken is not bad luck,
  // it is a broken assumption — say so rather than returning a duplicate.
  throw new Error('Could not find a free barcode');
}

/** The modulo-10 check digit for the first twelve digits of an EAN-13. */
export function eanCheckDigit(twelve) {
  let sum = 0;
  for (let i = 0; i < twelve.length; i += 1) {
    sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}

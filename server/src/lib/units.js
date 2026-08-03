/**
 * Individually identified stock — handsets, not quantities.
 *
 * The one rule everything here exists to keep: for a product with
 * `tracks_units`, `products.stock` is the number of its units the shop can
 * still sell. Nothing may change one without the other, or the register will
 * offer a phone that is already in somebody's pocket.
 *
 * Every caller runs inside `transaction()` from the route, so these functions
 * write freely and let the caller roll back.
 */

import { db } from '../db.js';

export const UNIT_CONDITIONS = ['new', 'used', 'refurbished'];
export const UNIT_STATUSES = ['in_stock', 'sold', 'returned', 'scrapped'];

/**
 * Digits only, uppercased.
 *
 * IMEIs get read off a box by eye and typed in a hurry, so spaces and dashes
 * arrive with them. Serials for other kit can carry letters, so this only
 * strips separators rather than insisting on 15 digits — a shop selling
 * chargers alongside phones should not be told its serial is malformed.
 */
export function normaliseImei(value) {
  return String(value ?? '')
    .replace(/[\s-]/g, '')
    .toUpperCase();
}

/**
 * A unit is on the shelf if the shop can still sell it.
 *
 * `returned` counts: a handset that came back is sitting in the cabinet and can
 * go out again. Only `sold` and `scrapped` are gone. This has to agree with
 * `syncStockFromUnits` exactly — a status the count ignores but a sale allows
 * would let the register offer a phone it believes it does not have.
 */
export const AVAILABLE_STATUSES = ['in_stock', 'returned'];

export function isAvailable(status) {
  return AVAILABLE_STATUSES.includes(status);
}

/** Recount `stock` from the units actually on the shelf. */
export function syncStockFromUnits(productId) {
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM product_units
       WHERE product_id = ? AND status IN (${AVAILABLE_STATUSES.map(() => '?').join(', ')})`,
    )
    .get(productId, ...AVAILABLE_STATUSES);
  db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(n, productId);
  return n;
}

/** The units of a product, newest first, optionally narrowed to one status. */
export function unitsFor(productId, status = null) {
  const sql = `SELECT u.*, o.order_number, o.created_at AS order_date, cu.name AS customer_name
     FROM product_units u
     LEFT JOIN orders o ON o.id = u.sold_order_id
     LEFT JOIN customers cu ON cu.id = o.customer_id
     WHERE u.product_id = ?${status ? ' AND u.status = ?' : ''}
     ORDER BY u.status IN ('in_stock', 'returned') DESC, u.created_at DESC, u.id DESC`;
  return status
    ? db.prepare(sql).all(productId, status)
    : db.prepare(sql).all(productId);
}

/** One unit by IMEI, with everything the counter needs to answer for it. */
export function findByImei(imei) {
  return db
    .prepare(
      `SELECT u.*, p.name AS product_name, p.sku, p.price,
              o.order_number, o.created_at AS sold_on,
              cu.name AS customer_name, cu.phone AS customer_phone
       FROM product_units u
       JOIN products p ON p.id = u.product_id
       LEFT JOIN orders o ON o.id = u.sold_order_id
       LEFT JOIN customers cu ON cu.id = o.customer_id
       WHERE u.imei = ?`,
    )
    .get(normaliseImei(imei));
}

/**
 * Take in units against a product.
 *
 * Rejects the whole batch if any IMEI is already known. Receiving twenty
 * handsets and silently keeping nineteen would leave the cashier believing a
 * phone is on the shelf that was never booked in, and a partial success is
 * harder to unpick than an outright refusal.
 */
export function receiveUnits(productId, units, { documentId = null, defaultCost = 0 } = {}) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new Error('Product not found');
  if (!product.tracks_units) throw new Error(`${product.name} is not tracked by IMEI`);
  if (!Array.isArray(units) || units.length === 0) throw new Error('No units given');

  const seen = new Set();
  const rows = units.map((u) => {
    const imei = normaliseImei(typeof u === 'string' ? u : u?.imei);
    if (!imei) throw new Error('Every unit needs an IMEI or serial number');
    if (seen.has(imei)) throw new Error(`${imei} appears twice in this batch`);
    seen.add(imei);

    const existing = db.prepare('SELECT id FROM product_units WHERE imei = ?').get(imei);
    if (existing) throw new Error(`${imei} is already in stock or sold`);

    const condition = (typeof u === 'string' ? 'new' : u?.condition) || 'new';
    if (!UNIT_CONDITIONS.includes(condition)) {
      throw new Error(`Condition must be one of: ${UNIT_CONDITIONS.join(', ')}`);
    }

    const rawCost = typeof u === 'string' ? null : u?.cost;
    const cost = Number(rawCost ?? defaultCost ?? product.cost) || 0;
    if (cost < 0) throw new Error('A unit cannot cost less than nothing');

    return { imei, condition, cost, note: (typeof u === 'string' ? null : u?.note) || null };
  });

  const insert = db.prepare(
    `INSERT INTO product_units (product_id, imei, condition, cost, note, received_document_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) insert.run(productId, r.imei, r.condition, r.cost, r.note, documentId);

  const stock = syncStockFromUnits(productId);
  return { added: rows.length, stock };
}

/**
 * Claim a unit for a sale.
 *
 * Returns the unit so the caller can put its own cost on the line — the whole
 * point of serialising is that this handset's margin is not the average of its
 * shelf-mates.
 */
export function sellUnit(unitId, productId, orderId) {
  const unit = db.prepare('SELECT * FROM product_units WHERE id = ?').get(unitId);
  if (!unit) throw new Error('That unit is not in the catalogue');
  if (unit.product_id !== productId) throw new Error(`${unit.imei} is not a unit of that product`);
  if (!isAvailable(unit.status)) {
    throw new Error(`${unit.imei} is already ${unit.status.replace('_', ' ')}`);
  }

  db.prepare(
    `UPDATE product_units SET status = 'sold', sold_order_id = ?, sold_at = datetime('now')
     WHERE id = ?`,
  ).run(orderId, unitId);

  return unit;
}

/**
 * Put units from a refunded order back on the shelf.
 *
 * They come back as `returned` rather than `in_stock`: a handset that has been
 * out of the shop and come back is not the same proposition as one still in its
 * box, and whoever sells it next should be told.
 */
export function returnUnitsOfOrder(orderId) {
  const units = db.prepare('SELECT * FROM product_units WHERE sold_order_id = ?').all(orderId);
  for (const u of units) {
    db.prepare(
      `UPDATE product_units SET status = 'returned', sold_order_id = NULL, sold_at = NULL
       WHERE id = ?`,
    ).run(u.id);
  }
  for (const productId of new Set(units.map((u) => u.product_id))) {
    syncStockFromUnits(productId);
  }
  return units.length;
}

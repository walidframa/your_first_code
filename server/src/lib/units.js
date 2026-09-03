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
import { mainBranchId, setStock } from './stock.js';

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

/**
 * Recount the shelf from the handsets actually on it.
 *
 * Counted per branch, because a phone is a physical object in one shop: the
 * register at one counter must not offer a handset sitting in the other. Every
 * branch holding units of this product is recounted, so a unit that moved is
 * taken off one shelf and added to the other in the same pass.
 */
export function syncStockFromUnits(productId) {
  const placeholders = AVAILABLE_STATUSES.map(() => '?').join(', ');

  const counts = db
    .prepare(
      `SELECT branch_id, COUNT(*) AS n FROM product_units
       WHERE product_id = ? AND status IN (${placeholders})
       GROUP BY branch_id`,
    )
    .all(productId, ...AVAILABLE_STATUSES);

  const byBranch = new Map(counts.map((c) => [c.branch_id ?? mainBranchId(), c.n]));

  // Every branch that has a row, so one falling to zero is written as zero
  // rather than being left at yesterday's figure.
  const touched = new Set([
    ...byBranch.keys(),
    ...db
      .prepare('SELECT branch_id FROM branch_stock WHERE product_id = ?')
      .all(productId)
      .map((r) => r.branch_id),
  ]);

  for (const branchId of touched) {
    setStock({ branchId, productId, stock: byBranch.get(branchId) ?? 0 });
  }

  return [...byBranch.values()].reduce((sum, n) => sum + n, 0);
}

/** The units of a product, newest first, optionally narrowed to one status. */
export function unitsFor(productId, status = null, branchId = null) {
  /*
   * `branchId` narrows this to the handsets standing in one shop.
   *
   * Null is every one of them, which is what the stock list and the counter's
   * own lookup want — a customer walks in with a phone and "whose shelf is it
   * on" is not the question. What it is right for is anything that moves a
   * physical object: offering to send a handset that is in the other branch
   * produces a transfer the server then refuses, which reads as the app being
   * broken rather than as the phone being elsewhere.
   *
   * A handset booked in before branches existed carries none, and belongs to
   * the main shop — the same reading every other query takes.
   */
  const params = [productId];
  let where = 'u.product_id = ?';
  if (status) {
    where += ' AND u.status = ?';
    params.push(status);
  }
  if (branchId) {
    where += ' AND COALESCE(u.branch_id, ?) = ?';
    params.push(mainBranchId(), branchId);
  }

  return db
    .prepare(
      `SELECT u.*, o.order_number, o.created_at AS order_date, cu.name AS customer_name
       FROM product_units u
       LEFT JOIN orders o ON o.id = u.sold_order_id
       LEFT JOIN customers cu ON cu.id = o.customer_id
       WHERE ${where}
       ORDER BY u.status IN ('in_stock', 'returned') DESC, u.created_at DESC, u.id DESC`,
    )
    .all(...params);
}

/**
 * Split a typed line into the one or two numbers on the box.
 *
 * A dual-SIM handset has both printed together, so they arrive on one line
 * separated by a comma or a slash. Spaces cannot be the separator: they appear
 * *inside* a single IMEI as printed, and `35 1234 5678 9012 3` is one number,
 * not five.
 */
export function parseImeiLine(line) {
  const [first, second] = String(line ?? '')
    .split(/[,/;|]/)
    .map((part) => normaliseImei(part));
  return { imei: first || '', imei2: second || null };
}

/**
 * How long a number has to be before it stands on its own.
 *
 * An IMEI is fifteen digits. Anything shorter is a fragment of one — which is
 * what a person typing off the back of a box produces, because that is how the
 * number is printed: `35 6001 0001 0001 1`.
 */
const WHOLE_NUMBER = 15;

/**
 * A typed or scanned box of numbers, as a list of handsets.
 *
 * Three separators, meaning three different things:
 *
 *  - **A comma, slash, semicolon or pipe** joins two numbers into *one*
 *    dual-SIM handset. It swallows the spaces around it, so "351…1 , 351…9" is
 *    one phone, typed the way a person types.
 *  - **A newline** always starts a new handset.
 *  - **A space** is the awkward one, and it is why this function exists. It
 *    appears *inside* one number as printed, and *between* two numbers when a
 *    barcode reader's key is a Tab rather than an Enter. Length tells them
 *    apart: a token that is already a whole number stands alone, and anything
 *    shorter is a fragment that joins what came before.
 *
 * Before this, space simply did not separate — `normaliseImei` strips every
 * one — so two scans on the same line were glued into a single thirty-digit
 * "IMEI". The shop was told it had given one number for two phones, and nothing
 * on screen said why.
 */
export function parseImeiList(text) {
  const handsets = [];

  for (const line of String(text ?? '').split(/[\r\n]+/)) {
    // A pair separator takes the spaces beside it, so it survives the split
    // below and "a , b" stays one handset.
    const tokens = line.replace(/\s*[,/;|]\s*/g, ',').split(/\s+/).filter(Boolean);

    let buffer = '';
    const flush = () => {
      if (!buffer) return;
      const parsed = parseImeiLine(buffer);
      if (parsed.imei) handsets.push(parsed);
      buffer = '';
    };

    for (const token of tokens) {
      /*
       * Two whole numbers side by side are two handsets; a fragment is more of
       * the number already being built.
       *
       * Measured on the token's *first* number, because a pair separator has
       * already glued a dual-SIM's second number onto it — and "1,356…9",
       * which is the tail of one number and the whole of its twin, is a
       * fragment however long the token reads.
       */
      const head = normaliseImei(token.split(',')[0]);
      if (buffer && (normaliseImei(buffer).length >= WHOLE_NUMBER || head.length >= WHOLE_NUMBER)) {
        flush();
      }
      buffer += token;
    }
    flush();
  }

  return handsets;
}

/**
 * One unit by either of its IMEIs.
 *
 * The customer reads whichever number they can see; asking them which slot it
 * belongs to would be a strange thing to do at a counter.
 */
export function findByImei(imei) {
  const wanted = normaliseImei(imei);
  return db
    .prepare(
      `SELECT u.*, p.name AS product_name, p.sku, p.price,
              o.order_number, o.created_at AS sold_on,
              cu.name AS customer_name, cu.phone AS customer_phone
       FROM product_units u
       JOIN products p ON p.id = u.product_id
       LEFT JOIN orders o ON o.id = u.sold_order_id
       LEFT JOIN customers cu ON cu.id = o.customer_id
       WHERE u.imei = ? OR u.imei2 = ?`,
    )
    .get(wanted, wanted);
}

/** Is this number already spoken for, on either slot of any handset? */
function imeiTaken(number) {
  return db
    .prepare('SELECT id FROM product_units WHERE imei = ? OR imei2 = ?')
    .get(number, number);
}

/**
 * Take in units against a product.
 *
 * Rejects the whole batch if any IMEI is already known. Receiving twenty
 * handsets and silently keeping nineteen would leave the cashier believing a
 * phone is on the shelf that was never booked in, and a partial success is
 * harder to unpick than an outright refusal.
 */
export function receiveUnits(productId, units, { documentId = null, defaultCost = 0, branchId = null } = {}) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new Error('Product not found');
  if (!product.tracks_units) throw new Error(`${product.name} is not tracked by IMEI`);
  if (!Array.isArray(units) || units.length === 0) throw new Error('No units given');

  const seen = new Set();
  const rows = units.map((u) => {
    /*
     * The typed field carries both numbers whether it arrives as a bare string
     * or as an object's `imei` — the cashier pastes a line either way, and
     * splitting only one of the two shapes would work in tests and fail at the
     * counter. An explicit `imei2` wins over anything found in the line.
     */
    const parsed = parseImeiLine(typeof u === 'string' ? u : u?.imei);
    const imei = parsed.imei;
    const imei2 = (typeof u === 'string' ? null : normaliseImei(u?.imei2) || null) ?? parsed.imei2;

    if (!imei) throw new Error('Every unit needs an IMEI or serial number');
    if (imei2 && imei2 === imei) throw new Error(`${imei} is given twice on the same handset`);

    /*
     * Both slots are checked against both columns. A number is a number: if it
     * is IMEI 2 of one phone it cannot also be IMEI 1 of another, and either
     * way a lookup would have to guess.
     */
    for (const number of [imei, imei2].filter(Boolean)) {
      if (seen.has(number)) throw new Error(`${number} appears twice in this batch`);
      seen.add(number);
      if (imeiTaken(number)) throw new Error(`${number} is already in stock or sold`);
    }

    const condition = (typeof u === 'string' ? 'new' : u?.condition) || 'new';
    if (!UNIT_CONDITIONS.includes(condition)) {
      throw new Error(`Condition must be one of: ${UNIT_CONDITIONS.join(', ')}`);
    }

    const rawCost = typeof u === 'string' ? null : u?.cost;
    const cost = Number(rawCost ?? defaultCost ?? product.cost) || 0;
    if (cost < 0) throw new Error('A unit cannot cost less than nothing');

    return { imei, imei2, condition, cost, note: (typeof u === 'string' ? null : u?.note) || null };
  });

  const insert = db.prepare(
    `INSERT INTO product_units (product_id, imei, imei2, condition, cost, note, received_document_id, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Booked in at a branch, because a handset is somewhere.
  const at = branchId ?? mainBranchId();
  for (const r of rows) {
    insert.run(productId, r.imei, r.imei2, r.condition, r.cost, r.note, documentId, at);
  }

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

/**
 * Put one handset back, when only that one is being returned.
 *
 * Same standing as a whole order coming back — `returned`, not `in_stock` —
 * because what makes it a used proposition is that it left the shop, not how
 * many other things left with it.
 */
export function returnOneUnit(unitId) {
  const unit = db.prepare('SELECT * FROM product_units WHERE id = ?').get(unitId);
  if (!unit) return null;
  db.prepare(
    `UPDATE product_units SET status = 'returned', sold_order_id = NULL, sold_at = NULL WHERE id = ?`,
  ).run(unit.id);
  syncStockFromUnits(unit.product_id);
  return unit;
}

import { db } from '../db.js';
import { moveStock, stockAt } from './stock.js';

/**
 * Products that are made of other products.
 *
 * A "starter pack" is a phone, a case and a screen protector, sold as one line
 * at one price. Nothing sits on a shelf called "starter pack" — so selling one
 * has to take a phone, a case and a protector off the shelves they really are
 * on, and asking how many packs are available means asking the shelves.
 *
 * Everything a bundle does to stock goes through `lib/stock.js` like every
 * other movement in this app. A bundle is not a second way to change stock; it
 * is a reason to change three lots of it at once.
 */

/** What is in one of these, or an empty list for an ordinary product. */
export function componentsOf(bundleId) {
  return db
    .prepare(
      `SELECT b.component_id AS productId, b.quantity, p.name, p.sku, p.cost, p.active
         FROM product_bundles b
         JOIN products p ON p.id = b.component_id
        WHERE b.bundle_id = ?
        ORDER BY p.name`,
    )
    .all(bundleId);
}

/** Is this product sold as a bundle of others? */
export const isBundle = (productId) =>
  db.prepare('SELECT 1 FROM product_bundles WHERE bundle_id = ? LIMIT 1').get(productId) !== undefined;

/** Every bundle id, for marking up a product list in one query rather than n. */
export function bundleIds() {
  return new Set(
    db.prepare('SELECT DISTINCT bundle_id AS id FROM product_bundles').all().map((r) => r.id),
  );
}

/**
 * How many of this bundle the shop could actually sell right now.
 *
 * The shelf that runs out first decides, which is the whole point — a pack of
 * three things is only available while all three are. Whole numbers only: half
 * a starter pack is not a thing anybody can hand across a counter.
 *
 * A bundle with no components is not a bundle, and returns null so callers can
 * tell "not a bundle" from "none available".
 */
export function availableBundles(branchId, bundleId, parts = null) {
  const components = parts ?? componentsOf(bundleId);
  if (!components.length) return null;

  let fewest = Infinity;
  for (const c of components) {
    const per = Number(c.quantity) || 0;
    if (per <= 0) continue;
    fewest = Math.min(fewest, Math.floor(stockAt(branchId, c.productId) / per));
  }
  return Number.isFinite(fewest) ? Math.max(0, fewest) : 0;
}

/**
 * What one of these cost the shop, added up from its parts.
 *
 * A bundle's own cost price is meaningless — nobody buys starter packs from a
 * supplier — so the profit on one is the price minus what its parts cost. A
 * part with no cost recorded contributes nothing, the same as everywhere else
 * in this app, and the profit screens say so rather than pretending.
 */
export function bundleCost(bundleId, parts = null) {
  const components = parts ?? componentsOf(bundleId);
  return components.reduce((sum, c) => sum + (Number(c.cost) || 0) * (Number(c.quantity) || 0), 0);
}

/**
 * Take a list of parts off the shelves, or put them back.
 *
 * `sign` is -1 for a sale and +1 for a refund, so the two directions cannot
 * drift apart into two functions that disagree about what came off.
 *
 * Deliberately does not touch the bundle's own stock row. A bundle is not
 * stock; if it had a count of its own, that count would be a second truth
 * about the same phones and would be wrong within a day.
 */
export function movePartsStock({ branchId, parts, quantity, sign = -1, allowNegative = false }) {
  for (const c of parts) {
    moveStock({
      branchId,
      productId: c.productId,
      delta: sign * (Number(c.quantity) || 0) * quantity,
      allowNegative,
    });
  }
}

/**
 * The same, for a bundle taken as the catalogue defines it.
 *
 * Returns false for a product that is not a bundle, which is how the callers
 * tell an ordinary line from a pack without carrying a flag that could fall out
 * of step with the rows that decide it.
 */
export function moveBundleStock({ branchId, bundleId, quantity, sign = -1, allowNegative = false }) {
  const components = componentsOf(bundleId);
  if (!components.length) return false;
  movePartsStock({ branchId, parts: components, quantity, sign, allowNegative });
  return true;
}

/**
 * What this particular pack is being made of.
 *
 * The catalogue's answer unless the counter said otherwise. A shop sells packs
 * precisely because the customer wants the blue case rather than the black one,
 * and the cashier standing in front of them is the only person who can know
 * that — so the definition is a starting point, not a rule.
 *
 * The same three refusals as editing the definition itself, for the same
 * reasons: a pack containing itself would recurse until the stack gave out, a
 * pack of packs is a tree nobody can hold in their head at a counter, and a
 * part that does not exist cannot come off a shelf. Substituting at the counter
 * must not be a way around checks that apply in the back office.
 */
export function resolveLineParts(bundleId, wanted) {
  const defined = componentsOf(bundleId);
  if (!defined.length) return null;
  if (!Array.isArray(wanted)) return defined;

  const parts = [];
  const seen = new Set();

  for (const part of wanted) {
    const productId = Number(part.productId ?? part.product_id);
    const quantity = Number(part.quantity);
    if (!Number.isInteger(productId) || productId <= 0) continue;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('Every item in a pack needs a quantity above zero');
    }
    if (productId === Number(bundleId)) throw new Error('A pack cannot contain itself');
    if (isBundle(productId)) {
      const name = db.prepare('SELECT name FROM products WHERE id = ?').get(productId)?.name;
      throw new Error(`${name || 'That item'} is itself a pack — packs cannot contain packs`);
    }

    const product = db.prepare('SELECT id, name, cost FROM products WHERE id = ?').get(productId);
    if (!product) throw new Error('One of the items in this pack no longer exists');

    /*
     * Two rows naming the same product would each be checked against the shelf
     * on its own and then both taken off it, which is how a pack oversells one
     * of its parts. Added together instead.
     */
    if (seen.has(productId)) {
      parts.find((p) => p.productId === productId).quantity += quantity;
      continue;
    }
    seen.add(productId);
    parts.push({ productId, quantity, name: product.name, cost: product.cost ?? null });
  }

  /*
   * An empty pack is refused rather than treated as "leave it as it was". A
   * cashier who has taken everything out of a pack has done something they
   * meant, and selling them the catalogue's version instead would put things in
   * the bag they had just removed.
   */
  if (!parts.length) throw new Error('A pack needs at least one item in it');
  return parts;
}

/** How many of a given part list the shelves allow. */
export function availableFromParts(branchId, parts) {
  let fewest = Infinity;
  for (const c of parts) {
    const per = Number(c.quantity) || 0;
    if (per <= 0) continue;
    fewest = Math.min(fewest, Math.floor(stockAt(branchId, c.productId) / per));
  }
  return Number.isFinite(fewest) ? Math.max(0, fewest) : 0;
}

/** What a list of parts cost the shop, per one of the bundle. */
export const partsCost = (parts) =>
  parts.reduce((sum, c) => sum + (Number(c.cost) || 0) * (Number(c.quantity) || 0), 0);

/** Freeze what went in the bag against the line it went out on. */
export function recordLineParts(orderItemId, parts) {
  const add = db.prepare(
    `INSERT INTO order_item_components (order_item_id, product_id, name, quantity, cost)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const c of parts) add.run(orderItemId, c.productId, c.name, c.quantity, c.cost ?? null);
}

/**
 * What a sold line actually took off the shelves.
 *
 * Falls back to the catalogue for lines sold before any of this existed, which
 * is genuinely what those sales took — not a guess. Returns an empty list for
 * an ordinary product, so a caller can tell a pack from a thing.
 */
export function partsUsedOn(orderItemId, bundleId) {
  const recorded = db
    .prepare(
      `SELECT product_id AS productId, name, quantity, cost
         FROM order_item_components WHERE order_item_id = ? ORDER BY id`,
    )
    .all(orderItemId);
  return recorded.length ? recorded : componentsOf(bundleId);
}

/** Whether a line's parts differ from what the catalogue says the pack is. */
export function partsWereChanged(orderItemId, bundleId) {
  const used = db
    .prepare('SELECT product_id, quantity FROM order_item_components WHERE order_item_id = ?')
    .all(orderItemId);
  if (!used.length) return false;

  const defined = componentsOf(bundleId);
  if (used.length !== defined.length) return true;

  const asMap = (rows, key) => new Map(rows.map((r) => [r[key], Number(r.quantity)]));
  const a = asMap(used, 'product_id');
  const b = asMap(defined, 'productId');
  for (const [id, qty] of b) if (a.get(id) !== qty) return true;
  return false;
}

/**
 * Set what is in a bundle, replacing whatever was there.
 *
 * Refuses two things that would each turn stock into nonsense:
 *
 * A bundle cannot contain itself, directly or through another bundle. Selling
 * one would otherwise recurse until the stack gave out, and the shop would be
 * told its own catalogue was broken by a stack trace.
 *
 * A component cannot itself be a bundle. Allowing it would mean a pack of
 * packs, whose availability and cost depend on a tree that somebody has to be
 * able to hold in their head at the counter. The shops this is for sell a
 * phone with a case; if that ever stops being true it can be revisited
 * deliberately rather than by accident.
 */
export function setBundle(bundleId, parts) {
  const cleaned = [];
  for (const part of parts || []) {
    const productId = Number(part.productId ?? part.component_id);
    const quantity = Number(part.quantity);
    if (!Number.isInteger(productId) || productId <= 0) continue;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('Every item in a bundle needs a quantity above zero');
    }
    if (productId === Number(bundleId)) {
      throw new Error('A bundle cannot contain itself');
    }
    if (isBundle(productId)) {
      const name = db.prepare('SELECT name FROM products WHERE id = ?').get(productId)?.name;
      throw new Error(`${name || 'That item'} is itself a bundle — bundles cannot contain bundles`);
    }
    const exists = db.prepare('SELECT 1 FROM products WHERE id = ?').get(productId);
    if (!exists) throw new Error('One of the items in this bundle no longer exists');
    cleaned.push({ productId, quantity });
  }

  db.prepare('DELETE FROM product_bundles WHERE bundle_id = ?').run(bundleId);
  const add = db.prepare(
    'INSERT INTO product_bundles (bundle_id, component_id, quantity) VALUES (?, ?, ?)',
  );
  for (const c of cleaned) add.run(bundleId, c.productId, c.quantity);
  return cleaned.length;
}

/**
 * Is this product part of some bundle?
 *
 * Asked before deleting or deactivating one, because a bundle quietly losing a
 * part is a bundle that sells for the same price and takes less off the shelf.
 */
export function bundlesContaining(productId) {
  return db
    .prepare(
      `SELECT p.id, p.name FROM product_bundles b
         JOIN products p ON p.id = b.bundle_id
        WHERE b.component_id = ?`,
    )
    .all(productId);
}

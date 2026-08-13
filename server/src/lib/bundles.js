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
 * Take a bundle's parts off the shelves, or put them back.
 *
 * `sign` is -1 for a sale and +1 for a refund, so the two directions cannot
 * drift apart into two functions that disagree about what a bundle contains.
 *
 * Deliberately does not touch the bundle's own stock row. A bundle is not
 * stock; if it had a count of its own, that count would be a second truth
 * about the same phones and would be wrong within a day.
 */
export function moveBundleStock({ branchId, bundleId, quantity, sign = -1, allowNegative = false }) {
  const components = componentsOf(bundleId);
  if (!components.length) return false;

  for (const c of components) {
    moveStock({
      branchId,
      productId: c.productId,
      delta: sign * (Number(c.quantity) || 0) * quantity,
      allowNegative,
    });
  }
  return true;
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

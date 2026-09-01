/**
 * The cards scratched to deliver a validity top-up.
 *
 * Selling "Alfa 180 days" is three things at once: the customer pays for days,
 * whole recharge cards come off the shop's stock to deliver them, and the
 * credit those cards carry lands on the shop's own carrier line to be resold by
 * the dollar.
 *
 * It used to be **one** card, held in `products.linked_card_id`. That is not how
 * the shop works: a 180-day top-up is often delivered by scratching two cards,
 * sometimes two of the same one and sometimes two different ones, because the
 * carrier sells the denominations it sells and the validity package is priced
 * against a total. A shop with a two-card package had to pick one of them and
 * type the other off the books by hand every time — which is exactly the
 * "credit balance nobody trusts" this feature exists to prevent.
 *
 * So a validity card now names a list, with a count against each. One card is
 * simply a list of one, and every shop that had set the old single link keeps
 * working with no change on screen — see the migration in db.js.
 *
 * `linked_card_id` stays on the row as the migration's source and is no longer
 * read by anything: this table is the one answer to "what gets scratched",
 * because two places to look would eventually disagree.
 */
import { db, transaction } from '../db.js';

/** What one of these scratches. Empty for a card that just sells the days. */
export function scratchedBy(productId) {
  return db
    .prepare(
      `SELECT v.card_id AS cardId, v.quantity,
              p.name, p.sku, p.cost, p.active, p.wallet_id, p.credits_included
         FROM validity_cards v
         JOIN products p ON p.id = v.card_id
        WHERE v.product_id = ?
        ORDER BY p.name`,
    )
    .all(productId);
}

/**
 * Every validity card's list, keyed by product id.
 *
 * One query rather than one per product: the catalogue is loaded on every visit
 * to the register, and a shop with forty validity packages would otherwise make
 * forty extra round trips to draw one screen.
 */
export function scratchMap() {
  const rows = db
    .prepare(
      `SELECT v.product_id AS productId, v.card_id AS cardId, v.quantity, p.name
         FROM validity_cards v
         JOIN products p ON p.id = v.card_id
        ORDER BY p.name`,
    )
    .all();

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.productId)) map.set(row.productId, []);
    map.get(row.productId).push({ cardId: row.cardId, quantity: row.quantity, name: row.name });
  }
  return map;
}

/**
 * Say what a validity card scratches, replacing whatever it said before.
 *
 * Refuses rather than quietly dropping a bad row: a list that silently loses a
 * card is a package that under-scratches on every sale afterwards, and nothing
 * on screen would say so.
 */
export const setScratched = transaction((productId, cards) => {
  const cleaned = [];
  const seen = new Set();

  for (const entry of cards || []) {
    const cardId = Number(entry.cardId ?? entry.card_id ?? entry.id);
    const quantity = Number(entry.quantity ?? 1);
    if (!Number.isInteger(cardId) || cardId <= 0) continue;

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('Every card scratched needs a count above zero');
    }
    /*
     * Whole cards only. Half a recharge card is not a thing anybody can scratch,
     * and a fractional count here would come off the wallet as a fraction of a
     * card's credit — a balance that never reconciles against the cards the
     * shop actually holds.
     */
    if (!Number.isInteger(quantity)) {
      throw new Error('Cards are scratched whole — the count has to be a whole number');
    }
    if (cardId === Number(productId)) {
      throw new Error('A validity card cannot be delivered by itself');
    }

    const card = db.prepare('SELECT id, name, validity_days FROM products WHERE id = ?').get(cardId);
    if (!card) throw new Error('One of those cards no longer exists');
    /*
     * A validity card delivering another validity card would recurse, and
     * nothing about that is a sale anybody meant to make.
     */
    if (card.validity_days) {
      throw new Error(`${card.name} is itself a validity card — those cannot deliver each other`);
    }

    // The same card twice is a count, not a second row.
    if (seen.has(cardId)) {
      throw new Error(`${card.name} is listed twice — put the number in its count instead`);
    }
    seen.add(cardId);
    cleaned.push({ cardId, quantity });
  }

  db.prepare('DELETE FROM validity_cards WHERE product_id = ?').run(productId);
  const add = db.prepare(
    'INSERT INTO validity_cards (product_id, card_id, quantity) VALUES (?, ?, ?)',
  );
  for (const c of cleaned) add.run(productId, c.cardId, c.quantity);
  return cleaned.length;
});

/**
 * What a sale of `quantity` of this package has to scratch, checked.
 *
 * Both refusals are the same failure seen from two sides: the shop has said
 * this package is delivered by a card it no longer has. Selling on regardless
 * would either fail on a missing row or quietly scratch a card the shop has
 * stopped stocking, and neither is something a cashier could unpick afterwards.
 */
export function scratchPlan(product) {
  const cards = scratchedBy(product.id);

  for (const card of cards) {
    if (!card.name) {
      throw new Error(`${product.name} is linked to a card that no longer exists`);
    }
    if (!card.active) {
      throw new Error(`${product.name} is delivered by ${card.name}, which is no longer stocked`);
    }
  }

  return cards;
}

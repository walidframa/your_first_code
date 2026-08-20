/**
 * What a product has actually cost, across every delivery of it.
 *
 * `products.cost` is one number: what the last person to save the product said
 * it costs. That answers "what is it worth now" and is the wrong answer to the
 * question a shopkeeper is really asking at the end of a month —
 *
 *   I bought ten of these at $10 and then twenty at $9. What did they cost me?
 *
 * The answer is $9.33, not $9 and not $10, and it is the only figure that
 * makes a margin mean anything while stock bought at two prices is still on
 * the shelf.
 *
 * **Weighted by quantity, on purpose.** Ten at $10 and twenty at $9 is not "an
 * average of $9.50" — that would be the average of two prices rather than the
 * average of thirty items, and it flatters a shop that bought a token quantity
 * dear and the rest cheap. Where the quantities match, the two agree, which is
 * the case somebody checks it against by hand.
 *
 * Only **confirmed purchase invoices** count. A draft is a piece of paper
 * somebody is still typing, and a cancelled one is a delivery that did not
 * happen; neither cost the shop anything. Register sales and stock corrections
 * are not purchases at all.
 */
import { db } from '../db.js';
import { round2 } from './currency.js';

/*
 * One query for the whole catalogue rather than one per product: the products
 * list is loaded on every visit to the register, and a correlated subquery per
 * row turns a 900-product catalogue into 900 queries.
 */
const AVERAGES = `
  SELECT di.product_id AS id,
         SUM(di.price * di.quantity) AS spent,
         SUM(di.quantity) AS units
  FROM document_items di
  JOIN documents d ON d.id = di.document_id
  WHERE d.doc_type = 'purchase_invoice'
    AND d.status = 'confirmed'
    AND di.product_id IS NOT NULL
    AND di.quantity > 0
  GROUP BY di.product_id
`;

/*
 * The most recent one, which is a different question: the average says what the
 * shelf cost, the last says what the supplier is charging now. A purchase
 * invoice dearer than this is the one worth stopping somebody over.
 */
const LATEST = `
  SELECT di.product_id AS id, di.price AS cost,
         COALESCE(d.confirmed_at, d.created_at) AS at, d.doc_number AS reference
  FROM document_items di
  JOIN documents d ON d.id = di.document_id
  WHERE d.doc_type = 'purchase_invoice'
    AND d.status = 'confirmed'
    AND di.product_id IS NOT NULL
    AND di.quantity > 0
  ORDER BY COALESCE(d.confirmed_at, d.created_at) DESC, d.id DESC
`;

/** Weighted average cost per product, as a Map. Products never bought are absent. */
export function averageCostMap() {
  const out = new Map();
  for (const row of db.prepare(AVERAGES).all()) {
    if (!row.units) continue;
    out.set(row.id, round2(row.spent / row.units));
  }
  return out;
}

/** What was last paid for each product, with when and on which invoice. */
export function lastCostMap() {
  const out = new Map();
  // Newest first, so the first row seen for a product is the one that counts.
  for (const row of db.prepare(LATEST).all()) {
    if (out.has(row.id)) continue;
    out.set(row.id, { cost: round2(row.cost), at: row.at, reference: row.reference });
  }
  return out;
}

/**
 * Both figures for one product, for a screen that opened a single item.
 *
 * `average` is null when the shop has never booked a purchase invoice for it —
 * which is honest. Falling back to `products.cost` would show a figure called
 * "average" that is nothing of the sort, and a shop reading its margins off it
 * would be reading a number nobody computed.
 */
export function costingFor(productId) {
  const totals = db
    .prepare(
      `SELECT SUM(di.price * di.quantity) AS spent, SUM(di.quantity) AS units
       FROM document_items di
       JOIN documents d ON d.id = di.document_id
       WHERE d.doc_type = 'purchase_invoice' AND d.status = 'confirmed'
         AND di.product_id = ? AND di.quantity > 0`,
    )
    .get(productId);

  const last = db
    .prepare(
      `SELECT di.price AS cost, COALESCE(d.confirmed_at, d.created_at) AS at, d.doc_number AS reference
       FROM document_items di
       JOIN documents d ON d.id = di.document_id
       WHERE d.doc_type = 'purchase_invoice' AND d.status = 'confirmed'
         AND di.product_id = ? AND di.quantity > 0
       ORDER BY COALESCE(d.confirmed_at, d.created_at) DESC, d.id DESC
       LIMIT 1`,
    )
    .get(productId);

  return {
    average: totals?.units ? round2(totals.spent / totals.units) : null,
    units: totals?.units ?? 0,
    spent: totals?.spent ? round2(totals.spent) : 0,
    last: last ? { cost: round2(last.cost), at: last.at, reference: last.reference } : null,
  };
}

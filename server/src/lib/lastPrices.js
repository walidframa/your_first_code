/**
 * What this customer paid for it last time.
 *
 * A shop here does not have one price for a thing. It has a price for the
 * public, a price for the electrician who buys ten a month, and a price it
 * quoted somebody last March and would look foolish going back on. The person
 * writing the invoice knows this and holds it in their head, which works until
 * the customer is one of forty and the last sale was in the spring.
 *
 * So the question the screen has to answer while a line is being typed is not
 * "what does this cost" — the catalogue says that — but **"what did I charge
 * *him* for it?"**
 *
 * Both ways the shop sells count, because from the customer's side they are
 * the same thing: a sale rung up at the register with their name on it, and a
 * sales invoice made out to them. Whichever happened last is the price they
 * remember.
 *
 * Only what actually went out: a draft invoice is a piece of paper somebody is
 * still typing, and a cancelled one is a sale that did not happen. Refunded
 * register sales are left in on purpose — the price was still agreed, and a
 * customer who returned one last month expects the same figure this month.
 */
import { db } from '../db.js';
import { round2 } from './currency.js';

/*
 * Both sources in one statement, newest first per product, so the caller walks
 * it once. Ordering by the timestamp across the union is what makes "last"
 * mean last rather than "last invoice, unless there was a register sale".
 */
const SOLD_TO = `
  SELECT product_id, price, at, reference FROM (
    SELECT oi.product_id AS product_id, oi.price AS price,
           o.created_at AS at, o.order_number AS reference, o.id AS seq, 0 AS src
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.customer_id = ? AND oi.product_id IS NOT NULL

    UNION ALL

    SELECT di.product_id AS product_id, di.price AS price,
           COALESCE(d.confirmed_at, d.created_at) AS at, d.doc_number AS reference, d.id AS seq, 1 AS src
    FROM document_items di
    JOIN documents d ON d.id = di.document_id
    WHERE d.party_type = 'customer' AND d.party_id = ?
      AND d.doc_type = 'sales_invoice' AND d.status = 'confirmed'
      AND di.product_id IS NOT NULL
  )
  ORDER BY at DESC, src ASC, seq DESC
`;

/**
 * The last price this customer was charged, per product.
 *
 * One query for the whole of their history rather than one per line: an
 * invoice with twenty lines on it is one question, not twenty.
 */
export function lastPricesFor(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id)) return {};

  const out = {};
  for (const row of db.prepare(SOLD_TO).all(id, id)) {
    // Newest first, so the first row seen for a product is the one that counts.
    if (out[row.product_id]) continue;
    out[row.product_id] = { price: round2(row.price), at: row.at, reference: row.reference };
  }
  return out;
}

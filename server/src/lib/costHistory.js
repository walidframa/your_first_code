/**
 * What a product has cost, over time.
 *
 * A margin that moved has a reason, and the reason is almost always that a
 * supplier changed their price. Without a record there is nothing to point at
 * — the product simply costs what it costs now, and always appears to have.
 */
import { db } from '../db.js';
import { round2 } from './currency.js';

/**
 * Record a change, if it is one.
 *
 * Saving a product without touching the cost, or receiving a delivery at the
 * same price as last time, is not history — writing those would bury the real
 * changes in noise.
 */
export function recordCostChange({ productId, cost, previousCost, source, note = null, documentId = null, userId = null }) {
  const next = round2(Number(cost) || 0);
  const before = previousCost === null || previousCost === undefined ? null : round2(Number(previousCost));
  if (before !== null && before === next) return null;

  const info = db
    .prepare(
      `INSERT INTO product_cost_history (product_id, cost, previous_cost, source, note, document_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(productId, next, before, source, note, documentId, userId);
  return info.lastInsertRowid;
}

export function costHistoryFor(productId, limit = 50) {
  return db
    .prepare(
      `SELECT h.*, u.name AS user_name, d.doc_number
       FROM product_cost_history h
       LEFT JOIN users u ON u.id = h.user_id
       LEFT JOIN documents d ON d.id = h.document_id
       WHERE h.product_id = ?
       ORDER BY h.created_at DESC, h.id DESC LIMIT ?`,
    )
    .all(productId, Math.min(Number(limit) || 50, 200));
}

/**
 * Everything that has happened to one product, newest first.
 *
 * Four separate tables hold pieces of a product's life — sales, documents,
 * stock corrections and cost changes — and a shopkeeper asking "what happened
 * to this item?" wants one list, in order, not four screens.
 */
/**
 * How much of this has been sold, and over what stretch.
 *
 * The list below says what happened one line at a time, which answers "when
 * did that go out" and not "do we sell these". A shopkeeper deciding whether to
 * order more wants the second question answered without counting rows.
 *
 * Register sales and confirmed invoices both count, because both are the shop
 * selling one. Returns are taken off rather than listed separately: eleven sold
 * and three brought back is eight sold, and any other answer is a number
 * somebody has to do arithmetic on before they can use it.
 */
export function salesSummaryFor(productId) {
  const counter = db
    .prepare(
      `SELECT COALESCE(SUM(oi.quantity - COALESCE(oi.returned_qty, 0)), 0) AS units,
              COALESCE(SUM((oi.quantity - COALESCE(oi.returned_qty, 0)) * oi.price), 0) AS revenue,
              MIN(o.created_at) AS first_at, MAX(o.created_at) AS last_at
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.product_id = ? AND o.status != 'refunded'`,
    )
    .get(productId);

  const invoiced = db
    .prepare(
      `SELECT COALESCE(SUM(di.quantity), 0) AS units,
              COALESCE(SUM(di.line_total), 0) AS revenue,
              MIN(COALESCE(d.confirmed_at, d.created_at)) AS first_at,
              MAX(COALESCE(d.confirmed_at, d.created_at)) AS last_at
       FROM document_items di
       JOIN documents d ON d.id = di.document_id
       WHERE di.product_id = ? AND d.doc_type = 'sales_invoice' AND d.status = 'confirmed'`,
    )
    .get(productId);

  const earliest = [counter.first_at, invoiced.first_at].filter(Boolean).sort()[0] || null;
  const latest = [counter.last_at, invoiced.last_at].filter(Boolean).sort().pop() || null;

  return {
    units: round2(counter.units + invoiced.units),
    revenue: round2(counter.revenue + invoiced.revenue),
    atCounter: round2(counter.units),
    onInvoices: round2(invoiced.units),
    firstSoldAt: earliest,
    lastSoldAt: latest,
  };
}

export function activityFor(productId, limit = 200) {
  const cap = Math.min(Number(limit) || 200, 500);

  const sales = db
    .prepare(
      `SELECT o.id AS order_id, o.created_at, o.order_number AS reference, o.status,
              oi.quantity, oi.price, oi.cost, u.name AS user_name
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN users u ON u.id = o.cashier_id
       WHERE oi.product_id = ?
       ORDER BY o.created_at DESC LIMIT ?`,
    )
    .all(productId, cap)
    .map((r) => ({
      at: r.created_at,
      kind: r.status === 'refunded' ? 'refund' : 'sale',
      // A refund puts the goods back, so the sign follows what happened to stock.
      quantity: r.status === 'refunded' ? r.quantity : -r.quantity,
      price: r.price,
      cost: r.cost,
      reference: r.reference,
      // What to open when somebody presses the row: the sale it came from.
      orderId: r.order_id,
      who: r.user_name,
      detail: r.status === 'refunded' ? 'Refunded' : 'Sold at the register',
    }));

  const documents = db
    .prepare(
      `SELECT d.id AS document_id, d.created_at, d.confirmed_at, d.doc_number AS reference,
              d.doc_type, d.status,
              di.quantity, di.price, di.cost, COALESCE(c.name, s.name) AS party_name
       FROM document_items di
       JOIN documents d ON d.id = di.document_id
       LEFT JOIN customers c ON c.id = d.party_id AND d.party_type = 'customer'
       LEFT JOIN suppliers s ON s.id = d.party_id AND d.party_type = 'supplier'
       WHERE di.product_id = ? AND d.status = 'confirmed'
       ORDER BY d.confirmed_at DESC LIMIT ?`,
    )
    .all(productId, cap)
    .map((r) => ({
      at: r.confirmed_at || r.created_at,
      kind: r.doc_type === 'purchase_invoice' ? 'purchase' : 'invoice',
      quantity: r.doc_type === 'purchase_invoice' ? r.quantity : -r.quantity,
      price: r.price,
      cost: r.cost,
      reference: r.reference,
      documentId: r.document_id,
      who: r.party_name,
      detail: r.doc_type === 'purchase_invoice' ? 'Received from supplier' : 'Invoiced to customer',
    }));

  const adjustments = db
    .prepare(
      `SELECT a.created_at, a.delta, a.resulting_stock, a.reason, a.note, u.name AS user_name
       FROM stock_adjustments a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.product_id = ?
       ORDER BY a.created_at DESC LIMIT ?`,
    )
    .all(productId, cap)
    // Movements a document or a sale already explains would otherwise appear
    // twice; those carry the document number in their note.
    .filter((r) => !/^(PI|SI|SO|QT)-\d+$/.test(r.note || ''))
    .map((r) => ({
      at: r.created_at,
      kind: 'adjustment',
      quantity: r.delta,
      stockAfter: r.resulting_stock,
      reference: null,
      who: r.user_name,
      detail: r.note || r.reason.replace(/_/g, ' '),
    }));

  const costs = costHistoryFor(productId, cap).map((r) => ({
    at: r.created_at,
    kind: 'cost',
    cost: r.cost,
    previousCost: r.previous_cost,
    reference: r.doc_number,
    who: r.user_name,
    detail:
      r.previous_cost === null
        ? 'Cost set'
        : `Cost ${r.cost > r.previous_cost ? 'up' : 'down'} from ${Number(r.previous_cost).toFixed(2)}`,
  }));

  return [...sales, ...documents, ...adjustments, ...costs]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, cap);
}

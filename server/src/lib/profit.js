/**
 * What the shop actually made.
 *
 * Three figures, in order, because each answers a different question:
 *
 *   revenue      what was sold for
 *   − cost       what those goods cost to buy      → gross profit
 *   − expenses   what it cost to keep the doors open → net profit
 *
 * Cost comes from the figure stored on each sold line, not from the product's
 * cost today. Otherwise a supplier raising a price next week would quietly
 * rewrite last month's profit.
 */
import { db } from '../db.js';
import { round2 } from './currency.js';
import { expenseSummary } from './expenses.js';
import { sessionById } from './cash.js';

/**
 * A period, as SQL bounds.
 *
 * Dates are inclusive of the whole end day: a report "to the 31st" that stopped
 * at midnight would silently drop the busiest day of the month.
 */
export function periodBounds({ from = null, to = null } = {}) {
  return {
    from: from ? `${from} 00:00:00` : '0000-01-01',
    to: to ? `${to} 23:59:59` : '9999-12-31',
    fromDate: from || null,
    toDate: to || null,
  };
}

/** Named periods, so the UI does not have to do date arithmetic. */
export function presetRange(preset, today = new Date()) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const day = new Date(today);

  if (preset === 'today') return { from: iso(day), to: iso(day) };
  if (preset === 'week') {
    // Weeks start on Monday: a shopkeeper's week is not the ISO calendar's.
    const start = new Date(day);
    const weekday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - weekday);
    return { from: iso(start), to: iso(day) };
  }
  if (preset === 'month') {
    const start = new Date(day.getFullYear(), day.getMonth(), 1);
    return { from: iso(start), to: iso(day) };
  }
  if (preset === 'year') {
    const start = new Date(day.getFullYear(), 0, 1);
    return { from: iso(start), to: iso(day) };
  }
  return { from: null, to: null };
}

/**
 * Sales at the register, with what the goods cost.
 *
 * Refunded orders are excluded rather than netted: an order that was refunded
 * did not happen, and counting it as revenue and again as a negative would
 * double its effect on the average sale.
 */
function registerSales(bounds) {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT o.id) AS orders,
              COALESCE(SUM(o.total), 0) AS revenue,
              COALESCE(SUM(o.tax), 0) AS tax,
              COALESCE(SUM(o.discount), 0) AS discount
       FROM orders o
       WHERE o.status = 'completed' AND o.created_at BETWEEN ? AND ?`,
    )
    .get(bounds.from, bounds.to);

  const cost = db
    .prepare(
      `SELECT COALESCE(SUM(oi.quantity * COALESCE(oi.cost, 0)), 0) AS cost,
              SUM(CASE WHEN oi.cost IS NULL THEN 1 ELSE 0 END) AS unknown_lines
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status = 'completed' AND o.created_at BETWEEN ? AND ?`,
    )
    .get(bounds.from, bounds.to);

  return {
    orders: row.orders,
    revenue: round2(row.revenue),
    tax: round2(row.tax),
    discount: round2(row.discount),
    cost: round2(cost.cost),
    unknownCostLines: cost.unknown_lines || 0,
  };
}

/** Sales invoiced rather than rung up — the same trade, a different counter. */
function invoiceSales(bounds) {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT d.id) AS invoices, COALESCE(SUM(d.total), 0) AS revenue,
              COALESCE(SUM(d.tax), 0) AS tax
       FROM documents d
       WHERE d.doc_type = 'sales_invoice' AND d.status = 'confirmed'
         AND COALESCE(d.confirmed_at, d.created_at) BETWEEN ? AND ?`,
    )
    .get(bounds.from, bounds.to);

  const cost = db
    .prepare(
      `SELECT COALESCE(SUM(di.quantity * COALESCE(di.cost, 0)), 0) AS cost,
              SUM(CASE WHEN di.cost IS NULL THEN 1 ELSE 0 END) AS unknown_lines
       FROM document_items di
       JOIN documents d ON d.id = di.document_id
       WHERE d.doc_type = 'sales_invoice' AND d.status = 'confirmed'
         AND COALESCE(d.confirmed_at, d.created_at) BETWEEN ? AND ?`,
    )
    .get(bounds.from, bounds.to);

  return {
    invoices: row.invoices,
    revenue: round2(row.revenue),
    tax: round2(row.tax),
    cost: round2(cost.cost),
    unknownCostLines: cost.unknown_lines || 0,
  };
}

function refunds(bounds) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total
       FROM orders WHERE status = 'refunded' AND created_at BETWEEN ? AND ?`,
    )
    .get(bounds.from, bounds.to);
  return { orders: row.orders, total: round2(row.total) };
}

/** The products that made the most, and the ones that made the least. */
function byProduct(bounds, limit = 10) {
  return db
    .prepare(
      `SELECT p.id, p.name, p.sku,
              SUM(oi.quantity) AS quantity,
              ROUND(SUM(oi.line_total), 2) AS revenue,
              ROUND(SUM(oi.quantity * COALESCE(oi.cost, 0)), 2) AS cost
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       WHERE o.status = 'completed' AND o.created_at BETWEEN ? AND ?
       GROUP BY p.id
       ORDER BY (SUM(oi.line_total) - SUM(oi.quantity * COALESCE(oi.cost, 0))) DESC
       LIMIT ?`,
    )
    .all(bounds.from, bounds.to, limit)
    .map((r) => ({ ...r, profit: round2(r.revenue - r.cost) }));
}

/**
 * The whole report.
 *
 * `includeExpenses` exists because the two figures answer different questions:
 * gross profit says whether the pricing works, net profit says whether the shop
 * does. Both are worth seeing, so neither is hidden.
 */
export function profitReport({ from = null, to = null, includeExpenses = true } = {}) {
  const bounds = periodBounds({ from, to });

  const register = registerSales(bounds);
  const invoices = invoiceSales(bounds);
  const refunded = refunds(bounds);

  const revenue = round2(register.revenue + invoices.revenue);
  const cost = round2(register.cost + invoices.cost);
  const grossProfit = round2(revenue - cost);

  const expenses = includeExpenses
    ? expenseSummary({ from: bounds.fromDate, to: bounds.toDate })
    : { total: 0, count: 0, byCategory: [] };

  const netProfit = round2(grossProfit - expenses.total);

  return {
    period: { from: bounds.fromDate, to: bounds.toDate },
    includeExpenses,
    revenue,
    cost,
    grossProfit,
    // Guarded: a period with no sales would otherwise divide by zero.
    grossMargin: revenue > 0 ? round2((grossProfit / revenue) * 100) : 0,
    expenses,
    netProfit,
    netMargin: revenue > 0 ? round2((netProfit / revenue) * 100) : 0,
    register,
    invoices,
    refunds: refunded,
    topProducts: byProduct(bounds),
    /*
     * Sales made before costs were recorded on the line have no cost to
     * subtract, so their profit is overstated. Saying so is better than
     * quietly reporting a number that is too good.
     */
    unknownCostLines: register.unknownCostLines + invoices.unknownCostLines,
  };
}

/** The same report for one sitting of the till, from its own start and end. */
export function profitForSession(sessionId, { includeExpenses = true } = {}) {
  const session = sessionById(sessionId);
  if (!session) return null;

  const bounds = {
    from: session.opened_at,
    to: session.closed_at || '9999-12-31',
    fromDate: session.opened_at.slice(0, 10),
    toDate: (session.closed_at || '9999-12-31').slice(0, 10),
  };

  const register = registerSales(bounds);
  const invoices = invoiceSales(bounds);
  const revenue = round2(register.revenue + invoices.revenue);
  const cost = round2(register.cost + invoices.cost);
  const grossProfit = round2(revenue - cost);

  // Only what was actually spent during the sitting, by date.
  const expenses = includeExpenses
    ? expenseSummary({ from: bounds.fromDate, to: bounds.toDate })
    : { total: 0, count: 0, byCategory: [] };

  return {
    session,
    period: { from: session.opened_at, to: session.closed_at },
    includeExpenses,
    revenue,
    cost,
    grossProfit,
    grossMargin: revenue > 0 ? round2((grossProfit / revenue) * 100) : 0,
    expenses,
    netProfit: round2(grossProfit - expenses.total),
    register,
    invoices,
    refunds: refunds(bounds),
    topProducts: byProduct(bounds),
    unknownCostLines: register.unknownCostLines + invoices.unknownCostLines,
  };
}

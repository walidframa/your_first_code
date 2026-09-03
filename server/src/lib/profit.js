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
import { expenseSummary, expensesDuring } from './expenses.js';
import { sessionById } from './cash.js';
import { dayEndUtc, dayStartUtc, shopDay, shopZone, sqlDayShift } from './shopTime.js';

/**
 * A period, as SQL bounds.
 *
 * The dates in are **the shop's own calendar dates** — the ones somebody typed
 * into a date box or picked as "today" — and the bounds out are the UTC
 * timestamps the tables actually store, because that is what `created_at` is.
 * Getting this wrong is not a rounding error: with the shop three hours ahead
 * of UTC, a day cut at UTC midnight starts at three in the morning, so the
 * late trade a phone shop lives on lands in the wrong day and the owner cannot
 * find it.
 *
 * Dates are inclusive of the whole end day: a report "to the 31st" that stopped
 * at midnight would silently drop the busiest day of the month.
 */
export function periodBounds({ from = null, to = null } = {}, zone = shopZone()) {
  return {
    from: from ? dayStartUtc(from, zone) : '0000-01-01',
    to: to ? dayEndUtc(to, zone) : '9999-12-31',
    fromDate: from || null,
    toDate: to || null,
    zone,
  };
}

/**
 * Named periods, so the UI does not have to do date arithmetic.
 *
 * Worked out on the shop's calendar rather than the server's: "this month" is
 * the month it is in the shop, whatever a machine in another country thinks.
 * The arithmetic is done on the civil date itself — a bare `YYYY-MM-DD` — so
 * no zone can creep back in through a Date object's own idea of local time.
 */
export function presetRange(preset, today = new Date(), zone = shopZone()) {
  const iso = shopDay(today, zone);
  const [year, month, day] = iso.split('-').map(Number);
  /* Noon, so adding and subtracting days can never fall over a clock change. */
  const civil = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12));
  const fmt = (d) => d.toISOString().slice(0, 10);

  /** The Monday of the week a civil date falls in. */
  const mondayOf = (d) => {
    const start = new Date(d);
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    return start;
  };

  if (preset === 'today') return { from: iso, to: iso };
  if (preset === 'yesterday') {
    const d = civil(year, month, day);
    d.setUTCDate(d.getUTCDate() - 1);
    return { from: fmt(d), to: fmt(d) };
  }
  if (preset === 'week') {
    // Weeks start on Monday: a shopkeeper's week is not the ISO calendar's.
    return { from: fmt(mondayOf(civil(year, month, day))), to: iso };
  }
  /*
   * The week and the month *before* this one, whole.
   *
   * Asked for by name at the counter — "last week" is the comparison a shop
   * actually makes, and "this week" on a Tuesday morning is two days against
   * somebody's memory of seven.
   */
  if (preset === 'lastweek') {
    const monday = mondayOf(civil(year, month, day));
    const end = new Date(monday);
    end.setUTCDate(end.getUTCDate() - 1);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 6);
    return { from: fmt(start), to: fmt(end) };
  }
  if (preset === 'month') return { from: fmt(civil(year, month, 1)), to: iso };
  if (preset === 'lastmonth') {
    const end = civil(year, month, 1);
    end.setUTCDate(end.getUTCDate() - 1);
    return { from: fmt(civil(end.getUTCFullYear(), end.getUTCMonth() + 1, 1)), to: fmt(end) };
  }
  if (preset === 'year') return { from: fmt(civil(year, 1, 1)), to: iso };
  return { from: null, to: null };
}

/**
 * Sales at the register, with what the goods cost.
 *
 * A fully refunded order is excluded rather than netted: it did not happen, and
 * counting it as revenue and again as a negative would double its effect on the
 * average sale.
 *
 * A *partly* returned one is different, and getting it wrong was a real bug. It
 * keeps `status = 'completed'` and its original total, because two of the three
 * handsets on it were genuinely sold — so summing `orders.total` charged the
 * shop's profit with a phone that came back over the counter. Both halves are
 * therefore built from the lines that are still sold, `quantity - returned_qty`,
 * and the order-level discount and tax are scaled by the share that stayed sold.
 */
function registerSales(bounds, branchId = null) {
  /*
   * LEFT JOIN, and `kept` defaults to 1: an order carrying no lines at all is
   * still a sale that took money, and an inner join would have quietly dropped
   * it out of both the count and the revenue.
   */
  const row = db
    .prepare(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(o.tax * COALESCE(k.kept, 1.0)), 0) AS tax,
              COALESCE(SUM(o.discount * COALESCE(k.kept, 1.0)), 0) AS discount,
              COALESCE(SUM(o.total * COALESCE(k.kept, 1.0)), 0) AS revenue
       FROM orders o
       LEFT JOIN (
         SELECT order_id,
                CASE
                  WHEN COALESCE(SUM(line_total), 0) = 0 THEN 1.0
                  ELSE SUM(
                         CASE WHEN quantity > 0
                              THEN line_total * (quantity - returned_qty) / quantity
                              ELSE line_total END
                       ) / SUM(line_total)
                END AS kept
         FROM order_items GROUP BY order_id
       ) k ON k.order_id = o.id
       WHERE o.status = 'completed' AND o.created_at BETWEEN ? AND ?
         AND (? IS NULL OR o.branch_id = ?)`,
    )
    .get(bounds.from, bounds.to, branchId, branchId);

  const cost = db
    .prepare(
      `SELECT COALESCE(SUM((oi.quantity - oi.returned_qty) * COALESCE(oi.cost, 0)), 0) AS cost,
              SUM(CASE WHEN oi.cost IS NULL AND oi.quantity > oi.returned_qty THEN 1 ELSE 0 END)
                AS unknown_lines
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status = 'completed' AND o.created_at BETWEEN ? AND ?
         AND (? IS NULL OR o.branch_id = ?)`,
    )
    .get(bounds.from, bounds.to, branchId, branchId);

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
function invoiceSales(bounds, branchId = null) {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT d.id) AS invoices, COALESCE(SUM(d.total), 0) AS revenue,
              COALESCE(SUM(d.tax), 0) AS tax
       FROM documents d
       WHERE d.doc_type = 'sales_invoice' AND d.status = 'confirmed'
         AND COALESCE(d.confirmed_at, d.created_at) BETWEEN ? AND ?
         AND (? IS NULL OR d.branch_id = ?)`,
    )
    .get(bounds.from, bounds.to, branchId, branchId);

  const cost = db
    .prepare(
      `SELECT COALESCE(SUM(di.quantity * COALESCE(di.cost, 0)), 0) AS cost,
              SUM(CASE WHEN di.cost IS NULL THEN 1 ELSE 0 END) AS unknown_lines
       FROM document_items di
       JOIN documents d ON d.id = di.document_id
       WHERE d.doc_type = 'sales_invoice' AND d.status = 'confirmed'
         AND COALESCE(d.confirmed_at, d.created_at) BETWEEN ? AND ?
         AND (? IS NULL OR d.branch_id = ?)`,
    )
    .get(bounds.from, bounds.to, branchId, branchId);

  return {
    invoices: row.invoices,
    revenue: round2(row.revenue),
    tax: round2(row.tax),
    cost: round2(cost.cost),
    unknownCostLines: cost.unknown_lines || 0,
  };
}

/**
 * What came back over the counter.
 *
 * Two shapes, and both belong on the screen. A wholly refunded order is struck
 * out — `orders` and `total` count those. A part of an order handed back leaves
 * the sale standing, and `partial` is what those returned lines were sold for.
 *
 * Reported rather than left implicit because the money is missing from revenue
 * either way, and an owner looking at a quiet month is owed the reason without
 * having to go and find it.
 */
function refunds(bounds, branchId = null) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total
       FROM orders WHERE status = 'refunded' AND created_at BETWEEN ? AND ?
         AND (? IS NULL OR branch_id = ?)`,
    )
    .get(bounds.from, bounds.to, branchId, branchId);

  const part = db
    .prepare(
      `SELECT COALESCE(SUM(
                CASE WHEN oi.quantity > 0
                     THEN oi.line_total * oi.returned_qty / oi.quantity
                     ELSE 0 END
              ), 0) AS total,
              COUNT(DISTINCT o.id) AS orders
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status = 'completed' AND oi.returned_qty > 0
         AND o.created_at BETWEEN ? AND ?
         AND (? IS NULL OR o.branch_id = ?)`,
    )
    .get(bounds.from, bounds.to, branchId, branchId);

  return {
    orders: row.orders,
    total: round2(row.total),
    partialOrders: part.orders,
    partial: round2(part.total),
  };
}

/**
 * The products that made the most.
 *
 * Both counters, not just the register. A month whose whole trade went out on
 * sales invoices used to show "Nothing sold in this period" directly underneath
 * a revenue figure of a hundred and twenty-eight dollars, which reads as the
 * report being broken — and on a shop that invoices its trade customers, that
 * is most of the month.
 *
 * Returned quantities come off here for the same reason they come off revenue:
 * a phone that came back is not one of the things that made the shop money.
 * Scoped to the branch as well, so this table agrees with the totals above it
 * instead of quietly reporting the whole company.
 */
function byProduct(bounds, limit = 10, branchId = null) {
  return db
    .prepare(
      `SELECT p.id, p.name, p.sku,
              SUM(s.quantity) AS quantity,
              ROUND(SUM(s.revenue), 2) AS revenue,
              ROUND(SUM(s.cost), 2) AS cost
       FROM (
         SELECT oi.product_id,
                (oi.quantity - oi.returned_qty) AS quantity,
                CASE WHEN oi.quantity > 0
                     THEN oi.line_total * (oi.quantity - oi.returned_qty) / oi.quantity
                     ELSE oi.line_total END AS revenue,
                (oi.quantity - oi.returned_qty) * COALESCE(oi.cost, 0) AS cost
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.status = 'completed' AND o.created_at BETWEEN ? AND ?
           AND (? IS NULL OR o.branch_id = ?)

         UNION ALL

         SELECT di.product_id,
                di.quantity AS quantity,
                di.line_total AS revenue,
                di.quantity * COALESCE(di.cost, 0) AS cost
         FROM document_items di
         JOIN documents d ON d.id = di.document_id
         WHERE d.doc_type = 'sales_invoice' AND d.status = 'confirmed'
           AND COALESCE(d.confirmed_at, d.created_at) BETWEEN ? AND ?
           AND (? IS NULL OR d.branch_id = ?)
       ) s
       JOIN products p ON p.id = s.product_id
       GROUP BY p.id
       HAVING SUM(s.quantity) > 0
       ORDER BY (SUM(s.revenue) - SUM(s.cost)) DESC
       LIMIT ?`,
    )
    .all(
      bounds.from, bounds.to, branchId, branchId,
      bounds.from, bounds.to, branchId, branchId,
      limit,
    )
    .map((r) => ({ ...r, profit: round2(r.revenue - r.cost) }));
}

/**
 * The same total, day by day.
 *
 * The report is one number, and a number a shopkeeper cannot make add up is a
 * number they stop believing — "it says $650 on the register and something
 * else here" has no answer if the only thing on the screen is the answer. So
 * the days are listed: the total is the column, and any day that looks wrong
 * can be opened in Sales and counted by hand.
 *
 * Grouped on the *shop's* day, so the rows are the days the shop worked rather
 * than UTC's — see lib/shopTime.js.
 *
 * Built from exactly the same expressions as the totals above, in one union,
 * so the two cannot drift apart: revenue rows carry no cost and cost rows
 * carry no revenue, and the group-by adds them up.
 */
function byDay(bounds, branchId = null, limit = 400) {
  const shift = sqlDayShift(bounds.zone);
  return db
    .prepare(
      `SELECT s.day,
              ROUND(SUM(s.revenue), 2) AS revenue,
              ROUND(SUM(s.cost), 2) AS cost,
              SUM(s.sales) AS sales
       FROM (
         SELECT date(o.created_at, ?) AS day,
                o.total * COALESCE(k.kept, 1.0) AS revenue, 0 AS cost, 1 AS sales
         FROM orders o
         LEFT JOIN (
           SELECT order_id,
                  CASE
                    WHEN COALESCE(SUM(line_total), 0) = 0 THEN 1.0
                    ELSE SUM(
                           CASE WHEN quantity > 0
                                THEN line_total * (quantity - returned_qty) / quantity
                                ELSE line_total END
                         ) / SUM(line_total)
                  END AS kept
           FROM order_items GROUP BY order_id
         ) k ON k.order_id = o.id
         WHERE o.status = 'completed' AND o.created_at BETWEEN ? AND ?
           AND (? IS NULL OR o.branch_id = ?)

         UNION ALL

         SELECT date(o.created_at, ?), 0,
                (oi.quantity - oi.returned_qty) * COALESCE(oi.cost, 0), 0
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.status = 'completed' AND o.created_at BETWEEN ? AND ?
           AND (? IS NULL OR o.branch_id = ?)

         UNION ALL

         SELECT date(COALESCE(d.confirmed_at, d.created_at), ?), d.total, 0, 1
         FROM documents d
         WHERE d.doc_type = 'sales_invoice' AND d.status = 'confirmed'
           AND COALESCE(d.confirmed_at, d.created_at) BETWEEN ? AND ?
           AND (? IS NULL OR d.branch_id = ?)

         UNION ALL

         SELECT date(COALESCE(d.confirmed_at, d.created_at), ?), 0,
                di.quantity * COALESCE(di.cost, 0), 0
         FROM document_items di
         JOIN documents d ON d.id = di.document_id
         WHERE d.doc_type = 'sales_invoice' AND d.status = 'confirmed'
           AND COALESCE(d.confirmed_at, d.created_at) BETWEEN ? AND ?
           AND (? IS NULL OR d.branch_id = ?)
       ) s
       GROUP BY s.day
       ORDER BY s.day DESC
       LIMIT ?`,
    )
    .all(
      shift, bounds.from, bounds.to, branchId, branchId,
      shift, bounds.from, bounds.to, branchId, branchId,
      shift, bounds.from, bounds.to, branchId, branchId,
      shift, bounds.from, bounds.to, branchId, branchId,
      limit,
    )
    .map((r) => ({ ...r, profit: round2(r.revenue - r.cost) }));
}

/**
 * The whole report.
 *
 * `includeExpenses` exists because the two figures answer different questions:
 * gross profit says whether the pricing works, net profit says whether the shop
 * does. Both are worth seeing, so neither is hidden.
 */
/**
 * `branchId` narrows this to one shop; null is the whole company, which is what
 * the owner wants to see and what a single-branch shop always gets.
 */
export function profitReport({ from = null, to = null, includeExpenses = true, branchId = null } = {}) {
  const bounds = periodBounds({ from, to });

  const register = registerSales(bounds, branchId);
  const invoices = invoiceSales(bounds, branchId);
  const refunded = refunds(bounds, branchId);

  const revenue = round2(register.revenue + invoices.revenue);
  const cost = round2(register.cost + invoices.cost);
  const grossProfit = round2(revenue - cost);

  const expenses = includeExpenses
    ? expenseSummary({ from: bounds.fromDate, to: bounds.toDate, branchId })
    : { total: 0, count: 0, byCategory: [] };

  const netProfit = round2(grossProfit - expenses.total);

  return {
    period: { from: bounds.fromDate, to: bounds.toDate, zone: bounds.zone },
    branchId,
    includeExpenses,
    /* The same total, day by day — so it can be checked rather than believed. */
    byDay: byDay(bounds, branchId),
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
    topProducts: byProduct(bounds, 10, branchId),
    /*
     * Sales made before costs were recorded on the line have no cost to
     * subtract, so their profit is overstated. Saying so is better than
     * quietly reporting a number that is too good.
     */
    unknownCostLines: register.unknownCostLines + invoices.unknownCostLines,
  };
}

/** The same report for one sitting of the till, from its own start and end. */
export function profitForSession(sessionId, { includeExpenses = true, branchId = null } = {}) {
  const session = sessionById(sessionId);
  if (!session) return null;

  const bounds = {
    from: session.opened_at,
    to: session.closed_at || '9999-12-31',
    fromDate: session.opened_at.slice(0, 10),
    toDate: (session.closed_at || '9999-12-31').slice(0, 10),
    zone: shopZone(),
  };

  const register = registerSales(bounds, branchId);
  const invoices = invoiceSales(bounds, branchId);
  const revenue = round2(register.revenue + invoices.revenue);
  const cost = round2(register.cost + invoices.cost);
  const grossProfit = round2(revenue - cost);

  /*
   * What was written down while the drawer was open — by the clock, not by the
   * date.
   *
   * It used to be every expense *dated* on the days the sitting touched, which
   * is two different wrongs at once: the bill paid at eight went against the
   * cashier who opened at nine, and a drawer still open counted everything
   * from its opening day to the end of time, because the sitting's end date is
   * 9999-12-31 until somebody closes it.
   */
  const expenses = includeExpenses
    ? expensesDuring({ from: bounds.from, to: session.closed_at || null, branchId })
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
    // Scoped like every other figure on this report — the sitting belongs to one
    // counter, and another branch's refunds are not part of it.
    refunds: refunds(bounds, branchId),
    topProducts: byProduct(bounds, 10, branchId),
    unknownCostLines: register.unknownCostLines + invoices.unknownCostLines,
  };
}

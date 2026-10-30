import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { can } from '../lib/permissions.js';
import { dayEndUtc, dayStartUtc, rangeShift, shopZone } from '../lib/shopTime.js';
import { branchScope } from '../lib/branchScope.js';

const router = Router();

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Every line sold, with its cost and the minute it went out.
 *
 * The takings say what the day came to; this says what left the shop line by
 * line — which handset, at what price, costing what, rung up by whom and at
 * what time — so a shop can read its day the way it happened. Register
 * sales and confirmed sales invoices both, because the shop sells on both
 * and a report that showed one of them would be read as the whole.
 *
 * For whoever is at the counter, because "what did we sell today" is asked
 * there. The cost column is behind the catalogue permission, the same gate
 * as everywhere else cost is shown, and it is stripped here rather than
 * hidden on the screen.
 *
 * A refunded sale stays on the list, marked, and counts for nothing in the
 * totals; a line partly returned counts for what is still out.
 */
router.get('/items-sold', requireAuth, (req, res) => {
  const { from = null, to = null } = req.query;
  const branchId = branchScope(req);
  const seesCost = can(req.user, 'catalogue');

  const when = [];
  const params = [];
  if (from) {
    when.push('>= ?');
    params.push(dayStartUtc(from));
  }
  if (to) {
    when.push('<= ?');
    params.push(dayEndUtc(to));
  }
  const dated = (column) => when.map((w) => `${column} ${w}`).join(' AND ');
  const clause = (column) => (when.length ? ` AND ${dated(column)}` : '');

  const receipts = db
    .prepare(
      `SELECT oi.id, 'receipt' AS source, o.id AS order_id, NULL AS document_id,
              o.order_number AS number, o.created_at AS at, o.status,
              oi.product_id, oi.name, p.sku, oi.quantity, COALESCE(oi.returned_qty, 0) AS returned_qty,
              oi.price, oi.line_total, oi.cost, COALESCE(oi.is_gift, 0) AS is_gift,
              u.imei, u.imei2, p.unit_kind,
              usr.name AS sold_by, COALESCE(c.name, o.buyer_name) AS customer_name, o.branch_id
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN products p ON p.id = oi.product_id
         LEFT JOIN product_units u ON u.id = oi.unit_id
         LEFT JOIN users usr ON usr.id = o.cashier_id
         LEFT JOIN customers c ON c.id = o.customer_id
        WHERE (? IS NULL OR o.branch_id = ?)${clause('o.created_at')}
        ORDER BY o.created_at DESC, oi.id DESC
        LIMIT 2000`,
    )
    .all(branchId, branchId, ...params);

  const invoices = db
    .prepare(
      `SELECT di.id, 'invoice' AS source, NULL AS order_id, d.id AS document_id,
              d.doc_number AS number, COALESCE(d.confirmed_at, d.created_at) AS at, d.status,
              di.product_id, di.name, di.sku, di.quantity, 0 AS returned_qty,
              di.price, di.line_total, di.cost, 0 AS is_gift,
              NULL AS imei, NULL AS imei2, p.unit_kind, di.imeis,
              usr.name AS sold_by, c.name AS customer_name, d.branch_id
         FROM document_items di
         JOIN documents d ON d.id = di.document_id
         LEFT JOIN products p ON p.id = di.product_id
         LEFT JOIN users usr ON usr.id = d.user_id
         LEFT JOIN customers c ON c.id = d.party_id AND d.party_type = 'customer'
        WHERE d.doc_type = 'sales_invoice' AND d.status = 'confirmed'
          AND (? IS NULL OR d.branch_id = ?)${clause("COALESCE(d.confirmed_at, d.created_at)")}
        ORDER BY at DESC, di.id DESC
        LIMIT 2000`,
    )
    .all(branchId, branchId, ...params);

  const rows = [...receipts, ...invoices]
    .map((r) => {
      const quantity = Number(r.quantity) || 0;
      const stillOut = r.status === 'refunded' ? 0 : Math.max(0, quantity - (Number(r.returned_qty) || 0));
      const share = quantity > 0 ? stillOut / quantity : 0;
      const unitCost = r.cost === null || r.cost === undefined ? null : round2(r.cost);
      const row = {
        ...r,
        price: round2(r.price),
        line_total: round2(r.line_total),
        net_quantity: stillOut,
        net_total: round2((Number(r.line_total) || 0) * share),
        cost: unitCost,
        cost_total: unitCost === null ? null : round2(unitCost * stillOut),
      };
      row.profit = unitCost === null ? null : round2(row.net_total - row.cost_total);
      if (!seesCost) {
        delete row.cost;
        delete row.cost_total;
        delete row.profit;
      }
      return row;
    })
    .sort((a, b) => String(b.at).localeCompare(String(a.at)) || b.id - a.id);

  const totals = rows.reduce(
    (t, r) => {
      t.quantity += r.net_quantity;
      t.sold = round2(t.sold + r.net_total);
      if (seesCost && r.cost_total !== null) t.cost = round2(t.cost + r.cost_total);
      return t;
    },
    { lines: rows.length, quantity: 0, sold: 0, cost: 0 },
  );
  if (seesCost) totals.profit = round2(totals.sold - totals.cost);
  else {
    delete totals.cost;
  }

  res.json({ rows, totals, seesCost, from, to, branchId });
});

router.get('/summary', requireAuth, requirePermission('reports'), (req, res) => {
  const { from, to } = req.query;
  let where = "WHERE status = 'completed'";
  let whereJoined = "WHERE o.status = 'completed'";
  const params = [];
  if (from) {
    where += ' AND created_at >= ?';
    whereJoined += ' AND o.created_at >= ?';
    params.push(from);
  }
  if (to) {
    where += ' AND created_at <= ?';
    whereJoined += ' AND o.created_at <= ?';
    params.push(to);
  }
  const joinedParams = [];
  if (from) joinedParams.push(from);
  if (to) joinedParams.push(to);

  /*
   * The shop being asked about. `branch=all` is the owner looking at the whole
   * company; anything else is the counter they are standing at, because a branch
   * manager reading the other branch's takings as their own is worse than no
   * dashboard at all.
   */
  const branchId = req.query.branch === 'all' && can(req.user, 'branches') ? null : req.branchId;
  where += ' AND (? IS NULL OR branch_id = ?)';
  whereJoined += ' AND (? IS NULL OR o.branch_id = ?)';
  params.push(branchId, branchId);
  joinedParams.push(branchId, branchId);

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(total), 0) AS revenue,
      COALESCE(SUM(tax), 0) AS taxCollected,
      COALESCE(SUM(discount), 0) AS discountsGiven,
      COUNT(*) AS orderCount
    FROM orders ${where}
  `).get(...params);

  /*
   * Read in the shop's own time, not UTC's.
   *
   * Both of these bucket a timestamp — one into a day, one into an hour of the
   * day — and both were doing it on the raw UTC value. Three hours east of
   * Greenwich that puts the evening's takings on tomorrow's bar and reports a
   * shop that is busiest at three in the afternoon when it is busiest at six.
   */
  const shift = rangeShift(from, to, shopZone());

  const byDay = db.prepare(`
    SELECT date(created_at, ?) AS day, COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
    FROM orders ${where}
    GROUP BY day
    ORDER BY day DESC
    LIMIT 90
  `).all(shift, ...params);

  const topProducts = db.prepare(`
    SELECT oi.name, SUM(oi.quantity) AS unitsSold, SUM(oi.line_total) AS revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    ${whereJoined}
    GROUP BY oi.name
    ORDER BY unitsSold DESC
    LIMIT 5
  `).all(...joinedParams);

  const lowStock = db
    .prepare(
      /* Cards have no stock to reorder — what runs low is their wallet, which
         says so on its own screen and on the register tile. */
      /* What is low **here**: a shelf that is empty at this counter is empty,
         whatever the other branch happens to be holding. */
      `SELECT p.id, p.name, p.sku, COALESCE(bs.stock, 0) AS stock, p.reorder_point
       FROM products p
       LEFT JOIN branch_stock bs ON bs.product_id = p.id AND bs.branch_id = ?
       WHERE p.active = 1 AND p.wallet_id IS NULL AND COALESCE(bs.stock, 0) <= p.reorder_point
       ORDER BY stock ASC, p.name LIMIT 12`,
    )
    .all(branchId ?? req.branchId);

  const paymentMix = db
    .prepare(
      `SELECT payment_method, COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
       FROM orders ${where}
       GROUP BY payment_method`,
    )
    .all(...params);

  /*
   * Of the electronic money, how much came through which app. A Whish
   * transfer and a bank card are both "card" to the drawer; the shop
   * reconciling its Whish balance wants them apart.
   */
  const paymentApps = db
    .prepare(
      `SELECT op.label,
              COALESCE(SUM(op.amount_usd + CASE WHEN COALESCE(o.exchange_rate, 0) > 0
                                                THEN op.amount_lbp / o.exchange_rate ELSE 0 END), 0) AS revenue,
              COUNT(DISTINCT o.id) AS orders
         FROM order_payments op
         JOIN orders o ON o.id = op.order_id
         ${whereJoined} AND op.method = 'card' AND op.label IS NOT NULL AND op.label != ''
        GROUP BY op.label
        ORDER BY revenue DESC`,
    )
    .all(...joinedParams);

  /*
   * When the shop is busy.
   *
   * A shopkeeper decides who is on the counter on Saturday afternoon and
   * whether it is worth opening at nine, and neither question is answerable
   * from a daily total. Hours with nothing in them are left out rather than
   * filled with zeroes — the shop was shut, which is not the same as quiet.
   */
  const byHour = db
    .prepare(
      `SELECT CAST(strftime('%H', created_at, ?) AS INTEGER) AS hour,
              COUNT(*) AS orders,
              COALESCE(SUM(total), 0) AS revenue
       FROM orders ${where}
       GROUP BY hour ORDER BY hour`,
    )
    .all(shift, ...params);

  /*
   * Money asleep on the shelf.
   *
   * The opposite question to "what sells": what has been sitting there through
   * the whole period without moving, and what is it worth at cost. This is the
   * figure that decides a clearance, and no screen in the app was answering it
   * — a shop can see what is running out and not what it is stuck with.
   *
   * Cards are left out: they are sold from a balance rather than a shelf and
   * cannot sit still.
   */
  /*
   * Counted on this branch's shelf, like everything else on this screen.
   *
   * `products.stock` is the company-wide mirror, and reading it here told a
   * branch manager they had money asleep on a shelf that is in the other shop.
   * When the owner asks for all branches the mirror is exactly right, so that
   * is the one case it is used.
   */
  const shelf = branchId === null ? 'p.stock' : 'COALESCE(bs.stock, 0)';
  const shelfJoin =
    branchId === null ? '' : 'LEFT JOIN branch_stock bs ON bs.product_id = p.id AND bs.branch_id = ?';
  const shelfParams = branchId === null ? [] : [branchId];

  const slowMovers = db
    .prepare(
      `SELECT p.id, p.name, p.sku, ${shelf} AS stock, p.cost,
              ROUND(${shelf} * p.cost, 2) AS tiedUp
       FROM products p
       ${shelfJoin}
       WHERE p.active = 1 AND ${shelf} > 0 AND p.wallet_id IS NULL
         AND p.id NOT IN (
           SELECT oi.product_id FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           ${whereJoined} AND oi.product_id IS NOT NULL
         )
       ORDER BY tiedUp DESC, p.name
       LIMIT 10`,
    )
    .all(...shelfParams, ...joinedParams);

  res.json({
    revenue: totals.revenue,
    taxCollected: totals.taxCollected,
    discountsGiven: totals.discountsGiven,
    orderCount: totals.orderCount,
    averageOrderValue: totals.orderCount ? Math.round((totals.revenue / totals.orderCount) * 100) / 100 : 0,
    byDay: byDay.slice().reverse(),
    topProducts,
    lowStock,
    paymentMix,
    paymentApps,
    byHour,
    slowMovers,
    // What the shelf that is not moving is worth altogether, so the panel can
    // lead with the figure rather than making somebody add ten rows up.
    tiedUp: Math.round(slowMovers.reduce((sum, p) => sum + p.tiedUp, 0) * 100) / 100,
  });
});

export default router;

import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { can } from '../lib/permissions.js';

const router = Router();

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

  const byDay = db.prepare(`
    SELECT date(created_at) AS day, COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
    FROM orders ${where}
    GROUP BY date(created_at)
    ORDER BY day DESC
    LIMIT 90
  `).all(...params);

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
   * When the shop is busy.
   *
   * A shopkeeper decides who is on the counter on Saturday afternoon and
   * whether it is worth opening at nine, and neither question is answerable
   * from a daily total. Hours with nothing in them are left out rather than
   * filled with zeroes — the shop was shut, which is not the same as quiet.
   */
  const byHour = db
    .prepare(
      `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour,
              COUNT(*) AS orders,
              COALESCE(SUM(total), 0) AS revenue
       FROM orders ${where}
       GROUP BY hour ORDER BY hour`,
    )
    .all(...params);

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
    byHour,
    slowMovers,
    // What the shelf that is not moving is worth altogether, so the panel can
    // lead with the figure rather than making somebody add ten rows up.
    tiedUp: Math.round(slowMovers.reduce((sum, p) => sum + p.tiedUp, 0) * 100) / 100,
  });
});

export default router;

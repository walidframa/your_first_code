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
  });
});

export default router;

import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.get('/summary', requireAuth, requireRole('admin'), (req, res) => {
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
      `SELECT id, name, sku, stock, reorder_point FROM products
       WHERE active = 1 AND stock <= reorder_point
       ORDER BY stock ASC, name LIMIT 12`,
    )
    .all();

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

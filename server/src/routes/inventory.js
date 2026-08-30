import { Router } from 'express';
import { db, transaction, ADJUSTMENT_REASONS } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { branchParams, branchScope } from '../lib/branchScope.js';
import { moveStock, stockAt, stockMap } from '../lib/stock.js';

const router = Router();

router.get('/reasons', requireAuth, (req, res) => {
  res.json({ reasons: ADJUSTMENT_REASONS });
});

/** Inventory overview: stock levels with derived status and value on hand. */
router.get('/', requireAuth, requirePermission('inventory'), (req, res) => {
  /*
   * The shelf being counted is **this branch's**.
   *
   * `products.stock` is the company-wide mirror — what is owned altogether,
   * kept for the questions that really are company-wide. Reading it here was
   * the bug: a shop with two branches saw one number on both screens, so goods
   * imported at one counter appeared to be sitting at the other as well, and
   * "what do I need to order" was being answered with stock nobody at that
   * counter could sell. The register has always asked per branch; this screen
   * now asks the same question.
   *
   * `branch=all` is the owner deliberately looking at the whole company, and
   * that is the one case where the mirror is the right figure.
   */
  const branchId = branchScope(req);
  const here = branchId === null ? null : stockMap(branchId);

  const products = db
    .prepare(
      `SELECT p.*, c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       /* Cards are sold from a wallet, not off a shelf. Listing them here would
          add a screenful of permanent "out of stock" to the one screen whose
          job is to show what genuinely needs reordering. */
       WHERE p.active = 1 AND p.wallet_id IS NULL`,
    )
    .all()
    .map((p) => ({
      ...p,
      /*
       * Kept alongside, because the first thing this fix does is make one
       * branch's screen go empty. "None here, six at the other shop" is the
       * answer that stops a needless order; a bare zero is not.
       */
      total_stock: p.stock,
      stock: here ? (here.get(p.id) ?? 0) : p.stock,
    }))
    /* Sorted on the branch's own figure — what needs reordering here, first. */
    .sort(
      (a, b) =>
        Number(b.stock <= b.reorder_point) - Number(a.stock <= a.reorder_point) ||
        a.stock - b.stock ||
        a.name.localeCompare(b.name),
    );

  const totals = products.reduce(
    (acc, p) => {
      acc.units += p.stock;
      acc.retailValue += p.stock * p.price;
      acc.costValue += p.stock * p.cost;
      if (p.stock <= 0) acc.outOfStock += 1;
      else if (p.stock <= p.reorder_point) acc.lowStock += 1;
      return acc;
    },
    { units: 0, retailValue: 0, costValue: 0, outOfStock: 0, lowStock: 0 },
  );

  res.json({
    products,
    totals: {
      ...totals,
      retailValue: Math.round(totals.retailValue * 100) / 100,
      costValue: Math.round(totals.costValue * 100) / 100,
      skuCount: products.length,
    },
  });
});

/** Recent stock movements across all products. */
router.get('/movements', requireAuth, requirePermission('inventory'), (req, res) => {
  const { productId, limit } = req.query;
  const max = Math.min(Number(limit) || 100, 500);

  /*
   * A correction was made by somebody standing at one counter, with the goods
   * in their hand. Listing the other branch's alongside it turns the history of
   * this shelf into a history of two, and the running figure beside each line
   * stops making sense.
   */
  const branch = branchParams(req);

  const rows = productId
    ? db
        .prepare(
          `SELECT a.*, p.name AS product_name, p.sku, u.name AS user_name
           FROM stock_adjustments a
           JOIN products p ON p.id = a.product_id
           LEFT JOIN users u ON u.id = a.user_id
           WHERE a.product_id = ? AND (? IS NULL OR a.branch_id = ?)
           ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
        )
        .all(productId, ...branch, max)
    : db
        .prepare(
          `SELECT a.*, p.name AS product_name, p.sku, u.name AS user_name
           FROM stock_adjustments a
           JOIN products p ON p.id = a.product_id
           LEFT JOIN users u ON u.id = a.user_id
           WHERE (? IS NULL OR a.branch_id = ?)
           ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
        )
        .all(...branch, max);

  res.json({ movements: rows });
});

/** Apply a stock adjustment and record it in the ledger. */
router.post('/adjust', requireAuth, requirePermission('inventory'), (req, res) => {
  const { productId, delta, reason, note } = req.body || {};

  const change = Number(delta);
  if (!Number.isInteger(change) || change === 0) {
    return res.status(400).json({ error: 'delta must be a non-zero integer' });
  }
  if (!ADJUSTMENT_REASONS.includes(reason)) {
    return res.status(400).json({ error: `reason must be one of: ${ADJUSTMENT_REASONS.join(', ')}` });
  }

  try {
    const result = transaction(() => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product) throw new Error('Product not found');
      if (product.wallet_id) {
        throw new Error(`${product.name} is sold from a wallet — top the wallet up instead`);
      }

      /*
       * Counted at one counter. A correction is somebody standing in front of a
       * shelf with the goods in their hand, so it can only ever mean the shelf
       * they are standing at.
       */
      const here = stockAt(req.branchId, product.id);
      const resulting = here + change;
      if (resulting < 0) {
        throw new Error(`Adjustment would take ${product.name} below zero at this branch (stock ${here})`);
      }

      moveStock({ branchId: req.branchId, productId: product.id, delta: change });
      db.prepare(
        `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note, branch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(product.id, req.user.id, change, resulting, reason, note || null, req.branchId);

      return resulting;
    })();

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    res.json({ product, resultingStock: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;

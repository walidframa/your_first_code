import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { activityFor, costHistoryFor, recordCostChange } from '../lib/costHistory.js';

const router = Router();

function serializeProduct(p) {
  return { ...p, active: !!p.active };
}

/**
 * Check a proposed wallet before it is written.
 *
 * Two things a product cannot be at once: sold from credit and counted by IMEI.
 * One has no quantity at all, the other has a quantity of exactly one with a
 * number stamped on it, and a product claiming both would satisfy neither.
 */
function walletProblem(walletId, tracksUnits) {
  if (walletId === undefined || walletId === null || walletId === '') return null;
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
  if (!wallet) return 'That wallet does not exist';
  if (!wallet.active) return `${wallet.name} is closed — pick another wallet`;
  if (tracksUnits) return 'A card is sold from credit, so it cannot also be tracked by IMEI';
  return null;
}

router.get('/categories', requireAuth, (req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
  res.json({ categories });
});

router.post('/categories', requireAuth, requireRole('admin'), (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const info = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name.trim());
    res.status(201).json({ category: { id: info.lastInsertRowid, name: name.trim() } });
  } catch {
    res.status(409).json({ error: 'Category already exists' });
  }
});

router.get('/', requireAuth, (req, res) => {
  const { activeOnly } = req.query;
  const rows = activeOnly === 'true'
    ? db.prepare(`
        SELECT p.*, c.name AS category_name, w.name AS wallet_name FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN wallets w ON w.id = p.wallet_id
        WHERE p.active = 1 ORDER BY p.name
      `).all()
    : db.prepare(`
        SELECT p.*, c.name AS category_name, w.name AS wallet_name FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN wallets w ON w.id = p.wallet_id
        ORDER BY p.name
      `).all();
  res.json({ products: rows.map(serializeProduct) });
});

/** Look up a single product by scanned barcode or exact SKU. */
router.get('/lookup', requireAuth, (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code is required' });

  const product = db
    .prepare(
      `SELECT p.*, c.name AS category_name, w.name AS wallet_name FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN wallets w ON w.id = p.wallet_id
       WHERE p.active = 1 AND (lower(p.sku) = lower(?) OR p.barcode = ?)
       LIMIT 1`,
    )
    .get(code, code);

  if (!product) return res.status(404).json({ error: `No product matches "${code}"` });
  res.json({ product: serializeProduct(product) });
});

router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  const {
    name, sku, price, cost, stock, category_id, image_emoji, barcode, supplier, image_url,
    reorder_point, tracks_units, warranty_months, wallet_id,
  } = req.body || {};
  if (!name || !sku || price == null) {
    return res.status(400).json({ error: 'name, sku and price are required' });
  }
  const problem = walletProblem(wallet_id, tracks_units);
  if (problem) return res.status(400).json({ error: problem });
  try {
    const info = db.prepare(`
      INSERT INTO products (name, sku, price, cost, stock, category_id, image_emoji, barcode, supplier, image_url, reorder_point, tracks_units, warranty_months, wallet_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      sku,
      Number(price),
      Number(cost) || 0,
      Number.isFinite(Number(stock)) ? Number(stock) : 0,
      category_id || null,
      image_emoji || '',
      barcode || null,
      supplier || null,
      image_url || null,
      Number.isFinite(Number(reorder_point)) ? Number(reorder_point) : 5,
      // Serialised stock starts empty whatever the form said: the handsets are
      // booked in by IMEI, and a typed opening quantity would be a number with
      // no phones behind it.
      tracks_units ? 1 : 0,
      Math.max(0, Math.round(Number(warranty_months) || 0)),
      wallet_id || null,
    );
    if (tracks_units) db.prepare('UPDATE products SET stock = 0 WHERE id = ?').run(info.lastInsertRowid);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ product: serializeProduct(product) });
  } catch (err) {
    res.status(409).json({ error: 'SKU already exists' });
  }
});

router.get('/:id', requireAuth, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json({ product: serializeProduct(product) });
});

router.put('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  /*
   * Switching how a product is counted is only safe from a standing start.
   * Turning tracking on with stock on hand would claim a number of handsets
   * with no IMEIs behind them; turning it off with units booked in would strand
   * them. Either way the shelf and the record would part company.
   */
  const switchingTracking =
    req.body.tracks_units !== undefined &&
    Boolean(req.body.tracks_units) !== Boolean(product.tracks_units);

  if (switchingTracking) {
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM product_units WHERE product_id = ?')
      .get(product.id);
    if (n > 0) {
      return res.status(400).json({ error: 'Remove this product\'s units before changing how it is counted' });
    }

    /*
     * Turning tracking on for a product that already has stock.
     *
     * The quantity on hand is a number with no handsets behind it, so it cannot
     * simply carry over — but refusing outright leaves a shop that already has
     * phones in its catalogue unable to start tracking them at all, which is
     * exactly when they want to. So the count is cleared, loudly and on the
     * record, and the handsets are booked in by IMEI afterwards.
     *
     * `convertStock` is required rather than assumed: silently zeroing stock
     * because a checkbox moved would be a stock count destroyed by a click.
     */
    if (product.stock > 0) {
      if (!req.body.convertStock) {
        return res.status(409).json({
          error:
            `${product.name} has ${product.stock} in stock. Switching to IMEI tracking clears that ` +
            'count so the handsets can be booked in by their numbers.',
          needsConvert: true,
          stock: product.stock,
        });
      }

      db.prepare('UPDATE products SET stock = 0 WHERE id = ?').run(product.id);
      db.prepare(
        `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        product.id,
        req.user.id,
        -product.stock,
        0,
        'count_correction',
        'Switched to IMEI tracking — book the handsets in by their numbers',
      );
      product.stock = 0;
    }
  }

  const fields = [
    'name', 'sku', 'price', 'cost', 'stock', 'category_id', 'image_emoji',
    'active', 'barcode', 'supplier', 'image_url', 'reorder_point', 'tracks_units',
    'warranty_months', 'wallet_id',
  ];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }

  const walletId = updates.wallet_id === undefined ? product.wallet_id : updates.wallet_id || null;
  const tracksUnits =
    updates.tracks_units === undefined ? product.tracks_units : updates.tracks_units;
  const walletIssue = walletProblem(walletId, tracksUnits);
  if (walletIssue) return res.status(400).json({ error: walletIssue });

  /*
   * A count on a product now sold from credit is a leftover, and would keep
   * showing "12 left" beside something that cannot run out.
   */
  if (walletId && !product.wallet_id) updates.stock = 0;

  // `product` is re-read above when the stock was cleared, so the merge cannot
  // put the old count back.
  const merged = { ...product, ...updates };
  if (switchingTracking && updates.tracks_units) merged.stock = 0;
  db.prepare(`
    UPDATE products SET name = ?, sku = ?, price = ?, cost = ?, stock = ?, category_id = ?, image_emoji = ?,
      active = ?, barcode = ?, supplier = ?, image_url = ?, reorder_point = ?, tracks_units = ?,
      warranty_months = ?, wallet_id = ?
    WHERE id = ?
  `).run(
    merged.name,
    merged.sku,
    Number(merged.price),
    Number(merged.cost) || 0,
    Number(merged.stock) || 0,
    merged.category_id || null,
    merged.image_emoji || '',
    merged.active ? 1 : 0,
    merged.barcode || null,
    merged.supplier || null,
    merged.image_url || null,
    Number.isFinite(Number(merged.reorder_point)) ? Number(merged.reorder_point) : 5,
    merged.tracks_units ? 1 : 0,
    Math.max(0, Math.round(Number(merged.warranty_months) || 0)),
    walletId || null,
    req.params.id
  );

  // A cost that moved is worth remembering; one that did not is noise.
  recordCostChange({
    productId: product.id,
    cost: Number(merged.cost) || 0,
    previousCost: product.cost,
    source: 'edited',
    userId: req.user.id,
  });

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json({ product: serializeProduct(updated) });
});

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/**
 * Everything that has happened to one product, in one list.
 *
 * Sales, deliveries, stock corrections and cost changes live in four tables;
 * a shopkeeper asking what happened to an item wants them in order, not in
 * four places.
 */
router.get('/:id/activity', requireAuth, requireRole('admin'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  res.json({
    product,
    activity: activityFor(product.id, req.query.limit),
    costHistory: costHistoryFor(product.id, req.query.limit),
  });
});

export default router;

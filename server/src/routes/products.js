import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

function serializeProduct(p) {
  return { ...p, active: !!p.active };
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
        SELECT p.*, c.name AS category_name FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.active = 1 ORDER BY p.name
      `).all()
    : db.prepare(`
        SELECT p.*, c.name AS category_name FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
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
      `SELECT p.*, c.name AS category_name FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.active = 1 AND (lower(p.sku) = lower(?) OR p.barcode = ?)
       LIMIT 1`,
    )
    .get(code, code);

  if (!product) return res.status(404).json({ error: `No product matches "${code}"` });
  res.json({ product: serializeProduct(product) });
});

router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  const { name, sku, price, cost, stock, category_id, image_emoji, barcode, supplier, image_url, reorder_point } =
    req.body || {};
  if (!name || !sku || price == null) {
    return res.status(400).json({ error: 'name, sku and price are required' });
  }
  try {
    const info = db.prepare(`
      INSERT INTO products (name, sku, price, cost, stock, category_id, image_emoji, barcode, supplier, image_url, reorder_point)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      Number.isFinite(Number(reorder_point)) ? Number(reorder_point) : 5
    );
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ product: serializeProduct(product) });
  } catch (err) {
    res.status(409).json({ error: 'SKU already exists' });
  }
});

router.put('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const fields = [
    'name', 'sku', 'price', 'cost', 'stock', 'category_id', 'image_emoji',
    'active', 'barcode', 'supplier', 'image_url', 'reorder_point',
  ];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }

  const merged = { ...product, ...updates };
  db.prepare(`
    UPDATE products SET name = ?, sku = ?, price = ?, cost = ?, stock = ?, category_id = ?, image_emoji = ?,
      active = ?, barcode = ?, supplier = ?, image_url = ?, reorder_point = ?
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
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json({ product: serializeProduct(updated) });
});

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;

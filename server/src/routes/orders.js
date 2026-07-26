import { Router } from 'express';
import crypto from 'crypto';
import { db, transaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
const TAX_RATE = Number(process.env.TAX_RATE || 0.08);

function round2(n) {
  return Math.round(n * 100) / 100;
}

router.get('/tax-rate', requireAuth, (req, res) => {
  res.json({ taxRate: TAX_RATE });
});

router.post('/', requireAuth, (req, res) => {
  const { items, discountPercent = 0, paymentMethod, amountTendered } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Cart must contain at least one item' });
  }
  if (!['cash', 'card'].includes(paymentMethod)) {
    return res.status(400).json({ error: 'paymentMethod must be cash or card' });
  }
  const discount = Number(discountPercent);
  if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
    return res.status(400).json({ error: 'discountPercent must be between 0 and 100' });
  }

  try {
    const result = transaction(() => {
      const lineItems = [];
      let subtotal = 0;

      for (const item of items) {
        const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(item.productId);
        if (!product) throw new Error(`Product ${item.productId} not found`);
        const quantity = Number(item.quantity);
        if (!Number.isInteger(quantity) || quantity <= 0) {
          throw new Error(`Invalid quantity for ${product.name}`);
        }
        if (product.stock < quantity) {
          throw new Error(`Not enough stock for ${product.name} (have ${product.stock}, need ${quantity})`);
        }
        const lineTotal = round2(product.price * quantity);
        subtotal += lineTotal;
        lineItems.push({ product, quantity, lineTotal });
      }

      subtotal = round2(subtotal);
      const discountAmount = round2(subtotal * (discount / 100));
      const taxableAmount = round2(subtotal - discountAmount);
      const tax = round2(taxableAmount * TAX_RATE);
      const total = round2(taxableAmount + tax);

      let amountTenderedValue = null;
      let changeDue = null;
      if (paymentMethod === 'cash') {
        amountTenderedValue = Number(amountTendered);
        if (!Number.isFinite(amountTenderedValue) || amountTenderedValue < total) {
          throw new Error('Amount tendered must be at least the total for cash payments');
        }
        changeDue = round2(amountTenderedValue - total);
      }

      const orderNumber = `ORD-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

      const orderInfo = db.prepare(`
        INSERT INTO orders (order_number, cashier_id, subtotal, discount, tax, total, payment_method, amount_tendered, change_due, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')
      `).run(orderNumber, req.user.id, subtotal, discountAmount, tax, total, paymentMethod, amountTenderedValue, changeDue);

      const orderId = orderInfo.lastInsertRowid;

      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, name, price, quantity, line_total)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const decrementStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');

      for (const li of lineItems) {
        insertItem.run(orderId, li.product.id, li.product.name, li.product.price, li.quantity, li.lineTotal);
        decrementStock.run(li.quantity, li.product.id);
      }

      return { orderId, orderNumber, subtotal, discountAmount, tax, total, changeDue };
    })();

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.orderId);
    const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(result.orderId);
    res.status(201).json({ order, items: orderItems });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/', requireAuth, (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT o.*, u.name AS cashier_name FROM orders o JOIN users u ON u.id = o.cashier_id WHERE 1=1';
  const params = [];

  if (req.user.role !== 'admin') {
    sql += ' AND o.cashier_id = ?';
    params.push(req.user.id);
  }
  if (from) {
    sql += ' AND o.created_at >= ?';
    params.push(from);
  }
  if (to) {
    sql += ' AND o.created_at <= ?';
    params.push(to);
  }
  sql += ' ORDER BY o.created_at DESC LIMIT 500';

  const orders = db.prepare(sql).all(...params);
  res.json({ orders });
});

router.get('/:id', requireAuth, (req, res) => {
  const order = db.prepare(`
    SELECT o.*, u.name AS cashier_name FROM orders o JOIN users u ON u.id = o.cashier_id WHERE o.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (req.user.role !== 'admin' && order.cashier_id !== req.user.id) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id);
  res.json({ order, items });
});

router.post('/:id/refund', requireAuth, requireRole('admin'), (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'refunded') return res.status(400).json({ error: 'Order already refunded' });

  transaction(() => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    const restock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
    for (const item of items) {
      if (item.product_id) restock.run(item.quantity, item.product_id);
    }
    db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(order.id);
  })();

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  res.json({ order: updated });
});

export default router;

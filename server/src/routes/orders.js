import { Router } from 'express';
import crypto from 'crypto';
import { db, transaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getSettings } from '../lib/settings.js';
import { addEntry, creditCheck } from '../lib/accounts.js';
import {
  CURRENCIES,
  round2,
  changeBreakdown,
  tenderTotals,
  validatePayments,
} from '../lib/currency.js';

const router = Router();
const TAX_RATE = Number(process.env.TAX_RATE || 0.08);

router.get('/tax-rate', requireAuth, (req, res) => {
  res.json({ taxRate: TAX_RATE });
});

router.post('/', requireAuth, (req, res) => {
  const {
    items,
    discountPercent = 0,
    paymentMethod,
    amountTendered,
    payments,
    changeCurrency = 'LBP',
    customerId = null,
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Cart must contain at least one item' });
  }
  if (!['cash', 'card', 'account'].includes(paymentMethod)) {
    return res.status(400).json({ error: 'paymentMethod must be cash, card or account' });
  }
  if (paymentMethod === 'account' && !customerId) {
    return res.status(400).json({ error: 'A customer is required for an account sale' });
  }
  const discount = Number(discountPercent);
  if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
    return res.status(400).json({ error: 'discountPercent must be between 0 and 100' });
  }
  if (!CURRENCIES.includes(changeCurrency)) {
    return res.status(400).json({ error: `changeCurrency must be one of: ${CURRENCIES.join(', ')}` });
  }

  const { exchange_rate: exchangeRate, lbp_rounding: lbpRounding } = getSettings();

  // A bare `amountTendered` is treated as a single USD cash leg, so older
  // clients keep working now that tender is a list.
  const tender =
    payments ?? (amountTendered !== undefined ? [{ currency: 'USD', amount: amountTendered }] : null);

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
      let paidUsd = 0;
      let paidLbp = 0;
      let changeUsd = 0;
      let changeLbp = 0;

      if (paymentMethod === 'account') {
        // Checked inside the transaction so a concurrent sale cannot slip the
        // customer past their limit between the check and the insert.
        const check = creditCheck(customerId, total);
        if (!check.ok) throw new Error(check.error);
      }

      if (paymentMethod === 'cash') {
        const invalid = validatePayments(tender || []);
        if (invalid) throw new Error(invalid);

        const totals = tenderTotals(tender, exchangeRate);
        if (totals.totalUsdEquivalent + 1e-9 < total) {
          throw new Error(
            `Tendered ${totals.totalUsdEquivalent.toFixed(2)} USD is less than the ${total.toFixed(2)} USD total`,
          );
        }

        paidUsd = totals.paidUsd;
        paidLbp = totals.paidLbp;
        amountTenderedValue = totals.totalUsdEquivalent;
        changeDue = round2(totals.totalUsdEquivalent - total);

        const breakdown = changeBreakdown(changeDue, changeCurrency, exchangeRate, lbpRounding);
        changeUsd = breakdown.changeUsd;
        changeLbp = breakdown.changeLbp;
      }

      const orderNumber = `ORD-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

      const orderInfo = db.prepare(`
        INSERT INTO orders (
          order_number, cashier_id, customer_id, subtotal, discount, tax, total, payment_method,
          amount_tendered, change_due, status,
          exchange_rate, paid_usd, paid_lbp, change_usd, change_lbp, change_currency
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)
      `).run(
        orderNumber, req.user.id, customerId || null, subtotal, discountAmount, tax, total, paymentMethod,
        amountTenderedValue, changeDue,
        exchangeRate, paidUsd, paidLbp, changeUsd, changeLbp,
        paymentMethod === 'cash' ? changeCurrency : null,
      );

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

      if (paymentMethod === 'account') {
        addEntry({
          partyType: 'customer',
          partyId: customerId,
          kind: 'sale',
          amountUsd: total,
          exchangeRate,
          orderId,
          note: orderNumber,
          userId: req.user.id,
        });
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
  let sql = `SELECT o.*, u.name AS cashier_name, c.name AS customer_name
    FROM orders o JOIN users u ON u.id = o.cashier_id
    LEFT JOIN customers c ON c.id = o.customer_id WHERE 1=1`;
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
    SELECT o.*, u.name AS cashier_name, c.name AS customer_name
    FROM orders o JOIN users u ON u.id = o.cashier_id
    LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?
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

    if (order.payment_method === 'account' && order.customer_id) {
      addEntry({
        partyType: 'customer',
        partyId: order.customer_id,
        kind: 'refund',
        amountUsd: -order.total,
        orderId: order.id,
        note: `Refund of ${order.order_number}`,
        userId: req.user.id,
      });
    }
  })();

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  res.json({ order: updated });
});

export default router;

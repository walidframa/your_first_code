import { Router } from 'express';
import crypto from 'crypto';
import { db, transaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { getSettings } from '../lib/settings.js';
import { addEntry, creditCheck } from '../lib/accounts.js';
import { currentSession, recordMovement, requiresSession } from '../lib/cash.js';
import { isAvailable, returnUnitsOfOrder, sellUnit, syncStockFromUnits } from '../lib/units.js';
import { chargeSale, refundOrder as refundWallets } from '../lib/wallets.js';
import { encryptSecret } from '../lib/secrets.js';
import {
  CHANGE_MODES,
  round2,
  changeBreakdown,
  combinedUsd,
  tenderTotals,
  validatePayments,
} from '../lib/currency.js';

/** What kind of account the shop set up for the customer. */
export const ACCOUNT_KINDS = ['icloud', 'gmail', 'other'];

const router = Router();
const TAX_RATE = Number(process.env.TAX_RATE || 0.08);

router.get('/tax-rate', requireAuth, (req, res) => {
  res.json({ taxRate: TAX_RATE });
});

router.post('/', requireAuth, requirePermission('register'), (req, res) => {
  const {
    items,
    discountPercent = 0,
    paymentMethod,
    amountTendered,
    payments,
    changeCurrency = 'LBP',
    changeUsd: requestedChangeUsd = null,
    changeLbp: requestedChangeLbp = null,
    customerId = null,
    buyerName = null,
    buyerPhone = null,
    accounts = [],
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
  // 'SPLIT' is a third way of giving change, not a third currency.
  if (!CHANGE_MODES.includes(changeCurrency)) {
    return res.status(400).json({ error: `changeCurrency must be one of: ${CHANGE_MODES.join(', ')}` });
  }
  if (changeCurrency === 'SPLIT' && (Number(requestedChangeUsd) < 0 || Number(requestedChangeLbp) < 0)) {
    return res.status(400).json({ error: 'Change given cannot be negative in either currency' });
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

      const claimedUnits = new Set();

      for (const item of items) {
        const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(item.productId);
        if (!product) throw new Error(`Product ${item.productId} not found`);
        const quantity = Number(item.quantity);
        if (!Number.isInteger(quantity) || quantity <= 0) {
          throw new Error(`Invalid quantity for ${product.name}`);
        }

        /*
         * A serialised product is sold one identified handset at a time. Two of
         * "an iPhone 13" is meaningless — it is this IMEI and that IMEI, each
         * with its own cost, so the cart carries a line per unit.
         */
        let unit = null;
        if (product.tracks_units) {
          if (!item.unitId) throw new Error(`Pick which ${product.name} — it is tracked by IMEI`);
          if (quantity !== 1) throw new Error(`${product.name} sells one unit per line`);

          unit = db.prepare('SELECT * FROM product_units WHERE id = ?').get(item.unitId);
          if (!unit || unit.product_id !== product.id) {
            throw new Error(`That unit is not a ${product.name}`);
          }
          if (!isAvailable(unit.status)) {
            throw new Error(`${unit.imei} is already ${unit.status.replace('_', ' ')}`);
          }
          // Two lines naming one handset would sell it twice and only take it
          // off the shelf once.
          if (claimedUnits.has(unit.id)) throw new Error(`${unit.imei} is on this sale twice`);
          claimedUnits.add(unit.id);
        } else {
          /*
           * A unit named against a product that is not serialised is a caller
           * bug, and ignoring it would be the worst kind: the sale would go
           * through, the handset would stay on the shelf, and whoever sent it
           * would believe otherwise.
           */
          if (item.unitId) throw new Error(`${product.name} is not tracked by IMEI`);
          /*
           * A card has no shelf to run out of. What limits it is the credit
           * behind it, and that is spent below rather than counted here — an
           * empty wallet is a bill to settle with the supplier, not a customer
           * to turn away at the counter.
           */
          if (!product.wallet_id && product.stock < quantity) {
            throw new Error(`Not enough stock for ${product.name} (have ${product.stock}, need ${quantity})`);
          }
        }

        /*
         * A gift still leaves the shop, so stock moves — but it is not revenue.
         * Charging zero and counting it as a sale at full price would flatter
         * the margin on every handset thrown in with a case.
         */
        const isGift = Boolean(item.isGift);

        /*
         * The price is haggled over at the counter, so the line carries what
         * was actually agreed rather than the catalogue figure. An override of
         * zero is meaningful — a phone given away is not the same as one at
         * list — so only `undefined` falls back.
         */
        const agreed =
          item.price === undefined || item.price === null ? product.price : Number(item.price);
        if (!Number.isFinite(agreed) || agreed < 0) {
          throw new Error(`${product.name} needs a price of zero or more`);
        }

        const lineDiscount = Math.max(0, Number(item.discount) || 0);
        if (lineDiscount > agreed * quantity) {
          throw new Error(`The discount on ${product.name} is more than the line comes to`);
        }

        const lineTotal = isGift ? 0 : round2(agreed * quantity - lineDiscount);
        subtotal += lineTotal;
        lineItems.push({ product, quantity, lineTotal, unit, isGift, price: agreed });
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
        /*
         * Cash needs a drawer to go into. Card and account sales do not touch
         * it, so they are left alone — refusing those would stop the shop
         * trading for no reason.
         */
        if (requiresSession() && !currentSession()) {
          throw new Error('The cashbox is closed — open it before taking cash');
        }

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

        const breakdown = changeBreakdown(
          changeDue,
          changeCurrency,
          exchangeRate,
          lbpRounding,
          requestedChangeUsd,
          requestedChangeLbp,
        );
        changeUsd = breakdown.changeUsd;
        changeLbp = breakdown.changeLbp;

        /*
         * Both halves of a split are the cashier's to name, so the two together
         * can miss the exact change by whatever rounding to a giveable note
         * costs. Anything beyond that is a slipped digit — 25,000,000 LL where
         * 2,500,000 was meant — and the shop should not pay for it silently.
         */
        if (changeCurrency === 'SPLIT') {
          const given = combinedUsd(changeUsd, changeLbp, exchangeRate);
          const slack = round2(lbpRounding / exchangeRate) + 0.01;
          if (given > changeDue + slack) {
            throw new Error(
              `Change of ${given.toFixed(2)} USD is more than the ${changeDue.toFixed(2)} USD owed`,
            );
          }
        }
      }

      const orderNumber = `ORD-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

      const orderInfo = db.prepare(`
        INSERT INTO orders (
          order_number, cashier_id, customer_id, subtotal, discount, tax, total, payment_method,
          amount_tendered, change_due, status,
          exchange_rate, paid_usd, paid_lbp, change_usd, change_lbp, change_currency,
          buyer_name, buyer_phone
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderNumber, req.user.id, customerId || null, subtotal, discountAmount, tax, total, paymentMethod,
        amountTenderedValue, changeDue,
        exchangeRate, paidUsd, paidLbp, changeUsd, changeLbp,
        paymentMethod === 'cash' ? changeCurrency : null,
        buyerName?.trim() || null,
        buyerPhone?.trim() || null,
      );

      const orderId = orderInfo.lastInsertRowid;

      // The cost is copied onto the line, not looked up later: profit for a
      // sale made last month must not change when a supplier puts a price up.
      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, name, price, quantity, line_total, cost, unit_id, is_gift)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const decrementStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');

      for (const li of lineItems) {
        /*
         * A serialised line carries the cost of the handset that left, not the
         * product's average — the point of tracking units is that this one's
         * margin is its own.
         */
        const cost = li.unit ? li.unit.cost : (li.product.cost ?? null);
        insertItem.run(
          orderId, li.product.id, li.product.name, li.isGift ? 0 : li.price, li.quantity,
          li.lineTotal, cost, li.unit?.id ?? null, li.isGift ? 1 : 0,
        );

        if (li.unit) {
          sellUnit(li.unit.id, li.product.id, orderId);
          /*
           * The warranty is copied onto the handset as it leaves, not read from
           * the product later. Shortening the shop's policy tomorrow must not
           * shorten the cover somebody is already holding.
           */
          db.prepare(
            `UPDATE product_units SET warranty_months = ?, warranty_starts = date('now') WHERE id = ?`,
          ).run(li.product.warranty_months ?? 0, li.unit.id);
          // Stock is recounted from the units rather than decremented, so the
          // two can never drift apart.
          syncStockFromUnits(li.product.id);
        } else if (li.product.wallet_id) {
          /*
           * The wallet is this product's stock, so selling a card spends it.
           * A gift is spent too: giving a recharge away still uses the credit
           * the shop paid for, even though nothing is charged for it.
           */
          chargeSale({
            walletId: li.product.wallet_id,
            product: li.product,
            quantity: li.quantity,
            orderId,
            userId: req.user.id,
          });
        } else {
          decrementStock.run(li.quantity, li.product.id);
        }
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

      /*
       * Accounts the shop set up on the customer's behalf. The password is
       * encrypted before it touches the table; only the username is searchable,
       * which is what the counter has when someone comes back.
       */
      if (Array.isArray(accounts) && accounts.length > 0) {
        const insertAccount = db.prepare(
          `INSERT INTO order_accounts (order_id, unit_id, kind, username, password_enc, note)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const a of accounts) {
          const username = String(a?.username ?? '').trim();
          if (!username) continue;
          if (!ACCOUNT_KINDS.includes(a?.kind)) {
            throw new Error(`Account type must be one of: ${ACCOUNT_KINDS.join(', ')}`);
          }
          // Only against a handset actually on this sale — an account pinned to
          // someone else's phone would surface under the wrong IMEI later.
          const unitId = a.unitId && claimedUnits.has(a.unitId) ? a.unitId : null;
          insertAccount.run(orderId, unitId, a.kind, username, encryptSecret(a.password), a.note || null);
        }
      }

      /*
       * What actually stayed in the drawer: taken less change given back, per
       * currency. A $20 note for a $7 sale with change in pounds leaves the
       * drawer $20 heavier and its pounds lighter, and both need recording or
       * the count will not add up.
       */
      if (paymentMethod === 'cash') {
        recordMovement({
          kind: 'sale',
          amountUsd: round2(paidUsd - changeUsd),
          amountLbp: paidLbp - changeLbp,
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

router.post('/:id/refund', requireAuth, requirePermission('refunds'), (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'refunded') return res.status(400).json({ error: 'Order already refunded' });

  transaction(() => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    const restock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');

    /*
     * Cards never came off a shelf, so nothing goes back on one — the credit is
     * returned to the wallet instead. Read from what was actually spent rather
     * than from the product as it stands today, in case it has since been
     * pointed at a different wallet.
     */
    const fromWallet = new Set(
      db
        .prepare("SELECT DISTINCT product_id FROM wallet_movements WHERE order_id = ? AND kind = 'sale'")
        .all(order.id)
        .map((r) => r.product_id),
    );

    for (const item of items) {
      // Serialised lines are put back by identity below; adding to `stock` here
      // as well would count the returned handset twice.
      if (item.product_id && !item.unit_id && !fromWallet.has(item.product_id)) {
        restock.run(item.quantity, item.product_id);
      }
    }
    returnUnitsOfOrder(order.id);
    refundWallets(order.id, req.user.id);
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

    // Refunding a cash sale hands money back across the counter.
    if (order.payment_method === 'cash') {
      recordMovement({
        kind: 'refund',
        amountUsd: -round2(order.paid_usd - order.change_usd),
        amountLbp: -(order.paid_lbp - order.change_lbp),
        orderId: order.id,
        reason: 'refund',
        note: `Refund of ${order.order_number}`,
        userId: req.user.id,
      });
    }
  })();

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  res.json({ order: updated });
});

export default router;

import { Router } from 'express';
import crypto from 'crypto';
import { db, transaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { getSettings } from '../lib/settings.js';
import { addEntry, creditCheck } from '../lib/accounts.js';
import { currentSession, recordMovement, requiresSession } from '../lib/cash.js';
import { isAvailable, returnUnitsOfOrder, sellUnit, syncStockFromUnits } from '../lib/units.js';
import {
  chargeSale,
  recordMovement as recordWalletMovement,
  refundOrder as refundWallets,
} from '../lib/wallets.js';
import { moveStock, stockAt, stockElsewhere } from '../lib/stock.js';
import { encryptSecret } from '../lib/secrets.js';
import { setIdPhoto } from '../lib/idPhotos.js';
import { quote, describe as describeCredit } from '../lib/credit.js';
import { creditCostBasis } from '../lib/wallets.js';
import { orderMessage, sendable } from '../lib/whatsapp.js';
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

/**
 * One line of calling credit, priced.
 *
 * The split into messages and the fee per message are worked out here from the
 * carrier's own settings, never taken from the request: the browser can say how
 * much the customer asked for and what they were charged, but what it costs the
 * shop is not the browser's to assert.
 *
 * The price defaults to the face value, because that is what most shops charge
 * — and it is deliberately allowed to be less than the cost. A shop selling $10
 * for $10 is losing the sixty cents of message fees, and the honest thing is to
 * record that and show it in the margin rather than refuse the sale.
 */
function buildCreditLine(item, branchId, exchangeRate) {
  const { walletId, msisdn, amount } = item.creditSend || {};

  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
  if (!wallet) throw new Error('Pick which carrier the credit is coming from');
  if (!wallet.sends_credit) throw new Error(`${wallet.name} is not set up to send credit`);
  if (!wallet.active) throw new Error(`${wallet.name} is closed`);

  const to = String(msisdn || '').trim();
  if (!to) throw new Error('Say which number the credit is going to');

  // Throws with something the counter can act on for a bad amount.
  const quoted = quote(amount, wallet.sms_fee);

  /*
   * What the shop is really out of pocket, not the face value.
   *
   * A shop that gets its credit back off validity cards did not pay a dollar
   * for a dollar of it, and costing the line at face value would report that
   * the most profitable half of the business earns nothing. The fees are
   * multiplied too — they come off the same balance, so they are worth what
   * that balance cost.
   */
  const basis = creditCostBasis(wallet.id);
  const realCost = round2(quoted.cost * basis);

  /*
   * Priced in pounds, because that is the only way credit is quoted here —
   * "110,000 a dollar". Converted back at today's rate because the order is
   * kept in dollars, the same as every other line.
   */
  const suggested =
    exchangeRate > 0
      ? round2(Math.round(quoted.amount * wallet.credit_price_lbp) / exchangeRate)
      : quoted.amount;

  const charged =
    item.price === undefined || item.price === null ? suggested : Number(item.price);
  if (!Number.isFinite(charged) || charged < 0) {
    throw new Error('The price for the credit must be zero or more');
  }

  return {
    creditSend: { wallet, to, quoted, realCost, basis },
    product: null,
    quantity: 1,
    price: charged,
    lineTotal: round2(charged),
    unit: null,
    isGift: false,
    branchId,
    name: `${wallet.name} credit — $${quoted.amount} to ${to}`,
  };
}

router.post('/', requireAuth, requirePermission('register'), (req, res) => {
  // The shop this sale happens in: the cashier's own counter, or whichever the
  // owner has switched to. Set by resolveBranch on every request.
  const branchId = req.branchId;
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
        /*
         * Calling credit sent by SMS, which is not a product at all: nothing
         * comes off a shelf and nothing has a catalogue price. What it costs
         * the shop is the credit plus a fee for every message the carrier makes
         * it send, and that is worked out here rather than trusted from the
         * browser — it is the figure the shop's margin is made of.
         */
        if (item.creditSend) {
          lineItems.push(buildCreditLine(item, branchId, exchangeRate));
          subtotal += lineItems.at(-1).lineTotal;
          continue;
        }

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
          /*
           * At this counter, not across the company: a phone sitting in the
           * other branch cannot be handed to the customer standing here.
           */
          const here = stockAt(branchId, product.id);
          /*
           * A validity card has no shelf of its own either. What limits it is
           * the card it is delivered by, which is checked when that card is
           * spent — counting a quantity here would refuse a sale the shop can
           * perfectly well make.
           */
          if (!product.wallet_id && !product.validity_days && here < quantity) {
            const elsewhere = stockElsewhere(branchId, product.id);
            const alsoAt = elsewhere.length
              ? ` — ${elsewhere.map((b) => `${b.stock} at ${b.branch_name}`).join(', ')}`
              : '';
            throw new Error(
              `Not enough stock for ${product.name} (have ${here}, need ${quantity})${alsoAt}`,
            );
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
        lineItems.push({
          product,
          quantity,
          lineTotal,
          unit,
          isGift,
          price: agreed,
          /*
           * Only meaningful on a SIM, and only ever set by the register's SIM
           * dialog. A photo sent against anything else is simply carried and
           * attached to that line — harmless, and refusing it would be a rule
           * with no failure behind it.
           */
          idPhoto: item.idPhoto || null,
        });
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
        // This branch's drawer: a sale at one counter cannot be taken against
        // the other shop's till.
        if (requiresSession() && !currentSession(null, branchId)) {
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
          buyer_name, buyer_phone, branch_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderNumber, req.user.id, customerId || null, subtotal, discountAmount, tax, total, paymentMethod,
        amountTenderedValue, changeDue,
        exchangeRate, paidUsd, paidLbp, changeUsd, changeLbp,
        paymentMethod === 'cash' ? changeCurrency : null,
        buyerName?.trim() || null,
        buyerPhone?.trim() || null,
        // Which shop sold it. Everything a branch reports about itself — its
        // takings, its profit, its shift report — reads from this.
        branchId,
      );

      const orderId = orderInfo.lastInsertRowid;

      // The cost is copied onto the line, not looked up later: profit for a
      // sale made last month must not change when a supplier puts a price up.
      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, name, price, quantity, line_total, cost, unit_id, is_gift)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);


      for (const li of lineItems) {
        /*
         * A serialised line carries the cost of the handset that left, not the
         * product's average — the point of tracking units is that this one's
         * margin is its own. Credit costs what the carrier took off the
         * balance, messages included.
         */
        const cost = li.creditSend
          ? li.creditSend.realCost
          : li.unit
            ? li.unit.cost
            : (li.product.cost ?? null);

        const lineInfo = insertItem.run(
          orderId,
          li.product?.id ?? null,
          li.product?.name ?? li.name,
          li.isGift ? 0 : li.price,
          li.quantity,
          li.lineTotal,
          cost,
          li.unit?.id ?? null,
          li.isGift ? 1 : 0,
        );
        const orderItemId = Number(lineInfo.lastInsertRowid);

        /*
         * A SIM is a line registered to a person, so the buyer's ID is
         * photographed at the counter and kept against the sale — this line
         * rather than the card, because a SIM returned and sold on again has a
         * different buyer the second time.
         */
        if (li.idPhoto) setIdPhoto('sim_sale', orderItemId, li.idPhoto, req.user.id);

        if (li.creditSend) {
          const { wallet, to, quoted } = li.creditSend;
          /*
           * The balance loses the credit and the message fees together — the
           * fees are the part a shop never sees, so they are spent through the
           * same movement rather than left as a rounding difference nobody
           * accounts for.
           */
          recordWalletMovement({
            walletId: wallet.id,
            kind: 'sale',
            /*
             * The balance loses the credit and the fees at face value — that is
             * how much credit is gone, whatever it cost to get. What it cost is
             * on the order line, where margin is read from.
             */
            amount: -quoted.cost,
            amountUsd: -quoted.cost,
            orderId,
            userId: req.user.id,
            note: `$${quoted.amount} to ${to} — ${quoted.smsCount} SMS`,
          });

          db.prepare(
            `INSERT INTO credit_sends
               (order_id, wallet_id, msisdn, amount, sms_count, fee_each, fees, cost, charged,
                breakdown, branch_id, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            orderId, wallet.id, to, quoted.amount, quoted.smsCount, quoted.feeEach, quoted.fees,
            quoted.cost, li.lineTotal, describeCredit(quoted), branchId, req.user.id,
          );
        } else if (li.unit) {
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
        } else if (li.product.validity_days) {
          /*
           * A validity card is three things happening at once.
           *
           * The customer pays for days. A whole recharge card is scratched to
           * deliver them, so that card's credit is spent out of the wallet
           * behind it. And the dollars the shop takes back off the customer's
           * line land on its own carrier balance, ready to resell — which is
           * where this shop's margin actually comes from.
           *
           * Doing the last two by hand is how a credit balance ends up as a
           * number nobody trusts, so selling the validity card does all three.
           *
           * A card that has not been linked yet sells the days and nothing
           * else. That is a real arrangement, not an oversight — the shop
           * says so by leaving the link empty.
           */
          if (li.product.linked_card_id) {
            const linked = db.prepare('SELECT * FROM products WHERE id = ?').get(li.product.linked_card_id);
            /*
             * Retiring a card does not delete its row, so the link survives it.
             * Selling on regardless would quietly scratch a card the shop has
             * said it no longer stocks — better to stop and be re-linked.
             */
            if (!linked) throw new Error(`${li.product.name} is linked to a card that no longer exists`);
            if (!linked.active) {
              throw new Error(`${li.product.name} is delivered by ${linked.name}, which is no longer stocked`);
            }

            if (linked.wallet_id) {
              chargeSale({
                walletId: linked.wallet_id,
                product: linked,
                quantity: li.quantity,
                orderId,
                userId: req.user.id,
              });
            } else {
              // A linked card held as ordinary stock comes off the shelf instead.
              moveStock({ branchId, productId: linked.id, delta: -li.quantity });
            }
          }

          if (li.product.credit_recovered > 0 && li.product.credit_wallet_id) {
            recordWalletMovement({
              walletId: li.product.credit_wallet_id,
              kind: 'top_up',
              amount: round2(li.product.credit_recovered * li.quantity),
              /*
               * It cost nothing: the card it came off was already bought and
               * has just been sold at a margin. Costing it at face value would
               * report that reselling it earns nothing.
               */
              costUsd: 0,
              orderId,
              productId: li.product.id,
              userId: req.user.id,
              note: `Back off ${li.quantity} × ${li.product.name}`,
            });
          }
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
          moveStock({ branchId, productId: li.product.id, delta: -li.quantity });
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
          branchId,
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

/**
 * The receipt as a WhatsApp message, ready to send.
 *
 * Same rule as reading the order itself: your own sales, or anybody's if you
 * run the shop. `?phone=` overrides what is on file, for the customer who gives
 * a different number at the counter than the one the shop wrote down.
 */
router.get('/:id/whatsapp', requireAuth, (req, res) => {
  const order = db.prepare('SELECT id, cashier_id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (req.user.role !== 'admin' && order.cashier_id !== req.user.id) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  res.json(sendable(orderMessage(order.id), req.query.phone || null));
});

router.post('/:id/refund', requireAuth, requirePermission('refunds'), (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'refunded') return res.status(400).json({ error: 'Order already refunded' });

  transaction(() => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);


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
        moveStock({ branchId: order.branch_id, productId: item.product_id, delta: item.quantity });
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

import { Router } from 'express';
import crypto from 'crypto';
import { db, transaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { getSettings, taxRate } from '../lib/settings.js';
import { addEntry, balanceOf, creditCheck } from '../lib/accounts.js';
import { dominantMethod, readTenders, recordTenders, tenderSplit, tendersFor } from '../lib/tenders.js';
import { recordMovement, registerAccountId, registerSession, requiresSession } from '../lib/cash.js';
import { notify } from '../lib/telegram.js';
import { refundText, returnText, saleText } from '../lib/notifyText.js';
import { postRefund, postSale } from '../lib/postings.js';
import {
  isAvailable,
  returnOneUnit,
  returnUnitsOfOrder,
  sellUnit,
  syncStockFromUnits,
} from '../lib/units.js';
import {
  chargeSale,
  recordMovement as recordWalletMovement,
  refundOrder as refundWallets,
  refundOrderLine as refundWalletLine,
} from '../lib/wallets.js';
import { moveStock, stockAt, stockElsewhere } from '../lib/stock.js';
import {
  availableFromParts,
  movePartsStock,
  partsCost,
  partsUsedOn,
  recordLineParts,
  resolveLineParts,
} from '../lib/bundles.js';
import { encryptSecret } from '../lib/secrets.js';
import { setIdPhoto } from '../lib/idPhotos.js';
import { quote, describe as describeCredit } from '../lib/credit.js';
import { creditCostBasis } from '../lib/wallets.js';
import { orderMessage, sendable } from '../lib/whatsapp.js';
import { takeTradeIn } from '../lib/repairs.js';
import {
  CHANGE_MODES,
  round2,
  changeBreakdown,
  combinedUsd,
  tenderTotals,
  validatePayments,
} from '../lib/currency.js';

/** The three ways a counter agrees a discount. */
export const DISCOUNT_MODES = ['percent', 'usd', 'lbp'];

/** What kind of account the shop set up for the customer. */
export const ACCOUNT_KINDS = ['icloud', 'gmail', 'other'];

const router = Router();

/*
 * Read per request, not once at boot.
 *
 * A shop turning tax off has to see it gone from the next sale, not after
 * somebody restarts the server — and on a machine running a shop, nobody is
 * going to.
 */
router.get('/tax-rate', requireAuth, (req, res) => {
  const settings = getSettings();
  res.json({
    taxRate: taxRate(settings),
    taxName: settings.tax_name || 'Tax',
    taxEnabled: String(settings.tax_enabled) === 'true',
  });
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

/**
 * The lines of a sale, each pack carrying what actually went in the bag.
 *
 * Attached here rather than left to the caller because there are three places
 * that read a sale back — the receipt printed at the counter, a reprint, and an
 * offline till catching up — and a pack that listed its parts on one of them
 * and not the others would be a receipt that disagreed with itself depending on
 * which screen it was printed from.
 */
function itemsOfOrder(orderId) {
  return db
    .prepare('SELECT * FROM order_items WHERE order_id = ?')
    .all(orderId)
    .map((item) => {
      if (!item.product_id) return item;
      const parts = partsUsedOn(item.id, item.product_id);
      // Absent, not empty, for anything that is not a pack — so the screens can
      // ask "is this a pack?" without a second field to keep in step.
      return parts.length ? { ...item, components: parts } : item;
    });
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
    /*
     * How it was paid, when it took more than one thing: a list of pieces
     * rather than one method. `paymentMethod` above is the older shape and
     * still works, so a till that queued a sale offline before this existed
     * still checks out.
     */
    tenders = null,
    changeCurrency = 'LBP',
    changeUsd: requestedChangeUsd = null,
    changeLbp: requestedChangeLbp = null,
    customerId = null,
    buyerName = null,
    buyerPhone = null,
    accounts = [],
    /*
     * How the discount was agreed: `{ mode: 'percent' | 'usd' | 'lbp', value }`.
     * `discountPercent` above is the older shape and still works.
     */
    discount = null,
    /*
     * A handset handed over as part of this sale.
     *
     * The commonest sale in a phone shop is not a sale, it is a swap: an old
     * phone in, a newer one out, and some money one way or the other. Doing
     * that as a purchase and then a sale leaves the arithmetic to the cashier
     * and the drawer moving twice for one exchange — and gets it wrong in the
     * case the shop notices most, which is when the old phone is worth more
     * than the new one and the shop is the one paying.
     */
    tradeIn = null,
    /*
     * The till's own name for this sale, when it has one.
     *
     * Sent by a till that made the sale while the server was unreachable and is
     * catching up. It is what stops a retry becoming a second sale — see below,
     * and see the unique index in db.js.
     */
    clientRef = null,
  } = req.body || {};

  /*
   * Already have it? Hand back the sale that exists.
   *
   * The dangerous failure is not the send that fails, it is the one that
   * succeeds and looks like it failed — the answer lost on the way back, the
   * till trying again, and the shop having sold the same phone twice. Answered
   * before any of the work below, so a replay costs nothing and changes
   * nothing.
   */
  if (clientRef) {
    const already = db.prepare('SELECT * FROM orders WHERE client_ref = ?').get(String(clientRef));
    if (already) {
      return res.status(200).json({
        order: already,
        items: itemsOfOrder(already.id),
        alreadyHad: true,
      });
    }
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Cart must contain at least one item' });
  }
  /*
   * One method, or a list of pieces — but one of the two.
   *
   * `tenders` is how a split arrives; `paymentMethod` is the older shape, still
   * sent by a till that queued a sale offline before splits existed. The list
   * is checked properly further down, where a bad one can be refused before
   * anything has moved.
   */
  const hasTenders = Array.isArray(tenders) && tenders.length > 0;
  if (!hasTenders && !['cash', 'card', 'account'].includes(paymentMethod)) {
    return res.status(400).json({ error: 'paymentMethod must be cash, card or account' });
  }
  if (!hasTenders && paymentMethod === 'account' && !customerId) {
    return res.status(400).json({ error: 'A customer is required for an account sale' });
  }
  /*
   * A discount is three different things depending on how it was agreed.
   *
   * "Ten per cent off" and "call it fifty dollars" and "knock off two hundred
   * thousand" are all normal at a counter, and the cashier should not have to
   * work out which percentage the last two come to. The percentage is still
   * accepted on its own, because a till that made a sale offline is holding
   * payloads written before any of this existed.
   *
   * A discount in pounds is converted with the *server's* rate, not the
   * browser's: what the shop is owed is not the browser's to assert.
   */
  const discountMode = discount?.mode ?? (discountPercent ? 'percent' : 'percent');
  const discountValue = Number(discount?.value ?? discountPercent ?? 0);
  if (!DISCOUNT_MODES.includes(discountMode)) {
    return res.status(400).json({ error: `discount.mode must be one of: ${DISCOUNT_MODES.join(', ')}` });
  }
  if (!Number.isFinite(discountValue) || discountValue < 0) {
    return res.status(400).json({ error: 'A discount cannot be less than nothing' });
  }
  if (discountMode === 'percent' && discountValue > 100) {
    return res.status(400).json({ error: 'A discount cannot be more than 100%' });
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
        /*
         * What this pack is being made of, or null for anything that is not a
         * pack. Declared out here because it is decided in the branch below and
         * needed when the line is written, and because "not a bundle" and "a
         * bundle whose parts we have not worked out yet" must not be the same
         * value.
         */
        let lineParts = null;
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
          /*
           * A bundle has no shelf of its own — nothing sits in the stockroom
           * called "starter pack". What limits it is whichever of its parts
           * runs out first, so that is what is counted and that is what the
           * refusal names.
           *
           * Counting the bundle's own row instead would refuse every bundle
           * sale ever attempted, because that row is always zero and always
           * will be.
           */
          /*
           * And what limits it is what *this* pack is being made of, which the
           * counter is allowed to change. A cashier swapping the black case for
           * the blue one has not made a different product; they have made this
           * pack out of what the customer wanted, and the shelf that has to be
           * counted is the blue one.
           */
          lineParts = resolveLineParts(product.id, item.components);
          if (lineParts) {
            const canMake = availableFromParts(branchId, lineParts);
            if (canMake < quantity) {
              const short = lineParts
                .filter((c) => stockAt(branchId, c.productId) < c.quantity * quantity)
                .map((c) => `${c.name} (${stockAt(branchId, c.productId)} left)`);
              throw new Error(
                `Only ${canMake} × ${product.name} can be made up — short of ${short.join(', ')}`,
              );
            }
          }

          const here = stockAt(branchId, product.id);
          /*
           * A validity card has no shelf of its own either. What limits it is
           * the card it is delivered by, which is checked when that card is
           * spent — counting a quantity here would refuse a sale the shop can
           * perfectly well make.
           */
          if (!lineParts && !product.wallet_id && !product.validity_days && here < quantity) {
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
          // Null for an ordinary product; for a pack, exactly what goes in the
          // bag — which is what comes off the shelves and what a refund puts
          // back, whether or not it matches the catalogue.
          parts: lineParts,
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
      /*
       * Never more than the goods came to. A discount bigger than the sale
       * would make the total negative, which is a different thing entirely —
       * money owed to the customer — and it has one honest cause, a trade-in.
       */
      const discountAmount = Math.min(
        subtotal,
        round2(
          discountMode === 'percent'
            ? subtotal * (discountValue / 100)
            : discountMode === 'lbp'
              ? (exchangeRate > 0 ? discountValue / exchangeRate : 0)
              : discountValue,
        ),
      );
      const taxableAmount = round2(subtotal - discountAmount);
      const tax = round2(taxableAmount * taxRate());
      const total = round2(taxableAmount + tax);

      /*
       * What the goods came to, less what the old phone was worth, is what
       * somebody actually has to hand over — and it is allowed to be negative.
       *
       * Everything below settles `due`, not `total`. `total` stays what the
       * sale was worth, because that is what the receipt, the day's takings and
       * the profit are all about; the trade-in is how it was paid for, not a
       * discount on it.
       */
      const tradeInValue = tradeIn ? round2(Number(tradeIn.value)) : 0;
      if (tradeIn && (!Number.isFinite(tradeInValue) || tradeInValue <= 0)) {
        throw new Error('What is the old phone worth?');
      }
      const due = round2(total - tradeInValue);
      // Read here so a bad payment is refused before anything has moved.
      const tenderLines = readTenders(tenders, exchangeRate);
      // Money going the other way: the old phone was worth more than the new one.
      const owedToCustomer = due < 0 ? round2(-due) : 0;

      /*
       * Money about to leave the drawer needs a drawer that is open, and this
       * is the one path that pays out without going through the cash branch
       * below — where that check already lives.
       */
      if (owedToCustomer > 0 && requiresSession() && !registerSession(branchId)) {
        throw new Error('The cashbox is closed — open it before paying the difference');
      }

      if (owedToCustomer > 0 && paymentMethod !== 'cash') {
        /*
         * Paying a customer by card is not a thing, and putting it on their
         * account would be the shop owing money to somebody who came in to buy
         * something. Notes out of the drawer is the only honest way to settle
         * this, so it is the only one offered.
         */
        throw new Error('Pay the difference in cash — the customer is owed money on this sale');
      }

      let amountTenderedValue = null;
      let changeDue = null;
      let paidUsd = 0;
      let paidLbp = 0;
      let changeUsd = 0;
      let changeLbp = 0;

      /*
       * How it was paid, when it took more than one thing.
       *
       * `tenders` is the new shape and `paymentMethod` the old one; a till that
       * queued a sale offline before this existed still sends the old, so both
       * are understood and the old path below is left exactly as it was.
       */
      const split = tenderLines ? tenderSplit(tenderLines) : null;
      if (split) {
        if (round2(split.total) + 0.01 < due) {
          throw new Error(
            `The payments come to ${split.total.toFixed(2)} USD, less than the ${due.toFixed(2)} USD due`,
          );
        }
        if (split.account > 0 && !customerId) {
          throw new Error('Name the customer whose account the rest is going on');
        }
        if (split.account > 0) {
          // Inside the transaction, so a concurrent sale cannot slip the
          // customer past their limit between the check and the insert.
          const check = creditCheck(customerId, split.account);
          if (!check.ok) throw new Error(check.error);
        }
        if (split.cash > 0 && requiresSession() && !registerSession(branchId)) {
          throw new Error('The cashbox is closed — open it before taking cash');
        }

        paidUsd = split.cashUsd;
        paidLbp = split.cashLbp;
        amountTenderedValue = split.total;

        /*
         * Change comes out of the cash, and only out of the cash. Nobody hands
         * back notes because a card was over-swiped, and an account remainder
         * is by definition exactly what is left.
         */
        changeDue = round2(Math.max(0, split.total - due));
        if (changeDue > 0) {
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
        }
      }

      if (!split && paymentMethod === 'account') {
        // Checked inside the transaction so a concurrent sale cannot slip the
        // customer past their limit between the check and the insert.
        const check = creditCheck(customerId, due);
        if (!check.ok) throw new Error(check.error);
      }

      if (!split && paymentMethod === 'cash' && due > 0) {
        /*
         * Cash needs a drawer to go into. Card and account sales do not touch
         * it, so they are left alone — refusing those would stop the shop
         * trading for no reason.
         */
        // This branch's drawer: a sale at one counter cannot be taken against
        // the other shop's till.
        if (requiresSession() && !registerSession(branchId)) {
          throw new Error('The cashbox is closed — open it before taking cash');
        }

        const invalid = validatePayments(tender || []);
        if (invalid) throw new Error(invalid);

        const totals = tenderTotals(tender, exchangeRate);
        if (totals.totalUsdEquivalent + 1e-9 < due) {
          throw new Error(
            `Tendered ${totals.totalUsdEquivalent.toFixed(2)} USD is less than the ${due.toFixed(2)} USD due`,
          );
        }

        paidUsd = totals.paidUsd;
        paidLbp = totals.paidLbp;
        amountTenderedValue = totals.totalUsdEquivalent;
        changeDue = round2(totals.totalUsdEquivalent - due);

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

      /*
       * Take the old phone in before the order is written, so its cost is on
       * the shelf whichever way the money went.
       *
       * Paid at its agreed value even though no notes changed hands for it:
       * that is what the shop gave up to get it, and costing it at zero would
       * report the whole of its eventual resale as profit.
       *
       * The drawer is deliberately *not* moved here. `takeTradeIn` records the
       * purchase; the money is settled once, below, as the net of this sale.
       */
      let tradeInRecord = null;
      if (tradeIn) {
        tradeInRecord = takeTradeIn(
          {
            ...tradeIn,
            paidUsd: tradeInValue,
            paidLbp: 0,
            customerId: tradeIn.customerId ?? customerId ?? null,
            exchangeRate,
          },
          req.user.id,
        );
      }

      const orderNumber = `ORD-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

      const orderInfo = db.prepare(`
        INSERT INTO orders (
          order_number, cashier_id, customer_id, subtotal, discount, tax, total, payment_method,
          amount_tendered, change_due, status,
          exchange_rate, paid_usd, paid_lbp, change_usd, change_lbp, change_currency,
          buyer_name, buyer_phone, branch_id, cash_session_id, client_ref,
          trade_in_value, trade_in_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderNumber, req.user.id, customerId || null, subtotal, discountAmount, tax, total,
        split ? dominantMethod(split) : paymentMethod,
        amountTenderedValue, changeDue,
        exchangeRate, paidUsd, paidLbp, changeUsd, changeLbp,
        (split ? split.cash > 0 : paymentMethod === 'cash') ? changeCurrency : null,
        buyerName?.trim() || null,
        buyerPhone?.trim() || null,
        // Which shop sold it. Everything a branch reports about itself — its
        // takings, its profit, its shift report — reads from this.
        branchId,
        /*
         * And which sitting of its drawer, so "what has this register sold"
         * can be answered exactly rather than by comparing timestamps that are
         * only kept to the second.
         */
        registerSession(branchId)?.id ?? null,
        clientRef ? String(clientRef) : null,
        tradeInValue,
        tradeInRecord?.tradeInId ?? null,
      );

      const orderId = orderInfo.lastInsertRowid;

      // The detail under the single method above: what each piece was, and
      // which app it came through when it was not cash.
      if (tenderLines) recordTenders(orderId, tenderLines);

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
            : li.parts
              ? /*
                 * A pack costs what its parts cost, and it has to be *these*
                 * parts. A swapped-in case at twice the price is a swapped-in
                 * case at twice the price, and a margin worked out from the
                 * catalogue would quietly report the pack as earning what it
                 * would have earned if nobody had asked for anything.
                 */
                partsCost(li.parts)
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

        /*
         * What actually went in the bag, frozen against the line.
         *
         * Written for every pack, not only for a substituted one. A definition
         * that changes next month must not rewrite what a sale last month took
         * off the shelves — and a refund reads this, so "the pack as it was
         * sold" has to be a fact on the row rather than a lookup that has moved
         * on.
         */
        if (li.parts) recordLineParts(orderItemId, li.parts);

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
        } else if (li.parts) {
          /*
           * A pack comes off the shelves its parts are on, not off a shelf of
           * its own — and off the shelves of the parts *this* pack was made of,
           * which is the whole point of letting the counter change them.
           */
          movePartsStock({ branchId, parts: li.parts, quantity: li.quantity });
        } else {
          moveStock({ branchId, productId: li.product.id, delta: -li.quantity });
        }
      }

      /*
       * What goes on the customer's account.
       *
       * With a split that is the piece they did not settle — the commonest
       * case being a customer who is short and pays the rest on Friday. Without
       * one it is the whole sale, as before.
       */
      const onAccount = split ? split.account : paymentMethod === 'account' ? due : 0;
      if (onAccount > 0) {
        addEntry({
          partyType: 'customer',
          partyId: customerId,
          kind: 'sale',
          // What they owe is the balance after the old phone came off it, not
          // the ticket price of what they walked out with.
          amountUsd: onAccount,
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
      // A split moves the drawer for its cash piece and for nothing else; a
      // card or an account remainder never touched it.
      if (split ? split.cash > 0 : paymentMethod === 'cash') {
        recordMovement({
          // The drawer in front of the cashier, named rather than left to the
          // shop's default account — which for a shop that keeps its money in
          // a safe is not the drawer at all.
          accountId: registerAccountId(branchId),
          kind: 'sale',
          amountUsd: round2(paidUsd - changeUsd),
          amountLbp: paidLbp - changeLbp,
          orderId,
          note: orderNumber,
          userId: req.user.id,
        });
      }

      /*
       * The other direction: the old phone was worth more than the new one, so
       * the customer leaves with notes.
       *
       * One movement for the net, not a purchase out and a sale in. The drawer
       * is counted at the end of the shift against what actually happened at
       * the counter, and what happened was one exchange with one difference
       * paid — recording it as two would make the shift report describe two
       * transactions nobody would recognise.
       */
      if (owedToCustomer > 0) {
        recordMovement({
          accountId: registerAccountId(branchId),
          kind: 'cash_out',
          amountUsd: -owedToCustomer,
          reason: 'supplier',
          orderId,
          note: `${orderNumber} — paid the difference on a trade-in`,
          userId: req.user.id,
        });
      }

      /*
       * And the books, inside this same transaction.
       *
       * Together or neither. A sale that moved stock and took money but posted
       * nothing leaves the ledger permanently wrong by that sale and nothing
       * will ever find it again — so this is not fired off afterwards the way a
       * notification is. It cannot refuse the sale either: see lib/postings.js,
       * where every unmapped account falls back to Suspense rather than
       * throwing.
       */
      postSale({
        order: db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId),
        items: itemsOfOrder(orderId),
        tillAccountId: registerAccountId(branchId),
        userId: req.user.id,
      });

      return {
        orderId,
        orderNumber,
        subtotal,
        discountAmount,
        tax,
        total,
        changeDue,
        tradeInValue,
        due,
        owedToCustomer,
      };
    })();

    /*
     * Read back with the names on it, not as a bare row.
     *
     * The receipt shown the instant a sale goes through was built from
     * `SELECT *`, which carries `customer_id` and no customer *name* — so it
     * could never print who the sale was for, however much the receipt asked
     * for one. A reprint reads the same order through the join below and did
     * have the name, which is what made this look fixed when it was not: the
     * two paths were showing different things about the same sale.
     */
    const order = db
      .prepare(
        `SELECT o.*, u.name AS cashier_name, c.name AS customer_name
         FROM orders o
         JOIN users u ON u.id = o.cashier_id
         LEFT JOIN customers c ON c.id = o.customer_id
         WHERE o.id = ?`,
      )
      .get(result.orderId);
    const orderItems = itemsOfOrder(result.orderId);
    /*
     * What they still owe, for the receipt.
     *
     * A customer buying on account should walk out knowing the figure, and the
     * moment to tell them is the piece of paper in their hand — asking at the
     * counter next month is how a shop ends up arguing about it. Read after the
     * sale is posted, so it is the balance including what was just bought.
     */
    const withBalance = order.customer_id
      ? { ...order, customer_balance: balanceOf('customer', order.customer_id) }
      : order;
    res.status(201).json({ order: withBalance, items: orderItems, tenders: tendersFor(order.id) });

    /*
     * And the owner's phone, after the till already has its answer.
     *
     * Below the response deliberately: a notification is a courtesy and the
     * sale is the shop's money, so nothing about telling somebody may delay or
     * fail a sale that has already happened. `notify` never throws and never
     * blocks — see lib/telegram.js.
     */
    notify(
      'sale',
      saleText({
        orderNumber: order.order_number,
        total: order.total,
        paymentMethod: order.payment_method,
        itemCount: orderItems.length,
        user: order.cashier_name,
        branchId: order.branch_id,
        customer: order.customer_name,
      }),
    );
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
  /*
   * A range is inclusive of both whole days.
   *
   * `created_at` is a timestamp and these come in as dates, so comparing them
   * raw made `to` mean "up to midnight at the start of that day" — asking for
   * sales up to today returned everything except today, which is the one day
   * anybody is actually looking at. The same reasoning, and the same fix, as
   * periodBounds in lib/profit.js.
   */
  if (from) {
    sql += ' AND o.created_at >= ?';
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    sql += ' AND o.created_at <= ?';
    params.push(`${to} 23:59:59`);
  }
  /*
   * `?scope=sitting` — what has been sold on this till since it was opened.
   *
   * The question a cashier asks is "what have I rung up today", and today means
   * this sitting: the drawer was counted at the start of it, so the sales that
   * belong to it are the ones that have to reconcile against it. Scoped to the
   * branch too, because the second shop's takings are not this one's.
   *
   * A closed drawer has no sitting, so it has no sales — said with an empty
   * list rather than by quietly falling back to every sale ever rung up.
   */
  if (req.query.scope === 'sitting') {
    const session = registerSession(req.branchId);
    if (!session) return res.json({ orders: [], session: null });
    sql += ' AND o.cash_session_id = ?';
    params.push(session.id);
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
  const items = itemsOfOrder(req.params.id);
  // See the note where a sale is created: a reprint carries the balance too.
  const withBalance = order.customer_id
    ? { ...order, customer_balance: balanceOf('customer', order.customer_id) }
    : order;
  // And how it was paid for, when that took more than one thing.
  res.json({ order: withBalance, items, tenders: tendersFor(order.id) });
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

  /*
   * A swap cannot be undone by pressing refund.
   *
   * Reversing one means giving the customer their old phone back, taking the
   * new one off them, and moving the difference the other way — and the old
   * phone may already have been sold to somebody else this morning. Guessing at
   * any of that would leave a shop with a stock count and a drawer that are
   * both quietly wrong, which is worse than a refusal it can act on.
   */
  if (order.trade_in_value > 0) {
    return res.status(400).json({
      error:
        'This sale took a phone in part-exchange. Undo it by buying the new phone back and ' +
        'selling the old one on, so the handsets and the money both end up where they belong.',
    });
  }

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
        /*
         * A pack goes back as the parts that came out of it, which are recorded
         * against the line rather than looked up on the product. Reading the
         * definition here was the bug this table exists to prevent: a customer
         * who asked for the blue case would have handed back a pack and been
         * credited a black one to the shelf, leaving the shop short of one and
         * holding a phantom of the other.
         */
        const parts = partsUsedOn(item.id, item.product_id);
        if (parts.length) {
          movePartsStock({
            branchId: order.branch_id,
            parts,
            quantity: item.quantity,
            sign: 1,
          });
        } else {
          moveStock({ branchId: order.branch_id, productId: item.product_id, delta: item.quantity });
        }
      }
    }
    returnUnitsOfOrder(order.id);
    refundWallets(order.id, req.user.id);
    db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(order.id);
    // Everything is back, so every line says so — otherwise a voided sale still
    // offers its lines for return one at a time.
    db.prepare('UPDATE order_items SET returned_qty = quantity WHERE order_id = ?').run(order.id);

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

    postRefund({
      order,
      items: itemsOfOrder(order.id),
      tillAccountId: registerAccountId(order.branch_id),
      userId: req.user.id,
    });

    // Refunding a cash sale hands money back across the counter.
    if (order.payment_method === 'cash') {
      recordMovement({
        // Handed back over the counter it was taken at.
        accountId: registerAccountId(order.branch_id),
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

  // The one an owner most wants to hear about within seconds rather than in
  // tomorrow's report. Below the response, and never able to fail it.
  notify(
    'refund',
    refundText({
      orderNumber: order.order_number,
      total: order.total,
      user: req.user.name,
      branchId: order.branch_id,
      reason: req.body?.reason || null,
    }),
  );
});

/**
 * One thing off a sale, handed back.
 *
 * A customer returns one item out of six far more often than they hand the
 * whole sale back, and the only answer used to be to void all of it and ring
 * the rest up again — which loses the sale's own prices, its time of day and
 * its place in the takings, and hands back money that was never in dispute.
 *
 * What comes back is what that line contributed to the total, not its shelf
 * price: the customer paid after a discount and with tax on top, and refunding
 * the sticker price would hand back more than was ever taken.
 */
router.post('/:id/return-line', requireAuth, requirePermission('refunds'), (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'refunded') return res.status(400).json({ error: 'That sale was already voided' });

  const item = db
    .prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?')
    .get(req.body?.itemId, order.id);
  if (!item) return res.status(404).json({ error: 'That line is not on this sale' });

  const left = item.quantity - item.returned_qty;
  const returning = Number(req.body?.quantity ?? left);
  if (!Number.isInteger(returning) || returning <= 0) {
    return res.status(400).json({ error: 'Say how many are coming back' });
  }
  if (returning > left) {
    return res.status(400).json({
      error:
        left === 0
          ? `${item.name} has already been returned`
          : `Only ${left} of ${item.name} left to return`,
    });
  }

  /*
   * The line's share of what was actually paid. Discount and tax both apply
   * across the whole sale, so a line is worth its slice of the total rather
   * than its own price — refunding the sticker price would hand back money the
   * shop never took.
   *
   * Worked out as a running total against the line rather than per item, so
   * that returning three then two refunds exactly what returning five would:
   * the rounding lands once, on the line, instead of once per return.
   *
   * A sale that was entirely gifted has no subtotal to take a share of, and
   * nothing was paid for it either — so nothing goes back.
   */
  const lineShare = order.subtotal > 0 ? round2((item.line_total / order.subtotal) * order.total) : 0;
  const refundedSoFar = round2((lineShare * item.returned_qty) / item.quantity);
  const refundedAfter = round2((lineShare * (item.returned_qty + returning)) / item.quantity);
  const refund = round2(refundedAfter - refundedSoFar);

  transaction(() => {
    const fromWallet = db
      .prepare(
        "SELECT 1 FROM wallet_movements WHERE order_id = ? AND kind = 'sale' AND product_id = ? LIMIT 1",
      )
      .get(order.id, item.product_id);

    if (item.unit_id) {
      // A handset is one line of one, so returning the line returns that phone.
      returnOneUnit(item.unit_id);
    } else if (fromWallet) {
      refundWalletLine({
        orderId: order.id,
        productId: item.product_id,
        returning,
        sold: item.quantity,
        userId: req.user.id,
      });
    } else if (item.product_id) {
      // As above: the parts this line actually went out with, not the ones the
      // catalogue says the pack contains today.
      const parts = partsUsedOn(item.id, item.product_id);
      if (parts.length) {
        movePartsStock({ branchId: order.branch_id, parts, quantity: returning, sign: 1 });
      } else {
        moveStock({ branchId: order.branch_id, productId: item.product_id, delta: returning });
      }
    }

    db.prepare('UPDATE order_items SET returned_qty = returned_qty + ? WHERE id = ?').run(
      returning,
      item.id,
    );

    /*
     * A sale with nothing left on it is a voided sale, however it got there.
     * Said once, here, so the two routes cannot disagree about what a fully
     * returned order looks like.
     */
    const outstanding = db
      .prepare('SELECT COALESCE(SUM(quantity - returned_qty), 0) AS n FROM order_items WHERE order_id = ?')
      .get(order.id).n;
    if (outstanding === 0) {
      db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(order.id);
    }

    if (order.payment_method === 'account' && order.customer_id) {
      addEntry({
        partyType: 'customer',
        partyId: order.customer_id,
        kind: 'refund',
        amountUsd: -refund,
        orderId: order.id,
        note: `Returned ${returning} × ${item.name} from ${order.order_number}`,
        userId: req.user.id,
      });
    }

    postRefund({
      order,
      items: itemsOfOrder(order.id),
      amount: refund,
      tillAccountId: registerAccountId(order.branch_id),
      userId: req.user.id,
    });

    /*
     * Money handed back across the counter comes out of the drawer — in the
     * currency it came in. A customer who paid in pounds is given pounds back,
     * so the share of the sale being returned is taken off each leg of what was
     * actually tendered rather than converted into dollars on the way out.
     */
    if (order.payment_method === 'cash' && order.total > 0) {
      const share = refund / order.total;
      recordMovement({
        accountId: registerAccountId(order.branch_id),
        kind: 'refund',
        amountUsd: -round2((order.paid_usd - order.change_usd) * share),
        amountLbp: -Math.round((order.paid_lbp - order.change_lbp) * share),
        orderId: order.id,
        reason: 'refund',
        note: `Returned ${returning} × ${item.name} from ${order.order_number}`,
        userId: req.user.id,
      });
    }
  })();

  res.json({
    refunded: refund,
    order: db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id),
  });

  notify(
    'return',
    returnText({
      orderNumber: order.order_number,
      amount: refund,
      quantity: returning,
      itemName: item.name,
      user: req.user.name,
      branchId: order.branch_id,
    }),
  );
});

export default router;

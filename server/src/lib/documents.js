import { db } from '../db.js';
import { round2, tenderTotals, validatePayments } from './currency.js';
import { addEntry, creditCheck } from './accounts.js';
import { recordMovement } from './cash.js';
import { recordCostChange } from './costHistory.js';
import { isAvailable, receiveUnits, syncStockFromUnits } from './units.js';

const TAX_RATE = Number(process.env.TAX_RATE || 0.08);

/**
 * What each document type is for, and what confirming it does.
 *
 * `stock` is the direction stock moves on confirm; `posts` is the sign of the
 * ledger entry. A quotation and a sales order are commitments only — neither
 * touches stock or the books until they become an invoice.
 */
export const DOC_TYPES = {
  quotation: {
    label: 'Quotation',
    prefix: 'QT',
    party: 'customer',
    stock: 0,
    posts: 0,
    convertsTo: ['sales_order', 'sales_invoice'],
  },
  sales_order: {
    label: 'Sales order',
    prefix: 'SO',
    party: 'customer',
    stock: 0,
    posts: 0,
    convertsTo: ['sales_invoice'],
  },
  sales_invoice: {
    label: 'Sales invoice',
    prefix: 'SI',
    party: 'customer',
    stock: -1,
    posts: 1,
    convertsTo: [],
  },
  purchase_invoice: {
    label: 'Purchase invoice',
    prefix: 'PI',
    party: 'supplier',
    stock: 1,
    posts: 1,
    convertsTo: [],
  },
};

export const PARTY_TABLE = { customer: 'customers', supplier: 'suppliers' };

/** Next number for a type, e.g. PI-0007. Sequential per type. */
export function nextDocNumber(docType) {
  const { prefix } = DOC_TYPES[docType];
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM documents WHERE doc_type = ?')
    .get(docType);
  let seq = row.n + 1;

  // Numbers must be unique even if a document was deleted, so step past clashes.
  const exists = db.prepare('SELECT 1 FROM documents WHERE doc_number = ?');
  let candidate = `${prefix}-${String(seq).padStart(4, '0')}`;
  while (exists.get(candidate)) {
    seq += 1;
    candidate = `${prefix}-${String(seq).padStart(4, '0')}`;
  }
  return candidate;
}

/**
 * Validate and price a set of lines.
 *
 * Prices default to the product's current price but may be overridden — a
 * purchase invoice is priced at cost, and quotations often carry a negotiated
 * figure. Quantities allow fractions for weighed goods.
 */
export function buildLines(items, docType) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('A document needs at least one line');
  }

  const lines = [];
  for (const item of items) {
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('Every line needs a quantity greater than zero');
    }

    let product = null;
    if (item.productId) {
      product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
      if (!product) throw new Error(`Product ${item.productId} not found`);
    }

    const name = item.name || product?.name;
    if (!name) throw new Error('Every line needs a product or a description');

    const fallbackPrice = docType === 'purchase_invoice' ? product?.cost : product?.price;
    const price = item.price !== undefined && item.price !== null ? Number(item.price) : Number(fallbackPrice);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Line "${name}" needs a price of zero or more`);
    }

    lines.push({
      productId: product?.id ?? null,
      name,
      sku: item.sku || product?.sku || null,
      price: round2(price),
      quantity,
      lineTotal: round2(price * quantity),
      /*
       * What the goods cost us. On a purchase invoice that is the price being
       * paid; on a sale it is the product's cost at the time, kept on the line
       * so profit is computed from what was true then.
       */
      cost: docType === 'purchase_invoice' ? round2(price) : (product?.cost ?? null),
      // The IMEIs off the boxes, kept as typed so the delivery can be undone
      // against exactly the handsets it created.
      imeis: item.imeis ? String(item.imeis) : null,
    });
  }
  return lines;
}

/** Subtotal, discount, tax and total for a set of lines. */
export function totalsFor(lines, discountPercent = 0) {
  const pct = Number(discountPercent) || 0;
  if (pct < 0 || pct > 100) throw new Error('Discount must be between 0 and 100 percent');

  const subtotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
  const discount = round2(subtotal * (pct / 100));
  const taxable = round2(subtotal - discount);
  const tax = round2(taxable * TAX_RATE);

  return { subtotal, discountPercent: pct, discount, tax, total: round2(taxable + tax) };
}

/* ----------------------------------------------------------------- payment */

export const PAYMENT_METHODS = ['cash', 'card', 'transfer'];

/**
 * What was handed over on a document, in USD.
 *
 * Pounds are converted at the rate stored on the document rather than today's,
 * so a purchase settled last month still reconciles after the rate moves.
 */
export function paidUsdEquivalent(doc) {
  const rate = Number(doc.exchange_rate);
  const lbpAsUsd = rate > 0 ? Number(doc.paid_lbp || 0) / rate : 0;
  return round2(Number(doc.paid_usd || 0) + lbpAsUsd);
}

/** What is left on the party's account after the payment. */
export function outstandingOf(doc) {
  return round2(Number(doc.total) - paidUsdEquivalent(doc));
}

/**
 * Validate and total a payment made against a document.
 *
 * `payments` is the same { currency, amount } list the register uses, so a
 * supplier paid partly in dollars and partly in pounds is expressed the same
 * way at the counter and on a purchase invoice. Returns the sums plus the
 * method, or throws with a message meant for the user.
 */
export function settlement(payments, method, total, rate) {
  if (!payments || payments.length === 0) {
    return { paidUsd: 0, paidLbp: 0, paidTotal: 0, method: null };
  }

  const invalid = validatePayments(payments);
  if (invalid) throw new Error(invalid);
  if (!PAYMENT_METHODS.includes(method)) {
    throw new Error(`Payment method must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }

  const totals = tenderTotals(payments, rate);
  if (totals.totalUsdEquivalent <= 0) throw new Error('A payment must be greater than zero');
  if (totals.totalUsdEquivalent > round2(total) + 0.01) {
    throw new Error(
      `Paying ${totals.totalUsdEquivalent.toFixed(2)} USD is more than the ${round2(total).toFixed(2)} USD total`,
    );
  }

  return {
    paidUsd: totals.paidUsd,
    paidLbp: totals.paidLbp,
    paidTotal: totals.totalUsdEquivalent,
    method,
  };
}

/* ------------------------------------------------------------------ effects */

/*
 * Confirming a document moves stock and posts to the ledger; cancelling undoes
 * exactly that. Editing or deleting a confirmed document is the same pair run
 * back to back, so both live here rather than inline in the route — a fix
 * applied in one place would otherwise drift from the other.
 *
 * Every caller must already be inside a transaction: a half-applied document
 * would leave stock and the ledger disagreeing.
 */

export function itemsOf(documentId) {
  return db.prepare('SELECT * FROM document_items WHERE document_id = ? ORDER BY id').all(documentId);
}

/**
 * Move stock for a document's lines. `direction` is +1 to apply the document's
 * own effect and -1 to undo it.
 */
function moveStock(doc, items, userId, direction, note) {
  const type = DOC_TYPES[doc.doc_type];
  if (type.stock === 0) return;

  const adjustStock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
  const logMovement = db.prepare(
    `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const item of items) {
    if (!item.product_id) continue; // free-text line, nothing to move

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
    if (!product) {
      // A product deleted since can still be undone — there is just no stock to
      // put back. Applying against a missing product is a real error.
      if (direction < 0) continue;
      throw new Error(`Product for line "${item.name}" no longer exists`);
    }

    /*
     * A serialised product does not move as a quantity. On a delivery the line
     * carries the IMEIs off the boxes and they become the stock; stock is then
     * recounted from the units rather than added to, so the two cannot drift.
     */
    if (product.tracks_units) {
      moveUnits({ doc, item, product, direction, userId, note });
      continue;
    }

    const delta = Math.round(item.quantity) * type.stock * direction;
    const resulting = product.stock + delta;
    if (resulting < 0) {
      throw new Error(
        direction > 0
          ? `Not enough stock for ${product.name} (have ${product.stock}, need ${Math.round(item.quantity)})`
          : `${product.name} would go below zero (have ${product.stock}) — it has been sold on already`,
      );
    }

    /*
     * A delivery is where a supplier's price change actually arrives. Update
     * the product's cost to what was just paid, and keep the old figure on the
     * record so the margin's movement can be explained later.
     */
    if (direction > 0 && type.stock > 0 && item.cost !== null && item.cost !== undefined) {
      db.prepare('UPDATE products SET cost = ? WHERE id = ?').run(item.cost, product.id);
      recordCostChange({
        productId: product.id,
        cost: item.cost,
        previousCost: product.cost,
        source: 'purchase',
        note: `Received on ${note}`,
        documentId: doc.id,
        userId,
      });
    }

    adjustStock.run(delta, product.id);
    logMovement.run(
      product.id,
      userId,
      delta,
      resulting,
      direction > 0 && type.stock > 0 ? 'received' : 'count_correction',
      note,
    );
  }
}


/**
 * Book a delivery's handsets in, or take them back out again.
 *
 * Undoing only works while every unit is still on the shelf. Once one has been
 * sold, deleting the invoice that brought it in would leave a sale pointing at
 * a handset the shop has no record of receiving — better to refuse and make
 * someone decide what actually happened.
 */
function moveUnits({ doc, item, product, direction, userId, note }) {
  const wanted = Math.round(item.quantity);

  if (direction < 0) {
    const received = db
      .prepare('SELECT * FROM product_units WHERE received_document_id = ? AND product_id = ?')
      .all(doc.id, product.id);

    const gone = received.filter((u) => !isAvailable(u.status));
    if (gone.length > 0) {
      throw new Error(
        `${gone[0].imei} came in on this document and has already been ${gone[0].status.replace('_', ' ')}`,
      );
    }
    for (const u of received) {
      db.prepare('DELETE FROM product_units WHERE id = ?').run(u.id);
    }
    const left = syncStockFromUnits(product.id);
    db.prepare(
      `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(product.id, userId, -received.length, left, 'count_correction', note);
    return;
  }

  /*
   * Only a delivery brings handsets in. A sales invoice for a serialised
   * product would have to name which ones are leaving, and that belongs at the
   * register where the customer is standing — so it is refused here rather than
   * guessing.
   */
  if (DOC_TYPES[doc.doc_type].stock < 0) {
    throw new Error(`${product.name} is tracked by IMEI — sell it from the register, not a document`);
  }

  const lines = String(item.imeis || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length !== wanted) {
    throw new Error(
      `${product.name}: ${wanted} on the line but ${lines.length} IMEI${lines.length === 1 ? '' : 's'} given`,
    );
  }

  const cost = item.cost ?? product.cost;
  receiveUnits(product.id, lines.map((line) => ({ imei: line, cost })), { documentId: doc.id });

  if (cost !== null && cost !== undefined) {
    db.prepare('UPDATE products SET cost = ? WHERE id = ?').run(cost, product.id);
    recordCostChange({
      productId: product.id,
      cost,
      previousCost: product.cost,
      source: 'purchase',
      note: `Received on ${note}`,
      documentId: doc.id,
      userId,
    });
  }

  const resulting = syncStockFromUnits(product.id);
  db.prepare(
    `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(product.id, userId, lines.length, resulting, 'received', note);
}

/** Does this document belong on somebody's account at all? */
function postsToLedger(doc) {
  return DOC_TYPES[doc.doc_type].posts !== 0 && !!doc.party_id;
}

/**
 * Apply what confirming a document does: stock out or in, the party billed, and
 * whatever was paid at the counter taken off again. Throws — rolling the
 * caller's transaction back — if stock or credit will not allow it.
 *
 * The bill and the payment are posted as two entries even when they cancel out.
 * A cash purchase leaves no balance, but the shop still needs to see the money
 * that went out, and the supplier's statement should show the delivery.
 */
export function applyEffects(doc, items, userId, note = doc.doc_number) {
  if (items.length === 0) throw new Error('A document needs at least one line');

  moveStock(doc, items, userId, 1, note);
  if (!postsToLedger(doc)) return;

  // Only the unpaid remainder is credit, so that is what the limit applies to.
  if (doc.party_type === 'customer') {
    const check = creditCheck(doc.party_id, outstandingOf(doc));
    if (!check.ok) throw new Error(check.error);
  }

  addEntry({
    partyType: doc.party_type,
    partyId: doc.party_id,
    kind: doc.doc_type === 'purchase_invoice' ? 'bill' : 'sale',
    amountUsd: doc.total,
    exchangeRate: doc.exchange_rate,
    note,
    userId,
  });

  const paid = paidUsdEquivalent(doc);
  if (paid > 0) {
    addEntry({
      partyType: doc.party_type,
      partyId: doc.party_id,
      kind: 'payment',
      amountUsd: -paid,
      paidUsd: doc.paid_usd,
      paidLbp: doc.paid_lbp,
      exchangeRate: doc.exchange_rate,
      note: `${note} — paid ${doc.payment_method}`,
      userId,
    });

    /*
     * Paid from the till, so the till has to know. A purchase settled in cash
     * empties the drawer; an invoice a customer pays on the spot fills it.
     * Card and transfer never reach the drawer.
     */
    if (doc.payment_method === 'cash') {
      const sign = doc.doc_type === 'purchase_invoice' ? -1 : 1;
      recordMovement({
        kind: 'document',
        amountUsd: sign * doc.paid_usd,
        amountLbp: sign * doc.paid_lbp,
        reason: doc.doc_type === 'purchase_invoice' ? 'supplier' : 'customer_payment',
        documentId: doc.id,
        note,
        userId,
      });
    }
  }
}

/**
 * Undo what confirming a document did. The ledger is corrected with offsetting
 * entries rather than by deleting the originals, so the party's statement still
 * shows what happened and when.
 */
export function reverseEffects(doc, items, userId, note = `Cancelled ${doc.doc_number}`) {
  moveStock(doc, items, userId, -1, note);
  if (!postsToLedger(doc)) return;

  addEntry({
    partyType: doc.party_type,
    partyId: doc.party_id,
    kind: 'refund',
    amountUsd: -doc.total,
    exchangeRate: doc.exchange_rate,
    note,
    userId,
  });

  // Money paid at the counter comes back with it.
  const paid = paidUsdEquivalent(doc);
  if (paid > 0) {
    addEntry({
      partyType: doc.party_type,
      partyId: doc.party_id,
      kind: 'adjustment',
      amountUsd: paid,
      exchangeRate: doc.exchange_rate,
      note: `${note} — ${doc.payment_method} payment returned`,
      userId,
    });

    if (doc.payment_method === 'cash') {
      const sign = doc.doc_type === 'purchase_invoice' ? 1 : -1;
      recordMovement({
        kind: 'document',
        amountUsd: sign * doc.paid_usd,
        amountLbp: sign * doc.paid_lbp,
        reason: 'correction',
        documentId: doc.id,
        note,
        userId,
      });
    }
  }
}

/**
 * A document another one was created from cannot be deleted while that
 * successor is live, or the successor would point at nothing. Returns the
 * blocking document, or null.
 */
export function liveSuccessorOf(documentId) {
  return (
    db
      .prepare(
        "SELECT id, doc_number FROM documents WHERE converted_from_id = ? AND status != 'cancelled'",
      )
      .get(documentId) || null
  );
}

export function getDocument(id) {
  const doc = db
    .prepare(
      `SELECT d.*, u.name AS user_name,
              COALESCE(c.name, s.name) AS party_name,
              COALESCE(c.phone, s.phone) AS party_phone,
              COALESCE(c.address, s.address) AS party_address,
              src.doc_number AS converted_from_number
       FROM documents d
       LEFT JOIN users u ON u.id = d.user_id
       LEFT JOIN customers c ON c.id = d.party_id AND d.party_type = 'customer'
       LEFT JOIN suppliers s ON s.id = d.party_id AND d.party_type = 'supplier'
       LEFT JOIN documents src ON src.id = d.converted_from_id
       WHERE d.id = ?`,
    )
    .get(id);
  if (!doc) return null;

  const items = db.prepare('SELECT * FROM document_items WHERE document_id = ? ORDER BY id').all(id);
  const convertedTo = db
    .prepare('SELECT id, doc_type, doc_number, status FROM documents WHERE converted_from_id = ?')
    .all(id);

  return {
    document: {
      ...doc,
      on_account: !!doc.on_account,
      // Derived so the client never has to redo the conversion itself.
      paid_total: paidUsdEquivalent(doc),
      outstanding: outstandingOf(doc),
    },
    items,
    convertedTo,
  };
}

export { TAX_RATE };

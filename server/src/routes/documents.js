import { Router } from 'express';
import { db, transaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { getSettings } from '../lib/settings.js';
import {
  DOC_TYPES,
  PARTY_TABLE,
  PAYMENT_METHODS,
  applyEffects,
  buildLines,
  getDocument,
  itemsOf,
  liveSuccessorOf,
  nextDocNumber,
  outstandingOf,
  paidUsdEquivalent,
  reverseEffects,
  settlement,
  totalsFor,
} from '../lib/documents.js';
import { round2 } from '../lib/currency.js';
import { documentMessage, sendable } from '../lib/whatsapp.js';

const router = Router();

router.get('/types', requireAuth, (req, res) => {
  res.json({
    paymentMethods: PAYMENT_METHODS,
    types: Object.entries(DOC_TYPES).map(([key, t]) => ({
      key,
      label: t.label,
      party: t.party,
      movesStock: t.stock !== 0,
      postsToLedger: t.posts !== 0,
      convertsTo: t.convertsTo,
    })),
  });
});

router.get('/', requireAuth, requirePermission('documents'), (req, res) => {
  const { type, status, partyId } = req.query;

  let sql = `
    SELECT d.*, COALESCE(c.name, s.name) AS party_name, u.name AS user_name
    FROM documents d
    LEFT JOIN customers c ON c.id = d.party_id AND d.party_type = 'customer'
    LEFT JOIN suppliers s ON s.id = d.party_id AND d.party_type = 'supplier'
    LEFT JOIN users u ON u.id = d.user_id
    WHERE 1=1`;
  const params = [];

  if (type && DOC_TYPES[type]) {
    sql += ' AND d.doc_type = ?';
    params.push(type);
  }
  if (status) {
    sql += ' AND d.status = ?';
    params.push(status);
  }
  if (partyId) {
    sql += ' AND d.party_id = ?';
    params.push(partyId);
  }
  sql += ' ORDER BY d.created_at DESC, d.id DESC LIMIT 500';

  const documents = db
    .prepare(sql)
    .all(...params)
    .map((d) => ({ ...d, paid_total: paidUsdEquivalent(d), outstanding: outstandingOf(d) }));

  res.json({ documents });
});

router.get('/:id', requireAuth, requirePermission('documents'), (req, res) => {
  const found = getDocument(req.params.id);
  if (!found) return res.status(404).json({ error: 'Document not found' });
  res.json(found);
});

/**
 * The invoice as a WhatsApp message. `?phone=` overrides the number on the
 * customer's record — a company's billing contact is often not the person
 * standing in the shop.
 */
router.get('/:id/whatsapp', requireAuth, requirePermission('documents'), (req, res) => {
  const message = documentMessage(req.params.id);
  if (!message) return res.status(404).json({ error: 'Document not found' });
  res.json(sendable(message, req.query.phone || null));
});

router.post('/', requireAuth, requirePermission('documents'), (req, res) => {
  const {
    docType,
    partyId,
    items,
    discountPercent = 0,
    notes,
    validUntil,
    payments = [],
    paymentMethod = null,
  } = req.body || {};

  const type = DOC_TYPES[docType];
  if (!type) return res.status(400).json({ error: 'Unknown document type' });

  if (partyId) {
    const party = db.prepare(`SELECT * FROM ${PARTY_TABLE[type.party]} WHERE id = ?`).get(partyId);
    if (!party) return res.status(400).json({ error: `That ${type.party} does not exist` });
  } else if (type.posts !== 0) {
    return res.status(400).json({ error: `A ${type.label.toLowerCase()} needs a ${type.party}` });
  }

  try {
    const lines = buildLines(items, docType);
    const totals = totalsFor(lines, discountPercent);
    const { exchange_rate: rate } = getSettings();
    const paid = settlement(payments, paymentMethod, totals.total, rate);

    const id = transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO documents
             (doc_type, doc_number, party_type, party_id, status, valid_until, subtotal,
              discount_percent, discount, tax, total, exchange_rate, on_account, notes, user_id,
              paid_usd, paid_lbp, payment_method)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          docType,
          nextDocNumber(docType),
          type.party,
          partyId || null,
          validUntil || null,
          totals.subtotal,
          totals.discountPercent,
          totals.discount,
          totals.tax,
          totals.total,
          rate,
          // Whatever is not paid at the counter is what goes on the account.
          paid.paidTotal < totals.total ? 1 : 0,
          notes || null,
          req.user.id,
          paid.paidUsd,
          paid.paidLbp,
          paid.method,
        );

      const insertItem = db.prepare(
        `INSERT INTO document_items (document_id, product_id, name, sku, price, quantity, line_total, cost, imeis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const l of lines) {
        insertItem.run(
          info.lastInsertRowid, l.productId, l.name, l.sku, l.price, l.quantity, l.lineTotal, l.cost ?? null,
          l.imeis ?? null,
        );
      }
      return info.lastInsertRowid;
    })();

    res.status(201).json(getDocument(id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Edit a document.
 *
 * A draft is just rewritten. A **confirmed** document has already moved stock
 * and billed somebody, so editing it undoes the old version and applies the new
 * one in the same transaction — if the new version cannot be applied (no stock
 * left, over the credit limit) nothing changes at all. Both halves leave a
 * stock movement and a ledger entry behind, so the correction is on the record
 * rather than being rewritten out of history.
 *
 * A cancelled document is already reversed, so editing it only changes the
 * paperwork.
 */
router.put('/:id', requireAuth, requirePermission('documents'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const { partyId, items, discountPercent, notes, validUntil, payments, paymentMethod } = req.body || {};

  const type = DOC_TYPES[doc.doc_type];
  const nextPartyId = partyId === undefined ? doc.party_id : partyId || null;
  if (nextPartyId) {
    const party = db.prepare(`SELECT * FROM ${PARTY_TABLE[type.party]} WHERE id = ?`).get(nextPartyId);
    if (!party) return res.status(400).json({ error: `That ${type.party} does not exist` });
  } else if (type.posts !== 0) {
    return res.status(400).json({ error: `A ${type.label.toLowerCase()} needs a ${type.party}` });
  }

  try {
    const lines = items
      ? buildLines(items, doc.doc_type)
      : itemsOf(doc.id).map((i) => ({
          productId: i.product_id,
          name: i.name,
          sku: i.sku,
          price: i.price,
          quantity: i.quantity,
          lineTotal: i.line_total,
          cost: i.cost,
        }));
    const totals = totalsFor(lines, discountPercent ?? doc.discount_percent);

    /*
     * A payment is replaced wholesale when one is sent, and left alone when the
     * field is absent — so editing the lines of an already-paid document does
     * not quietly wipe the payment off it.
     */
    const paid =
      payments === undefined
        ? {
            paidUsd: doc.paid_usd,
            paidLbp: doc.paid_lbp,
            paidTotal: paidUsdEquivalent(doc),
            method: doc.payment_method,
          }
        : settlement(payments, paymentMethod, totals.total, doc.exchange_rate);

    if (paid.paidTotal > round2(totals.total) + 0.01) {
      return res.status(400).json({
        error: `${paid.paidTotal.toFixed(2)} USD has already been paid — the new total of ${totals.total.toFixed(
          2,
        )} USD is less than that`,
      });
    }

    transaction(() => {
      // Undo the old version first, using the lines as they stand now.
      if (doc.status === 'confirmed') {
        reverseEffects(doc, itemsOf(doc.id), req.user.id, `Edited ${doc.doc_number}`);
      }

      db.prepare(
        `UPDATE documents SET party_id = ?, valid_until = ?, subtotal = ?, discount_percent = ?,
           discount = ?, tax = ?, total = ?, on_account = ?, notes = ?,
           paid_usd = ?, paid_lbp = ?, payment_method = ? WHERE id = ?`,
      ).run(
        nextPartyId,
        validUntil === undefined ? doc.valid_until : validUntil || null,
        totals.subtotal,
        totals.discountPercent,
        totals.discount,
        totals.tax,
        totals.total,
        paid.paidTotal < totals.total ? 1 : 0,
        notes === undefined ? doc.notes : notes || null,
        paid.paidUsd,
        paid.paidLbp,
        paid.method,
        doc.id,
      );

      db.prepare('DELETE FROM document_items WHERE document_id = ?').run(doc.id);
      const insertItem = db.prepare(
        `INSERT INTO document_items (document_id, product_id, name, sku, price, quantity, line_total, cost, imeis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const l of lines) {
        insertItem.run(doc.id, l.productId, l.name, l.sku, l.price, l.quantity, l.lineTotal, l.cost ?? null);
      }

      // Then apply the edited version, against its new party and totals.
      if (doc.status === 'confirmed') {
        const updated = db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
        applyEffects(updated, itemsOf(doc.id), req.user.id, `Edited ${doc.doc_number}`);
      }
    })();

    res.json(getDocument(doc.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Confirming is the moment a document becomes real: stock moves and, for
 * invoices, the party's balance changes. Everything happens in one transaction.
 */
router.post('/:id/confirm', requireAuth, requirePermission('documents'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.status !== 'draft') {
    return res.status(400).json({ error: `This document is already ${doc.status}` });
  }

  try {
    transaction(() => {
      applyEffects(doc, itemsOf(doc.id), req.user.id);
      db.prepare("UPDATE documents SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?").run(
        doc.id,
      );
    })();

    res.json(getDocument(doc.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Cancelling a confirmed document reverses whatever confirming it did. */
router.post('/:id/cancel', requireAuth, requirePermission('documents'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.status === 'cancelled') {
    return res.status(400).json({ error: 'This document is already cancelled' });
  }

  try {
    transaction(() => {
      if (doc.status === 'confirmed') {
        reverseEffects(doc, itemsOf(doc.id), req.user.id);
      }
      db.prepare("UPDATE documents SET status = 'cancelled' WHERE id = ?").run(doc.id);
    })();

    res.json(getDocument(doc.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Turn a quotation into an order, or either into an invoice. */
router.post('/:id/convert', requireAuth, requirePermission('documents'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.status === 'cancelled') {
    return res.status(400).json({ error: 'A cancelled document cannot be converted' });
  }

  const target = req.body?.docType;
  if (!DOC_TYPES[doc.doc_type].convertsTo.includes(target)) {
    return res.status(400).json({
      error: `A ${DOC_TYPES[doc.doc_type].label.toLowerCase()} cannot become a ${
        DOC_TYPES[target]?.label.toLowerCase() || target
      }`,
    });
  }

  const existing = liveSuccessorOf(doc.id);
  if (existing) {
    return res.status(400).json({ error: `Already converted to ${existing.doc_number}` });
  }

  try {
    const id = transaction(() => {
      const items = db.prepare('SELECT * FROM document_items WHERE document_id = ?').all(doc.id);
      const { exchange_rate: rate } = getSettings();

      const info = db
        .prepare(
          `INSERT INTO documents
             (doc_type, doc_number, party_type, party_id, status, subtotal, discount_percent,
              discount, tax, total, exchange_rate, on_account, notes, converted_from_id, user_id)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          target,
          nextDocNumber(target),
          doc.party_type,
          doc.party_id,
          doc.subtotal,
          doc.discount_percent,
          doc.discount,
          doc.tax,
          doc.total,
          rate,
          doc.on_account,
          doc.notes,
          doc.id,
          req.user.id,
        );

      const insertItem = db.prepare(
        `INSERT INTO document_items (document_id, product_id, name, sku, price, quantity, line_total, cost, imeis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const i of items) {
        insertItem.run(
          info.lastInsertRowid, i.product_id, i.name, i.sku, i.price, i.quantity, i.line_total, i.cost,
          // A conversion carries the quotation's lines forward; the IMEIs are
          // typed when the goods actually arrive, not when they were quoted.
          null,
        );
      }
      return info.lastInsertRowid;
    })();

    res.status(201).json(getDocument(id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Delete a document outright.
 *
 * A confirmed one is reversed first — stock goes back and the balance is
 * cleared — so deleting can never leave the books believing in a document that
 * no longer exists. The reversal's own stock movements and ledger entry stay,
 * which is the point: the paperwork is gone, the correction is not hidden.
 *
 * A document another was created from is kept until that successor is dealt
 * with, so nothing is left pointing at a deleted row.
 */
router.delete('/:id', requireAuth, requirePermission('documents'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const successor = liveSuccessorOf(doc.id);
  if (successor) {
    return res.status(400).json({
      error: `${successor.doc_number} was created from this one — cancel or delete that first`,
    });
  }

  try {
    transaction(() => {
      if (doc.status === 'confirmed') {
        reverseEffects(doc, itemsOf(doc.id), req.user.id, `Deleted ${doc.doc_number}`);
      }
      // A cancelled successor still points here; leave it without a source
      // rather than a dangling one.
      db.prepare('UPDATE documents SET converted_from_id = NULL WHERE converted_from_id = ?').run(doc.id);

      /*
       * The cash this document moved really did move, so the drawer keeps its
       * movements — but they can no longer point at a document that is gone.
       * The note already names it, so nothing is lost from the record.
       */
      db.prepare('UPDATE cash_movements SET document_id = NULL WHERE document_id = ?').run(doc.id);

      // Likewise the cost the delivery arrived at: the price really did change,
      // and the note says which document brought it in.
      db.prepare('UPDATE product_cost_history SET document_id = NULL WHERE document_id = ?').run(doc.id);
      db.prepare('DELETE FROM document_items WHERE document_id = ?').run(doc.id);
      db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    })();

    res.json({ ok: true, deleted: doc.doc_number });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;

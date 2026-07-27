import { Router } from 'express';
import { db, transaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getSettings } from '../lib/settings.js';
import {
  DOC_TYPES,
  PARTY_TABLE,
  applyEffects,
  buildLines,
  getDocument,
  itemsOf,
  liveSuccessorOf,
  nextDocNumber,
  reverseEffects,
  totalsFor,
} from '../lib/documents.js';

const router = Router();

router.get('/types', requireAuth, (req, res) => {
  res.json({
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

router.get('/', requireAuth, requireRole('admin'), (req, res) => {
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

  res.json({ documents: db.prepare(sql).all(...params) });
});

router.get('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const found = getDocument(req.params.id);
  if (!found) return res.status(404).json({ error: 'Document not found' });
  res.json(found);
});

router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  const { docType, partyId, items, discountPercent = 0, notes, validUntil, onAccount = true } =
    req.body || {};

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

    const id = transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO documents
             (doc_type, doc_number, party_type, party_id, status, valid_until, subtotal,
              discount_percent, discount, tax, total, exchange_rate, on_account, notes, user_id)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          onAccount ? 1 : 0,
          notes || null,
          req.user.id,
        );

      const insertItem = db.prepare(
        `INSERT INTO document_items (document_id, product_id, name, sku, price, quantity, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const l of lines) {
        insertItem.run(info.lastInsertRowid, l.productId, l.name, l.sku, l.price, l.quantity, l.lineTotal);
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
router.put('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const { partyId, items, discountPercent, notes, validUntil, onAccount } = req.body || {};

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
        }));
    const totals = totalsFor(lines, discountPercent ?? doc.discount_percent);

    transaction(() => {
      // Undo the old version first, using the lines as they stand now.
      if (doc.status === 'confirmed') {
        reverseEffects(doc, itemsOf(doc.id), req.user.id, `Edited ${doc.doc_number}`);
      }

      db.prepare(
        `UPDATE documents SET party_id = ?, valid_until = ?, subtotal = ?, discount_percent = ?,
           discount = ?, tax = ?, total = ?, on_account = ?, notes = ? WHERE id = ?`,
      ).run(
        nextPartyId,
        validUntil === undefined ? doc.valid_until : validUntil || null,
        totals.subtotal,
        totals.discountPercent,
        totals.discount,
        totals.tax,
        totals.total,
        onAccount === undefined ? doc.on_account : onAccount ? 1 : 0,
        notes === undefined ? doc.notes : notes || null,
        doc.id,
      );

      db.prepare('DELETE FROM document_items WHERE document_id = ?').run(doc.id);
      const insertItem = db.prepare(
        `INSERT INTO document_items (document_id, product_id, name, sku, price, quantity, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const l of lines) {
        insertItem.run(doc.id, l.productId, l.name, l.sku, l.price, l.quantity, l.lineTotal);
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
router.post('/:id/confirm', requireAuth, requireRole('admin'), (req, res) => {
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
router.post('/:id/cancel', requireAuth, requireRole('admin'), (req, res) => {
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
router.post('/:id/convert', requireAuth, requireRole('admin'), (req, res) => {
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
        `INSERT INTO document_items (document_id, product_id, name, sku, price, quantity, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const i of items) {
        insertItem.run(info.lastInsertRowid, i.product_id, i.name, i.sku, i.price, i.quantity, i.line_total);
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
router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
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
      db.prepare('DELETE FROM document_items WHERE document_id = ?').run(doc.id);
      db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    })();

    res.json({ ok: true, deleted: doc.doc_number });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;

import { Router } from 'express';
import { db, transaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getSettings } from '../lib/settings.js';
import { addEntry, creditCheck } from '../lib/accounts.js';
import {
  DOC_TYPES,
  PARTY_TABLE,
  buildLines,
  getDocument,
  nextDocNumber,
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

/** Only drafts are editable — a confirmed document has already moved things. */
router.put('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.status !== 'draft') {
    return res.status(400).json({ error: `A ${doc.status} document cannot be edited` });
  }

  const { partyId, items, discountPercent, notes, validUntil, onAccount } = req.body || {};

  try {
    const lines = items ? buildLines(items, doc.doc_type) : null;
    const totals = lines
      ? totalsFor(lines, discountPercent ?? doc.discount_percent)
      : totalsFor(
          db.prepare('SELECT * FROM document_items WHERE document_id = ?').all(doc.id).map((i) => ({
            lineTotal: i.line_total,
          })),
          discountPercent ?? doc.discount_percent,
        );

    transaction(() => {
      db.prepare(
        `UPDATE documents SET party_id = ?, valid_until = ?, subtotal = ?, discount_percent = ?,
           discount = ?, tax = ?, total = ?, on_account = ?, notes = ? WHERE id = ?`,
      ).run(
        partyId === undefined ? doc.party_id : partyId || null,
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

      if (lines) {
        db.prepare('DELETE FROM document_items WHERE document_id = ?').run(doc.id);
        const insertItem = db.prepare(
          `INSERT INTO document_items (document_id, product_id, name, sku, price, quantity, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const l of lines) {
          insertItem.run(doc.id, l.productId, l.name, l.sku, l.price, l.quantity, l.lineTotal);
        }
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

  const type = DOC_TYPES[doc.doc_type];

  try {
    transaction(() => {
      const items = db.prepare('SELECT * FROM document_items WHERE document_id = ?').all(doc.id);
      if (items.length === 0) throw new Error('A document needs at least one line');

      if (type.stock !== 0) {
        const adjustStock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
        const logMovement = db.prepare(
          `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );

        for (const item of items) {
          if (!item.product_id) continue; // free-text line, nothing to move

          const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
          if (!product) throw new Error(`Product for line "${item.name}" no longer exists`);

          const delta = Math.round(item.quantity) * type.stock;
          const resulting = product.stock + delta;
          if (resulting < 0) {
            throw new Error(
              `Not enough stock for ${product.name} (have ${product.stock}, need ${Math.round(item.quantity)})`,
            );
          }

          adjustStock.run(delta, product.id);
          logMovement.run(
            product.id,
            req.user.id,
            delta,
            resulting,
            type.stock > 0 ? 'received' : 'count_correction',
            doc.doc_number,
          );
        }
      }

      // Only invoices billed to an account touch the ledger; a cash purchase
      // or a paid-on-the-spot sale leaves no balance behind.
      if (type.posts !== 0 && doc.party_id && doc.on_account) {
        if (doc.party_type === 'customer') {
          const check = creditCheck(doc.party_id, doc.total);
          if (!check.ok) throw new Error(check.error);
        }
        addEntry({
          partyType: doc.party_type,
          partyId: doc.party_id,
          kind: doc.doc_type === 'purchase_invoice' ? 'bill' : 'sale',
          amountUsd: doc.total,
          exchangeRate: doc.exchange_rate,
          note: doc.doc_number,
          userId: req.user.id,
        });
      }

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

  const type = DOC_TYPES[doc.doc_type];

  try {
    transaction(() => {
      if (doc.status === 'confirmed') {
        const items = db.prepare('SELECT * FROM document_items WHERE document_id = ?').all(doc.id);

        if (type.stock !== 0) {
          const adjustStock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
          const logMovement = db.prepare(
            `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note)
             VALUES (?, ?, ?, ?, 'count_correction', ?)`,
          );

          for (const item of items) {
            if (!item.product_id) continue;
            const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
            if (!product) continue;

            const delta = Math.round(item.quantity) * -type.stock;
            const resulting = product.stock + delta;
            if (resulting < 0) {
              throw new Error(
                `Cannot cancel: ${product.name} would go below zero (have ${product.stock})`,
              );
            }
            adjustStock.run(delta, product.id);
            logMovement.run(product.id, req.user.id, delta, resulting, `Cancelled ${doc.doc_number}`);
          }
        }

        if (type.posts !== 0 && doc.party_id && doc.on_account) {
          addEntry({
            partyType: doc.party_type,
            partyId: doc.party_id,
            kind: 'refund',
            amountUsd: -doc.total,
            exchangeRate: doc.exchange_rate,
            note: `Cancelled ${doc.doc_number}`,
            userId: req.user.id,
          });
        }
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

  const existing = db
    .prepare("SELECT doc_number FROM documents WHERE converted_from_id = ? AND status != 'cancelled'")
    .get(doc.id);
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

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.status !== 'draft') {
    return res.status(400).json({ error: 'Only drafts can be deleted — cancel it instead' });
  }

  transaction(() => {
    db.prepare('DELETE FROM document_items WHERE document_id = ?').run(doc.id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  })();

  res.json({ ok: true });
});

export default router;

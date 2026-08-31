import { Router } from 'express';
import { branchParams } from '../lib/branchScope.js';
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
import {
  currentSession,
  needsOfficeCash,
  openingOfficeCash,
  plannedSettlement,
  requiresSession,
  settlementAccountId,
} from '../lib/cash.js';
import { round2 } from '../lib/currency.js';
import { documentMessage, sendable } from '../lib/whatsapp.js';
import { notify } from '../lib/telegram.js';
import { deletedText, documentText } from '../lib/notifyText.js';

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

  /*
   * The branch this document belongs to.
   *
   * Invoices and quotations are a branch's own paperwork — its customers, its
   * prices, its numbers — and a manager reading the other shop's sales as their
   * own is the failure branches exist to prevent. `branch=all` is the owner
   * looking at the whole company.
   */
  sql += ' AND (? IS NULL OR d.branch_id = ?)';
  params.push(...branchParams(req));

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
 * Which till this document would settle through, and what else it could.
 *
 * Confirming used to pick a till in silence, and the shop found out which one
 * only by reading the drawer count afterwards and wondering. The office cash is
 * the sensible default but it is not the only possible answer — a shop that
 * genuinely paid a supplier out of the register drawer needs to be able to say
 * so — and a default nobody can see or change is a guess with extra steps.
 *
 * Drawers are offered along with everything else, each saying whether it is
 * open, because "closed" is the whole reason one of them cannot be chosen.
 */
router.get('/:id/settlement', requireAuth, requirePermission('documents'), (req, res) => {
  const doc = db.prepare('SELECT branch_id FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const branchId = doc.branch_id ?? req.branchId ?? null;
  const accounts = db
    .prepare(
      `SELECT id, name, kind FROM cash_accounts
       WHERE active = 1 AND (? IS NULL OR branch_id = ? OR kind != 'drawer')
       ORDER BY is_default DESC, name`,
    )
    .all(branchId, branchId)
    .map((a) => ({ ...a, open: !!currentSession(a.id) }));

  const plan = plannedSettlement(branchId);
  res.json({
    /*
     * Null when confirming would name the office's cash — there is no id to
     * give yet, and inventing one here would mean creating an account because
     * somebody opened a screen. `name` says what it will be called.
     *
     * The screen must send this back only if the shop *changes* it. Handing the
     * app's own answer back as a choice is what made the first version of this
     * refuse the very thing it was written to allow: a choice is held to the
     * open-drawer rule, and a default is not.
     */
    accountId: plan.accountId,
    name: plan.name,
    willCreate: plan.willCreate,
    // A shift is a drawer's business and nothing else's — see lib/cash.js.
    requiresOpenDrawer: requiresSession(),
    accounts,
  });
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
              paid_usd, paid_lbp, payment_method, branch_id)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          /*
           * Which counter wrote it, recorded now rather than left for the
           * start-up backfill to guess at.
           *
           * Leaving it null was a quiet hole in the books: every report is
           * scoped to a branch, and `branch_id IS NULL` matches no branch at
           * all — so an invoice stayed out of the Profit screen until the next
           * restart happened to sweep it into the main branch. A shop that
           * invoices its trade customers could look at a month's takings and
           * see only what went across the register.
           */
          req.branchId,
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
        applyEffects(
          updated,
          itemsOf(doc.id),
          req.user.id,
          `Edited ${doc.doc_number}`,
          // The same till the confirm step would have used, for the same
          // reason: an edit re-applies the payment, and it must land where the
          // original did rather than in whichever drawer the fallback found.
          req.body?.accountId ?? settlementAccountId(req.branchId),
        );
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

  /*
   * Which till the money came out of, or went into.
   *
   * Resolved to a real account here rather than left null and worked out again
   * further down, because the two answers used to differ. The check below asked
   * `defaultAccountId(req.branchId)` — this branch's first account — while the
   * movement it was guarding fell all the way through to `defaultAccountId()`
   * with no branch, which is the *company's* default till. At a second branch
   * those are different drawers, so the app could refuse to confirm because one
   * drawer was shut and, once opened, put the money in another.
   *
   * Told nothing, this is the office's cash rather than the counter's — see
   * `settlementAccountId`. Paperwork is settled at a desk; a shift at the
   * register is somebody else's business.
   */
  const chosen = req.body?.accountId ?? null;
  let accountId = chosen ?? settlementAccountId(req.branchId);

  /*
   * A shut drawer used to be the end of it.
   *
   * The rule itself is sound — money must not leave a till nobody has opened,
   * or the count at the end of the shift is against a figure the drawer never
   * held — but it was being applied to money that was never in that till. An
   * owner paying a supplier at nine in the morning is not raiding the register;
   * they are paying out of the shop's own cash, and the app refused because it
   * had only ever been told about the one place.
   *
   * So a drawer is asked to be open only when the shop picked it: `chosen`
   * below. Left to the app, a closed drawer means the money came from the
   * office, and the office's cash gets a name — see `openingOfficeCash`.
   */
  const settlesInCash = doc.payment_method === 'cash' && paidUsdEquivalent(doc) > 0;

  if (settlesInCash && needsOfficeCash(accountId)) {
    if (chosen) {
      /*
       * Named, rather than "the cashbox": with more than one account the whole
       * question is *which*, and being told to open something without being
       * told what is not an answer.
       */
      const till = db.prepare('SELECT name FROM cash_accounts WHERE id = ?').get(accountId);
      return res.status(400).json({
        error: `${till?.name || 'The cashbox'} is closed — open it, or settle this from the shop’s cash instead`,
      });
    }
    accountId = openingOfficeCash(req.branchId);
  }

  try {
    transaction(() => {
      applyEffects(doc, itemsOf(doc.id), req.user.id, doc.doc_number, accountId);
      db.prepare("UPDATE documents SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?").run(
        doc.id,
      );
    })();

    const saved = getDocument(doc.id);
    res.json(saved);

    notify(
      'document',
      documentText({
        docNumber: doc.doc_number,
        docType: doc.doc_type,
        total: doc.total,
        partyName: saved?.document?.party_name,
        user: req.user.name,
        branchId: doc.branch_id,
      }),
    );
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
              discount, tax, total, exchange_rate, on_account, notes, converted_from_id, user_id,
              branch_id)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          // The quotation's own branch, not whoever happens to be converting it.
          doc.branch_id ?? req.branchId,
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

      // The receipt written for it was already voided by reverseEffects; it
      // keeps its number and its note, and loses only the pointer.
      db.prepare('UPDATE vouchers SET document_id = NULL WHERE document_id = ?').run(doc.id);

      // Likewise the cost the delivery arrived at: the price really did change,
      // and the note says which document brought it in.
      db.prepare('UPDATE product_cost_history SET document_id = NULL WHERE document_id = ?').run(doc.id);
      db.prepare('DELETE FROM document_items WHERE document_id = ?').run(doc.id);
      db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    })();

    res.json({ ok: true, deleted: doc.doc_number });

    /*
     * A deletion is the one thing nobody can reconstruct from the books
     * afterwards, because the row it would be reconstructed from is gone. So it
     * is worth a message even more than a sale is.
     */
    notify(
      'delete',
      deletedText({
        what: String(doc.doc_type).replace(/_/g, ' '),
        detail: `${doc.doc_number} · ${Number(doc.total || 0).toFixed(2)} USD`,
        user: req.user.name,
        branchId: doc.branch_id,
      }),
    );
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;

import { Router } from 'express';
import { db, transaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { decryptSecret } from '../lib/secrets.js';
import { normaliseImei } from '../lib/units.js';
import { getSettings } from '../lib/settings.js';
import { recordMovement, currentSession, requiresSession } from '../lib/cash.js';
import {
  REPAIR_STATUSES,
  addPart,
  openTicket,
  removePart,
  repairProfit,
  setStatus,
  takePayment,
  takeTradeIn,
  ticketWithDetail,
  warrantyOf,
} from '../lib/repairs.js';
import { repairMessage, sendable } from '../lib/whatsapp.js';
import { getIdPhoto, removeIdPhoto, setIdPhoto } from '../lib/idPhotos.js';

const router = Router();

router.get('/statuses', requireAuth, (req, res) => {
  res.json({ statuses: REPAIR_STATUSES });
});

/**
 * What the bench made.
 *
 * Behind `reports` rather than `repairs`, like every other profit figure in
 * this app: taking a phone in and knowing what the bench earns last month are
 * different jobs, and the second is the owner's.
 *
 * Declared above `/:id` because Express matches in order and "profit" is a
 * perfectly good id as far as a route pattern is concerned.
 */
router.get('/profit', requireAuth, requirePermission('reports'), (req, res) => {
  const { from = null, to = null } = req.query;
  res.json(repairProfit({ from: from || null, to: to || null, branchId: req.branchId }));
});

/** The workshop board: what is in, and what is waiting on whom. */
router.get('/', requireAuth, (req, res) => {
  const { status, q, from = null, to = null } = req.query;
  const clauses = [];
  const params = [];

  if (status && status !== 'open') {
    if (!REPAIR_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${REPAIR_STATUSES.join(', ')}` });
    }
    clauses.push('t.status = ?');
    params.push(status);
  } else if (status === 'open') {
    // The default view is work still on the bench; collected jobs pile up fast.
    clauses.push("t.status NOT IN ('collected', 'cancelled')");
  }

  /*
   * Dated here rather than filtered in the browser.
   *
   * The list is capped at the newest 200, and the screen used to narrow *those*
   * by date — so asking for March on a busy bench showed however much of March
   * happened to fall inside the most recent two hundred tickets, silently. The
   * cap is still there; it now applies to the period asked for.
   */
  if (from) {
    clauses.push('t.created_at >= ?');
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    clauses.push('t.created_at <= ?');
    params.push(`${to} 23:59:59`);
  }

  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    clauses.push(
      '(LOWER(t.ticket_number) LIKE ? OR LOWER(t.customer_name) LIKE ? OR LOWER(t.customer_phone) LIKE ? OR t.imei = ?)',
    );
    params.push(like, like, like, normaliseImei(q));
  }

  const tickets = db
    .prepare(
      `SELECT t.*, u.name AS taken_by_name,
              (SELECT COUNT(*) FROM repair_parts p WHERE p.ticket_id = t.id) AS part_count,
              (SELECT COALESCE(SUM(p.price * p.quantity), 0) FROM repair_parts p WHERE p.ticket_id = t.id)
                AS parts_total
       FROM repair_tickets t
       LEFT JOIN users u ON u.id = t.taken_by
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 200`,
    )
    .all(...params);

  res.json({ tickets });
});

router.get('/:id', requireAuth, (req, res) => {
  const detail = ticketWithDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Ticket not found' });
  res.json(detail);
});

/**
 * The ticket as a WhatsApp message, so the customer has the number on their
 * phone as well as on the slip they will probably lose.
 *
 * Open to anyone who can see the ticket, which is the same people who can take
 * one in. The passcode is not in the message — see repairMessage.
 */
router.get('/:id/whatsapp', requireAuth, (req, res) => {
  const message = repairMessage(req.params.id);
  if (!message) return res.status(404).json({ error: 'Ticket not found' });
  res.json(sendable(message, req.query.phone || null));
});

/**
 * The passcode the customer handed over.
 *
 * Admin only and one at a time, like any other credential the shop holds. A
 * technician who needs it can be given it; a screen listing every phone in the
 * shop should not also list how to unlock them.
 */
router.get('/:id/passcode', requireAuth, requirePermission('secrets'), (req, res) => {
  const ticket = db.prepare('SELECT * FROM repair_tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ passcode: decryptSecret(ticket.passcode_enc) });
});

router.post('/', requireAuth, (req, res) => {
  try {
    const id = transaction(() => openTicket(req.body || {}, req.user.id, req.branchId))();
    res.status(201).json(ticketWithDetail(id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id', requireAuth, (req, res) => {
  const { status, note, quoted } = req.body || {};
  try {
    transaction(() => {
      if (quoted !== undefined) {
        db.prepare(`UPDATE repair_tickets SET quoted = ?, updated_at = datetime('now') WHERE id = ?`).run(
          quoted === null ? null : Number(quoted),
          req.params.id,
        );
      }
      if (status) setStatus(req.params.id, status, note, req.user.id);
    })();
    res.json(ticketWithDetail(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/parts', requireAuth, (req, res) => {
  try {
    const detail = transaction(() => addPart(req.params.id, req.body || {}, req.user.id))();
    res.status(201).json(detail);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/parts/:partId', requireAuth, (req, res) => {
  try {
    const detail = transaction(() => removePart(req.params.partId, req.user.id))();
    res.json(detail);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Add up a list of {currency, amount} into the two currencies. */
function tally(payments) {
  let paidUsd = 0;
  let paidLbp = 0;
  for (const p of payments || []) {
    if (p?.currency === 'USD') paidUsd += Number(p.amount) || 0;
    if (p?.currency === 'LBP') paidLbp += Number(p.amount) || 0;
  }
  return { paidUsd, paidLbp };
}

/**
 * Take money on a job that is still on the bench.
 *
 * The common case, and until now the app had no way to say it: the customer
 * hands over the phone and pays the agreed price on the spot, then comes back
 * on Thursday. The cash goes into the drawer the moment it is taken, because it
 * is in the drawer, and the ticket carries on being a ticket.
 */
router.post('/:id/payment', requireAuth, (req, res) => {
  const { charged = null, payments = [], note } = req.body || {};

  try {
    const detail = transaction(() => {
      const ticket = db.prepare('SELECT * FROM repair_tickets WHERE id = ?').get(req.params.id);
      if (!ticket) throw new Error('Ticket not found');

      const { paidUsd, paidLbp } = tally(payments);
      if (requiresSession() && !currentSession(null, ticket.branch_id)) {
        throw new Error('The cashbox is closed — open it before taking cash');
      }
      recordMovement({
        kind: 'sale',
        amountUsd: paidUsd,
        amountLbp: paidLbp,
        note: `Repair ${ticket.ticket_number}`,
        userId: req.user.id,
        branchId: ticket.branch_id,
      });

      return takePayment(ticket.id, { charged, paidUsd, paidLbp, note }, req.user.id);
    })();

    res.status(201).json(detail);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Hand the phone back, and take whatever is left to pay.
 *
 * Cash goes into the drawer the same way a sale's does, so the close still
 * balances. A warranty job is collected at nothing to pay, which is the whole
 * point of having recorded the warranty.
 *
 * A job already paid for is collected at nothing to pay too, and that is the
 * change worth naming: this route used to be the only way money could be
 * recorded against a repair, which is why it was also the only way a ticket
 * could reach its last status. Now it is only the handing back.
 */
router.post('/:id/collect', requireAuth, (req, res) => {
  const { charged = null, payments = [], note } = req.body || {};

  try {
    const detail = transaction(() => {
      const ticket = db.prepare('SELECT * FROM repair_tickets WHERE id = ?').get(req.params.id);
      if (!ticket) throw new Error('Ticket not found');
      if (ticket.status === 'collected') {
        throw new Error(`${ticket.ticket_number} has already been handed back`);
      }
      if (ticket.status === 'cancelled') {
        throw new Error(`${ticket.ticket_number} was cancelled — put it back on the bench first`);
      }

      const amount = charged === null ? Number(ticket.charged ?? 0) || 0 : Math.max(0, Number(charged) || 0);
      if (ticket.under_warranty && amount > 0 && !req.body.chargeAnyway) {
        throw new Error(
          'This phone is under warranty — collect at nothing to pay, or send chargeAnyway to override',
        );
      }

      const { paidUsd, paidLbp } = tally(payments);

      if (paidUsd > 0 || paidLbp > 0) {
        if (requiresSession() && !currentSession(null, ticket.branch_id)) {
          throw new Error('The cashbox is closed — open it before taking cash');
        }
        recordMovement({
          kind: 'sale',
          amountUsd: paidUsd,
          amountLbp: paidLbp,
          note: `Repair ${ticket.ticket_number}`,
          userId: req.user.id,
          branchId: ticket.branch_id,
        });
      }

      db.prepare(
        `UPDATE repair_tickets
         SET status = 'collected', charged = ?,
             paid_usd = paid_usd + ?, paid_lbp = paid_lbp + ?,
             paid_at = CASE WHEN ? > 0 OR ? > 0 THEN COALESCE(paid_at, datetime('now')) ELSE paid_at END,
             collected_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
      ).run(amount, paidUsd, paidLbp, paidUsd, paidLbp, ticket.id);
      db.prepare(
        `INSERT INTO repair_events (ticket_id, status, note, user_id) VALUES (?, 'collected', ?, ?)`,
      ).run(ticket.id, note || null, req.user.id);

      return ticketWithDetail(ticket.id);
    })();

    res.json(detail);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------------------------------------------------------------- trade-ins */

router.post('/trade-ins', requireAuth, (req, res) => {
  try {
    const { exchange_rate: exchangeRate } = getSettings();

    const result = transaction(() => {
      const taken = takeTradeIn({ ...req.body, exchangeRate }, req.user.id);

      /*
       * Buying a phone empties the till. Recorded as cash out so the drawer
       * count at close matches what is actually in it — a trade-in paid from
       * the register and not recorded is a shortfall nobody can explain.
       */
      const paidUsd = Number(req.body.paidUsd) || 0;
      const paidLbp = Number(req.body.paidLbp) || 0;
      if (paidUsd > 0 || paidLbp > 0) {
        // This branch's till, not the company's first one — the money comes out
        // of the drawer standing in front of whoever is paying for the phone.
        if (requiresSession() && !currentSession(null, req.branchId)) {
          throw new Error('The cashbox is closed — open it before paying for a trade-in');
        }
        recordMovement({
          kind: 'cash_out',
          amountUsd: -paidUsd,
          amountLbp: -paidLbp,
          reason: 'supplier',
          note: `Traded in ${taken.unit.imei}`,
          userId: req.user.id,
          branchId: req.branchId,
        });
      }

      return taken;
    })();

    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/trade-ins/list', requireAuth, requirePermission('repairs'), (req, res) => {
  const rows = db
    .prepare(
      /*
       * Whether an ID is on file, not the ID itself. A shop checking that its
       * purchases are documented is asking a yes/no question about two hundred
       * rows, and answering it should not mean sending two hundred photographs
       * to draw a table of names and prices.
       */
      `SELECT ti.*, u.imei, u.imei2, u.status AS unit_status, p.name AS product_name, us.name AS user_name,
              EXISTS (SELECT 1 FROM id_photos i
                        WHERE i.subject_type = 'trade_in' AND i.subject_id = ti.id) AS has_id_photo
       FROM trade_ins ti
       JOIN product_units u ON u.id = ti.unit_id
       JOIN products p ON p.id = u.product_id
       LEFT JOIN users us ON us.id = ti.user_id
       ORDER BY ti.created_at DESC LIMIT 200`,
    )
    .all();
  res.json({ tradeIns: rows });
});

/* ------------------------------------------------------- the seller's ID */

/**
 * Attach or replace the photographed ID after the fact.
 *
 * Because the queue does not wait. A phone gets bought while three people are
 * standing there and the ID gets photographed a minute later; without this the
 * only way to attach it would be to undo the purchase and start again, so it
 * would simply never get attached.
 */
router.post('/trade-ins/:id/id-photo', requireAuth, requirePermission('repairs'), (req, res) => {
  const tradeIn = db.prepare('SELECT id FROM trade_ins WHERE id = ?').get(req.params.id);
  if (!tradeIn) return res.status(404).json({ error: 'Trade-in not found' });

  try {
    const saved = setIdPhoto('trade_in', tradeIn.id, req.body?.idPhoto, req.user.id);
    res.status(201).json({ ...saved, tradeInId: tradeIn.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * The photograph itself — behind `secrets`, the same permission as revealing a
 * customer's saved password.
 *
 * Taking somebody's ID and being able to look at it later are different jobs. A
 * cashier has to be able to do the first, at the counter, with the seller
 * watching. Nobody needs to be able to sit and page through a year of other
 * people's identity documents, so that is a permission of its own rather than a
 * consequence of having had the till open once.
 */
router.get('/trade-ins/:id/id-photo', requireAuth, requirePermission('secrets'), (req, res) => {
  const photo = getIdPhoto('trade_in', req.params.id);
  if (!photo) return res.status(404).json({ error: 'No ID on file for that purchase' });

  res.setHeader('Content-Type', photo.mime);
  res.setHeader('Content-Length', photo.byteSize);
  // Somebody's identity document has no business in a shared cache, and a
  // browser holding it after the shop signs out is the same problem.
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(photo.bytes);
});

/**
 * Remove it. Behind `secrets` rather than `repairs`, because destroying the
 * evidence that a purchase was documented is not a counter task.
 */
router.delete('/trade-ins/:id/id-photo', requireAuth, requirePermission('secrets'), (req, res) => {
  if (!removeIdPhoto('trade_in', req.params.id)) {
    return res.status(404).json({ error: 'No ID on file for that purchase' });
  }
  res.json({ removed: true });
});

/* --------------------------------------------------------------- warranty */

/** What cover a handset has, by either of its IMEIs. */
router.get('/warranty/:imei', requireAuth, (req, res) => {
  const imei = normaliseImei(req.params.imei);
  const unit = db
    .prepare(
      `SELECT u.*, p.name AS product_name, o.order_number, o.buyer_name, o.buyer_phone
       FROM product_units u
       JOIN products p ON p.id = u.product_id
       LEFT JOIN orders o ON o.id = u.sold_order_id
       WHERE u.imei = ? OR u.imei2 = ?`,
    )
    .get(imei, imei);

  if (!unit) return res.status(404).json({ error: `Nothing in the shop's records for ${imei}` });
  res.json({ unit, warranty: warrantyOf(unit) });
});

export default router;

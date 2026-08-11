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
  isClosed,
  openTicket,
  removePart,
  setStatus,
  takeTradeIn,
  ticketWithDetail,
  warrantyOf,
} from '../lib/repairs.js';
import { repairMessage, sendable } from '../lib/whatsapp.js';

const router = Router();

router.get('/statuses', requireAuth, (req, res) => {
  res.json({ statuses: REPAIR_STATUSES });
});

/** The workshop board: what is in, and what is waiting on whom. */
router.get('/', requireAuth, (req, res) => {
  const { status, q } = req.query;
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

/**
 * Hand the phone back and take the money.
 *
 * Cash goes into the drawer the same way a sale's does, so the close still
 * balances. A warranty job is collected at nothing to pay, which is the whole
 * point of having recorded the warranty.
 */
router.post('/:id/collect', requireAuth, (req, res) => {
  const { charged = null, payments = [], note } = req.body || {};

  try {
    const detail = transaction(() => {
      const ticket = db.prepare('SELECT * FROM repair_tickets WHERE id = ?').get(req.params.id);
      if (!ticket) throw new Error('Ticket not found');
      if (isClosed(ticket.status)) throw new Error(`${ticket.ticket_number} is already ${ticket.status}`);

      const amount = charged === null ? 0 : Math.max(0, Number(charged) || 0);
      if (ticket.under_warranty && amount > 0 && !req.body.chargeAnyway) {
        throw new Error(
          'This phone is under warranty — collect at nothing to pay, or send chargeAnyway to override',
        );
      }

      let paidUsd = 0;
      let paidLbp = 0;
      for (const p of payments) {
        if (p?.currency === 'USD') paidUsd += Number(p.amount) || 0;
        if (p?.currency === 'LBP') paidLbp += Number(p.amount) || 0;
      }

      if (paidUsd > 0 || paidLbp > 0) {
        if (requiresSession() && !currentSession()) {
          throw new Error('The cashbox is closed — open it before taking cash');
        }
        recordMovement({
          kind: 'sale',
          amountUsd: paidUsd,
          amountLbp: paidLbp,
          note: `Repair ${ticket.ticket_number}`,
          userId: req.user.id,
        });
      }

      db.prepare(
        `UPDATE repair_tickets
         SET status = 'collected', charged = ?, collected_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
      ).run(amount, ticket.id);
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
        if (requiresSession() && !currentSession()) {
          throw new Error('The cashbox is closed — open it before paying for a trade-in');
        }
        recordMovement({
          kind: 'cash_out',
          amountUsd: -paidUsd,
          amountLbp: -paidLbp,
          reason: 'supplier',
          note: `Traded in ${taken.unit.imei}`,
          userId: req.user.id,
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
      `SELECT ti.*, u.imei, u.imei2, u.status AS unit_status, p.name AS product_name, us.name AS user_name
       FROM trade_ins ti
       JOIN product_units u ON u.id = ti.unit_id
       JOIN products p ON p.id = u.product_id
       LEFT JOIN users us ON us.id = ti.user_id
       ORDER BY ti.created_at DESC LIMIT 200`,
    )
    .all();
  res.json({ tradeIns: rows });
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

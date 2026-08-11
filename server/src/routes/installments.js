import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { balanceOf, recordPayment } from '../lib/accounts.js';
import { recordMovement } from '../lib/cash.js';
import {
  allocate,
  createPlan,
  listPlans,
  planWithDues,
  settleIfDone,
} from '../lib/installments.js';
import { installmentMessage, sendable } from '../lib/whatsapp.js';

const router = Router();

/*
 * Instalments are the customer's account seen from a different angle, so they
 * sit behind the same permission. A shop that lets somebody take payments off
 * customers is already letting them do this.
 */
router.get('/', requireAuth, requirePermission('parties'), (req, res) => {
  res.json({ plans: listPlans({ status: req.query.status || null }) });
});

router.get('/:id', requireAuth, requirePermission('parties'), (req, res) => {
  const plan = planWithDues(req.params.id);
  if (!plan) return res.status(404).json({ error: 'No such plan' });
  res.json({ plan, balance: balanceOf('customer', plan.customer_id) });
});

router.post('/', requireAuth, requirePermission('parties'), (req, res) => {
  const { customerId, orderId = null, total, count, startDate, note = null } = req.body || {};
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) return res.status(404).json({ error: 'Pick which customer this is for' });

  try {
    const id = createPlan({
      customerId: customer.id,
      orderId,
      total,
      count,
      startDate,
      note,
      branchId: req.branchId,
      userId: req.user.id,
    });
    res.status(201).json({ plan: planWithDues(id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * A payment against a plan.
 *
 * Recorded as an ordinary customer payment first — the ledger is what says what
 * is owed, and this must not become a second opinion — and only then allocated
 * across the months it covers. Cash moves the drawer the same way settling any
 * account does.
 */
router.post('/:id/payments', requireAuth, requirePermission('parties'), (req, res) => {
  const plan = planWithDues(req.params.id);
  if (!plan) return res.status(404).json({ error: 'No such plan' });
  if (plan.status === 'cancelled') return res.status(400).json({ error: 'That plan was cancelled' });

  try {
    const result = recordPayment({
      partyType: 'customer',
      partyId: plan.customer_id,
      payments: req.body?.payments,
      note: req.body?.note || `Instalment — ${plan.customer_name}`,
      userId: req.user.id,
    });

    if (req.body?.inCash !== false) {
      recordMovement({
        kind: 'customer_payment',
        amountUsd: result.paidUsd,
        amountLbp: result.paidLbp,
        reason: 'customer_payment',
        note: `Instalment — ${plan.customer_name}`,
        userId: req.user.id,
      });
    }

    const allocated = allocate(plan.id, result.amountUsd ?? result.paidUsd);

    res.status(201).json({
      allocated,
      plan: planWithDues(plan.id),
      balance: balanceOf('customer', plan.customer_id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Stop chasing a plan.
 *
 * Cancelled rather than deleted, and it does not touch the ledger: whatever the
 * customer still owes, they still owe. This says the shop has stopped expecting
 * it in monthly pieces — written off, settled some other way, or an arrangement
 * that changed.
 */
router.post('/:id/cancel', requireAuth, requirePermission('parties'), (req, res) => {
  const plan = planWithDues(req.params.id);
  if (!plan) return res.status(404).json({ error: 'No such plan' });

  db.prepare('UPDATE installment_plans SET status = ? WHERE id = ?').run('cancelled', plan.id);
  res.json({ plan: planWithDues(plan.id) });
});

/** The reminder, ready to send — the same machinery as a receipt. */
router.get('/:id/whatsapp', requireAuth, requirePermission('parties'), (req, res) => {
  const plan = planWithDues(req.params.id);
  if (!plan) return res.status(404).json({ error: 'No such plan' });
  res.json(sendable(installmentMessage(plan), req.query.phone || plan.customer_phone || null));
});

export { settleIfDone };
export default router;

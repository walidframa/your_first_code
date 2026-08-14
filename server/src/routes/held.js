import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { countHeld, heldById, holdSale, listHeld, resumeHeld, voidHeld } from '../lib/heldSales.js';

const router = Router();
/*
 * Parking a sale is part of using the register, not a privilege of its own —
 * whoever may ring a sale up may put it down. A separate permission would only
 * mean the cashier who most needs the counter back is the one who cannot have it.
 */
const till = [requireAuth, requirePermission('register')];

router.get('/', ...till, (req, res) => {
  const status = ['held', 'resumed', 'voided', 'all'].includes(req.query.status) ? req.query.status : 'held';
  res.json({
    held: listHeld({ status, limit: req.query.limit, branchId: req.branchId }),
    count: countHeld(req.branchId),
  });
});

router.get('/:id', ...till, (req, res) => {
  const held = heldById(Number(req.params.id));
  if (!held) return res.status(404).json({ error: 'That held sale does not exist' });
  res.json({ held });
});

router.post('/', ...till, (req, res) => {
  const { label, cart, context, customerId, customerName, note } = req.body || {};
  try {
    const held = holdSale({
      label,
      cart,
      context,
      customerId,
      customerName,
      note,
      userId: req.user.id,
      branchId: req.branchId,
    });
    res.status(201).json({ held, count: countHeld(req.branchId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Pick one back up.
 *
 * Comes back with `issues`: what has been sold, archived or run down since it
 * was parked. A hold reserves nothing, and the cashier is the one standing in
 * front of the customer who has to hear about it.
 */
router.post('/:id/resume', ...till, (req, res) => {
  try {
    const held = resumeHeld(Number(req.params.id), req.user.id);
    res.json({ held, issues: held.issues, count: countHeld(req.branchId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', ...till, (req, res) => {
  try {
    res.json({ held: voidHeld(Number(req.params.id), req.user.id), count: countHeld(req.branchId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;

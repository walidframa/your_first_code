import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import {
  cancelTransfer,
  listTransfers,
  receiveTransfer,
  sendTransfer,
  transferById,
} from '../lib/stockTransfers.js';

const router = Router();
const stockroom = [requireAuth, requirePermission('transfer_stock')];

router.get('/', ...stockroom, (req, res) => {
  const status = ['draft', 'sent', 'received', 'cancelled'].includes(req.query.status)
    ? req.query.status
    : null;

  /*
   * Scoped to the branch the caller is in: both what they have sent and what is
   * coming to them. A list of every branch's paperwork is not something anybody
   * stands at a counter and reads.
   */
  res.json({ transfers: listTransfers({ branchId: req.branchId, status, limit: req.query.limit }) });
});

router.get('/:id', ...stockroom, (req, res) => {
  const transfer = transferById(Number(req.params.id));
  if (!transfer) return res.status(404).json({ error: 'That transfer does not exist' });
  res.json({ transfer });
});

/**
 * Send stock to another branch.
 *
 * It leaves this shelf now. The box is going in the car, and a shelf that still
 * counts what has physically left is a shelf that will oversell.
 */
router.post('/', ...stockroom, (req, res) => {
  const { toBranchId, items, note } = req.body || {};
  try {
    const transfer = sendTransfer({
      fromBranchId: req.branchId,
      toBranchId,
      items,
      note,
      userId: req.user.id,
    });
    res.status(201).json({ transfer });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Take delivery.
 *
 * `counts` is what actually came out of the box, keyed by line id. Left out, it
 * is taken to be everything that was sent — which is the common case and should
 * not need typing.
 */
router.post('/:id/receive', ...stockroom, (req, res) => {
  const transfer = transferById(Number(req.params.id));
  if (!transfer) return res.status(404).json({ error: 'That transfer does not exist' });
  if (transfer.to_branch_id !== req.branchId) {
    return res.status(400).json({
      error: `${transfer.reference} is on its way to ${transfer.to_branch_name} — it has to be received there`,
    });
  }

  try {
    res.json({ transfer: receiveTransfer(Number(req.params.id), { userId: req.user.id, counts: req.body?.counts }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/cancel', ...stockroom, (req, res) => {
  try {
    res.json({ transfer: cancelTransfer(Number(req.params.id), req.user.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;

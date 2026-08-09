import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { listAccounts as listCashAccounts } from '../lib/cashAccounts.js';
import {
  TRANSFER_COMPANIES,
  TRANSFER_DIRECTIONS,
  cancelTransfer,
  listTransfers,
  recordTransfer,
  summarise,
  transferById,
} from '../lib/transfers.js';

const router = Router();

// The whole desk is one permission: an operator either runs it or does not.
const desk = [requireAuth, requirePermission('transfers')];

router.get('/meta', ...desk, (req, res) => {
  // The desk's own till is picked here rather than assumed: a transfer counter
  // with its own float is the whole reason tills are named.
  res.json({
    companies: TRANSFER_COMPANIES,
    directions: TRANSFER_DIRECTIONS,
    tills: listCashAccounts({ activeOnly: true }),
  });
});

/**
 * The counter's day.
 *
 * The list and its totals come back together: an operator asking "how am I
 * doing" and an operator asking "where is that transfer" are the same person
 * looking at the same screen.
 */
router.get('/', ...desk, (req, res) => {
  const { preset = 'today', search = '', mine } = req.query;
  const transfers = listTransfers({
    preset,
    search: String(search).trim(),
    operatorId: mine === 'true' ? req.user.id : null,
  });
  res.json({ transfers, summary: summarise(transfers) });
});

router.get('/:id', ...desk, (req, res) => {
  const transfer = transferById(req.params.id);
  if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
  res.json({ transfer });
});

router.post('/', ...desk, (req, res) => {
  try {
    const transfer = recordTransfer({ ...req.body, userId: req.user.id });
    res.status(201).json({ transfer });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/cancel', ...desk, (req, res) => {
  try {
    res.json({ transfer: cancelTransfer(req.params.id, req.user.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;

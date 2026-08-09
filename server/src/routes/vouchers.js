import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { accountRegistry } from '../lib/registry.js';
import {
  ACCOUNT_TYPES,
  VOUCHER_KINDS,
  VOUCHER_REASONS,
  cancelVoucher,
  listVouchers,
  recordVoucher,
  summarise,
  voucherById,
} from '../lib/vouchers.js';

const router = Router();
const desk = [requireAuth, requirePermission('vouchers')];

/**
 * Everything the form needs, in one request.
 *
 * "Which account?" is one question at the counter, not five — and five round
 * trips to answer it is five chances for a list to be half-loaded while
 * somebody waits to be paid.
 */
router.get('/meta', ...desk, (req, res) => {
  res.json({
    kinds: VOUCHER_KINDS,
    accountTypes: ACCOUNT_TYPES,
    reasons: VOUCHER_REASONS,
    accounts: accountRegistry({ activeOnly: true }),
  });
});

router.get('/', ...desk, (req, res) => {
  const { preset = 'month', kind = null, search = '' } = req.query;
  const vouchers = listVouchers({ preset, kind, search: String(search).trim() });
  res.json({ vouchers, summary: summarise(vouchers) });
});

router.get('/:id', ...desk, (req, res) => {
  const voucher = voucherById(req.params.id);
  if (!voucher) return res.status(404).json({ error: 'Voucher not found' });
  res.json({ voucher });
});

router.post('/', ...desk, (req, res) => {
  try {
    res.status(201).json({ voucher: recordVoucher({ ...req.body, userId: req.user.id }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/cancel', ...desk, (req, res) => {
  try {
    res.json({ voucher: cancelVoucher(req.params.id, req.user.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;

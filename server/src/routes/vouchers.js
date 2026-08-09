import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { listWallets } from '../lib/wallets.js';
import {
  ACCOUNT_TYPES,
  PAYMENT_REASONS,
  RECEIPT_REASONS,
  VOUCHER_KINDS,
  VOUCHER_METHODS,
  cancelVoucher,
  listVouchers,
  recordVoucher,
  summarise,
  voucherById,
} from '../lib/vouchers.js';

const router = Router();
const desk = [requireAuth, requirePermission('vouchers')];

/**
 * Everything the form needs to be filled in, in one request.
 *
 * The accounts come back together because "which account?" is one question at
 * the counter, not three — and three round trips to answer it is three chances
 * for the list to be half-loaded when somebody is waiting to be paid.
 */
router.get('/meta', ...desk, (req, res) => {
  const parties = (table) =>
    db.prepare(`SELECT id, name, phone FROM ${table} WHERE active = 1 ORDER BY name`).all();

  res.json({
    kinds: VOUCHER_KINDS,
    accountTypes: ACCOUNT_TYPES,
    methods: VOUCHER_METHODS,
    reasons: { payment: PAYMENT_REASONS, receipt: RECEIPT_REASONS },
    accounts: {
      customer: parties('customers'),
      supplier: parties('suppliers'),
      wallet: listWallets({ activeOnly: true }).map((w) => ({
        id: w.id,
        name: w.name,
        balance: w.balance,
        currency: w.currency,
      })),
    },
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

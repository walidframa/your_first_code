import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  getSettings,
  publicSettings,
  setSetting,
  recordRateChange,
  getRateHistory,
} from '../lib/settings.js';

const router = Router();

/** Any signed-in user can read settings — the register needs the live rate. */
router.get('/', requireAuth, (req, res) => {
  res.json({ settings: publicSettings() });
});

router.get('/rate-history', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ history: getRateHistory(req.query.limit) });
});

router.put('/', requireAuth, requireRole('admin'), (req, res) => {
  const { exchange_rate: exchangeRate, lbp_rounding: lbpRounding } = req.body || {};
  const current = getSettings();

  if (exchangeRate !== undefined) {
    const rate = Number(exchangeRate);
    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(400).json({ error: 'Exchange rate must be a positive number' });
    }
    if (rate !== current.exchange_rate) {
      setSetting('exchange_rate', rate, req.user.id);
      recordRateChange(rate, req.user.id);
    }
  }

  if (lbpRounding !== undefined) {
    const step = Number(lbpRounding);
    if (!Number.isFinite(step) || step < 1) {
      return res.status(400).json({ error: 'Rounding step must be at least 1' });
    }
    setSetting('lbp_rounding', Math.round(step), req.user.id);
  }

  res.json({ settings: publicSettings() });
});

export default router;

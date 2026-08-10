import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import {
  getSettings,
  publicSettings,
  setSetting,
  recordRateChange,
  getRateHistory,
} from '../lib/settings.js';

const router = Router();

/**
 * Who the shop is. Free text, so it is saved as typed.
 *
 * The one that needs a limit is the logo: pasted as a data: URI it is the only
 * setting that can be megabytes, and it is read on every page load.
 */
const COMPANY_FIELDS = [
  'company_name',
  'company_tagline',
  'company_phone',
  'company_phone2',
  'company_address',
  'company_email',
  'company_website',
  'company_tax_number',
  'company_logo_url',
  'receipt_footer',
];

const MAX_LOGO_BYTES = 400 * 1024;

/** Any signed-in user can read settings — the register needs the live rate. */
router.get('/', requireAuth, (req, res) => {
  res.json({ settings: publicSettings() });
});

router.get('/rate-history', requireAuth, requirePermission('settings'), (req, res) => {
  res.json({ history: getRateHistory(req.query.limit) });
});

router.put('/', requireAuth, requirePermission('settings'), (req, res) => {
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

  for (const field of COMPANY_FIELDS) {
    if (req.body[field] === undefined) continue;
    const value = String(req.body[field] ?? '').trim();

    if (field === 'company_logo_url' && Buffer.byteLength(value, 'utf8') > MAX_LOGO_BYTES) {
      return res.status(400).json({
        error:
          'That logo is too big. Keep it under 400KB — a receipt prints it at about 40mm wide, ' +
          'so a small PNG is all it needs.',
      });
    }
    if (field === 'company_name' && !value) {
      // Everything a customer keeps is headed with this. Blank would print a
      // receipt nobody could bring back.
      return res.status(400).json({ error: 'The company name cannot be empty' });
    }

    setSetting(field, value, req.user.id);
  }

  res.json({ settings: publicSettings() });
});

export default router;

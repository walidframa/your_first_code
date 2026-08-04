/**
 * Accounts the shop set up on a customer's behalf.
 *
 * The customer comes back having forgotten the iCloud the shop created for them
 * when they bought the phone. This is how the counter finds it — by the phone's
 * IMEI, by the account name, or by the buyer's name or number, because which of
 * those they remember is anyone's guess.
 *
 * Passwords never travel with a list. Reading one is a separate, deliberate
 * request, so a screen showing twenty customers is not twenty passwords on
 * display behind the counter.
 */

import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { decryptSecret } from '../lib/secrets.js';
import { ACCOUNT_KINDS } from './orders.js';
import { normaliseImei } from '../lib/units.js';

const router = Router();

const SELECT = `
  SELECT a.id, a.kind, a.username, a.note, a.created_at,
         a.order_id, a.unit_id,
         o.order_number, o.buyer_name, o.buyer_phone, o.created_at AS sold_on,
         u.imei, u.imei2,
         p.name AS product_name
  FROM order_accounts a
  JOIN orders o ON o.id = a.order_id
  LEFT JOIN product_units u ON u.id = a.unit_id
  LEFT JOIN products p ON p.id = u.product_id
`;

router.get('/kinds', requireAuth, (req, res) => {
  res.json({ kinds: ACCOUNT_KINDS });
});

/**
 * Find held accounts.
 *
 * One box, searched against everything the customer might say: the IMEI off the
 * phone, the account name, their own name, their number, or the order.
 */
router.get('/', requireAuth, (req, res) => {
  const term = String(req.query.q ?? '').trim();
  if (!term) return res.json({ accounts: [] });

  const like = `%${term.toLowerCase()}%`;
  const imei = normaliseImei(term);

  const accounts = db
    .prepare(
      `${SELECT}
       WHERE LOWER(a.username) LIKE ?
          OR LOWER(o.buyer_name) LIKE ?
          OR LOWER(o.buyer_phone) LIKE ?
          OR LOWER(o.order_number) LIKE ?
          OR u.imei = ? OR u.imei2 = ?
       ORDER BY a.created_at DESC
       LIMIT 50`,
    )
    .all(like, like, like, like, imei, imei);

  res.json({ accounts });
});

/**
 * Reveal one password.
 *
 * Admin only, and one at a time. The shop's own staff giving a customer their
 * account back is the point of storing it; a cashier being able to page through
 * every password in the shop is not.
 */
router.get('/:id/password', requireAuth, requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM order_accounts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Account not found' });

  const password = decryptSecret(row.password_enc);
  if (password === null && row.password_enc) {
    return res.status(409).json({
      error:
        'This password cannot be read — it was saved with a different ACCOUNT_SECRET than the one now set.',
    });
  }

  res.json({ username: row.username, password });
});

export default router;

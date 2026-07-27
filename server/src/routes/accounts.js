import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { accountsSummary } from '../lib/accounts.js';

const router = Router();

router.get('/summary', requireAuth, requireRole('admin'), (req, res) => {
  res.json(accountsSummary());
});

/** Recent movement across both sides of the book — the cash-flow feed. */
router.get('/entries', requireAuth, requireRole('admin'), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);

  const entries = db
    .prepare(
      `SELECT e.*, u.name AS user_name, o.order_number,
              COALESCE(c.name, s.name) AS party_name
       FROM account_entries e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN orders o ON o.id = e.order_id
       LEFT JOIN customers c ON c.id = e.party_id AND e.party_type = 'customer'
       LEFT JOIN suppliers s ON s.id = e.party_id AND e.party_type = 'supplier'
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ?`,
    )
    .all(limit);

  res.json({ entries });
});

export default router;

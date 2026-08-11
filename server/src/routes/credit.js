import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { describe, quote } from '../lib/credit.js';
import { balanceOf } from '../lib/wallets.js';

const router = Router();

/**
 * The carriers credit can be sent from, with what is left in each.
 *
 * Open to anyone signed in: topping a customer up is counter work, and the
 * dialog has to be able to say the balance is running out before the shop finds
 * out by a send failing.
 */
router.get('/carriers', requireAuth, (req, res) => {
  const carriers = db
    .prepare('SELECT * FROM wallets WHERE sends_credit = 1 AND active = 1 ORDER BY name')
    .all();

  res.json({
    carriers: carriers.map((w) => ({
      id: w.id,
      name: w.name,
      smsFee: w.sms_fee,
      lowBalance: w.low_balance,
      balance: balanceOf(w.id),
    })),
  });
});

/**
 * What a top-up would cost, before anybody commits to it.
 *
 * Worked out by the server rather than the browser so that the figure on the
 * screen is the same arithmetic that will run at checkout — a preview that
 * disagrees with the sale is worse than no preview.
 */
router.get('/quote', requireAuth, (req, res) => {
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(Number(req.query.walletId));
  if (!wallet) return res.status(404).json({ error: 'Pick which carrier the credit comes from' });
  if (!wallet.sends_credit) {
    return res.status(400).json({ error: `${wallet.name} is not set up to send credit` });
  }

  try {
    const quoted = quote(req.query.amount, wallet.sms_fee);
    res.json({
      ...quoted,
      describe: describe(quoted),
      carrier: { id: wallet.id, name: wallet.name, balance: balanceOf(wallet.id) },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * What has been sent, newest first — the answer to "did the $10 reach that
 * number", which is the question a customer comes back with.
 */
router.get('/sends', requireAuth, requirePermission('reports'), (req, res) => {
  const params = [];
  const where = [];

  if (req.query.msisdn) {
    where.push('c.msisdn LIKE ?');
    params.push(`%${String(req.query.msisdn).replace(/\D/g, '')}%`);
  }
  if (req.query.all !== 'true') {
    where.push('c.branch_id = ?');
    params.push(req.branchId);
  }

  const sends = db
    .prepare(
      `SELECT c.*, w.name AS carrier, u.name AS user_name, o.order_number
       FROM credit_sends c
       JOIN wallets w ON w.id = c.wallet_id
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN orders o ON o.id = c.order_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ?`,
    )
    .all(...params, Number(req.query.limit) || 200);

  res.json({ sends });
});

export default router;

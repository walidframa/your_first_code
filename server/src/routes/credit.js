import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { describe, quote } from '../lib/credit.js';
import { balanceOf, creditCostBasis, recordMovement } from '../lib/wallets.js';
import { getSettings } from '../lib/settings.js';
import { round2, usdToLbp } from '../lib/currency.js';

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
      priceLbp: w.credit_price_lbp,
      // What a dollar of this credit really cost, which is not face value for
      // a shop that gets it back off validity cards.
      costBasis: creditCostBasis(w.id),
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
    const { exchange_rate: rate, lbp_rounding: step } = getSettings();
    const basis = creditCostBasis(wallet.id);

    /*
     * Credit is quoted in pounds — "110,000 a dollar" is the number the counter
     * says out loud — and the register works in dollars, so the suggested
     * charge is that figure converted back at today's rate.
     */
    const chargeLbp = Math.round(quoted.amount * wallet.credit_price_lbp);
    const suggested = rate > 0 ? round2(chargeLbp / rate) : quoted.amount;

    res.json({
      ...quoted,
      describe: describe(quoted),
      priceLbp: wallet.credit_price_lbp,
      chargeLbp,
      suggested,
      costBasis: basis,
      /*
       * What the shop is really out of pocket: the credit *and* the message
       * fees, both at what its credit cost it. The fees come off the same
       * balance, so they are worth the same as the credit they sit beside.
       */
      realCost: round2(quoted.cost * basis),
      costLbp: rate > 0 ? usdToLbp(round2(quoted.cost * basis), rate, step) : 0,
      carrier: { id: wallet.id, name: wallet.name, balance: balanceOf(wallet.id) },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Credit coming back the other way.
 *
 * How a Lebanese shop actually gets its balance: it sells a 30-day validity
 * card that carries $7.50, and the customer sends most of that back to the
 * shop's own line rather than using it. The shop then sells it on by the
 * dollar.
 *
 * Recorded as a top-up with **what it cost** stated separately, because it did
 * not cost what it added — the card was already bought and already sold at a
 * margin, so credit coming back this way is usually free. Left at face value
 * the shop would think it earns nothing on the half of the business that earns
 * the most.
 */
router.post('/received', requireAuth, requirePermission('register'), (req, res) => {
  const { walletId, amount, costUsd = 0, msisdn = null, note = null } = req.body || {};

  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(Number(walletId));
  if (!wallet) return res.status(404).json({ error: 'Pick which carrier it came in on' });
  if (!wallet.sends_credit) {
    return res.status(400).json({ error: `${wallet.name} is not set up for credit` });
  }

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ error: 'Say how much credit came back' });
  }
  const cost = Number(costUsd);
  if (!Number.isFinite(cost) || cost < 0) {
    return res.status(400).json({ error: 'What it cost cannot be less than nothing' });
  }

  recordMovement({
    walletId: wallet.id,
    kind: 'top_up',
    amount: round2(value),
    costUsd: round2(cost),
    userId: req.user.id,
    note: [msisdn ? `Back from ${msisdn}` : 'Credit taken back', note].filter(Boolean).join(' — '),
  });

  res.status(201).json({
    balance: balanceOf(wallet.id),
    costBasis: creditCostBasis(wallet.id),
  });
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

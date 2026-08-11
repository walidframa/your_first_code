import { Router } from 'express';
import { db, transaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import {
  WALLET_CURRENCIES,
  WALLET_KINDS,
  listWallets,
  movementsFor,
  recordMovement,
  roundAmount,
  walletById,
} from '../lib/wallets.js';
import { installStarterCatalogue, STARTER_CARD_COUNT } from '../lib/prepaidCatalogue.js';

const router = Router();

/*
 * Readable by anyone signed in: the register shows what is left on the wallet
 * beside the cards it funds, and a cashier who cannot see it finds out the
 * credit ran out by selling something the shop cannot deliver.
 */
router.get('/', requireAuth, (req, res) => {
  res.json({ wallets: listWallets({ activeOnly: req.query.activeOnly === 'true' }) });
});

router.post('/', requireAuth, requirePermission('cards'), (req, res) => {
  const { name, kind = 'other', currency = 'USD', lowBalance = 0, note = null, opening = 0 } = req.body || {};

  if (!name || !String(name).trim()) return res.status(400).json({ error: 'A wallet needs a name' });
  if (!WALLET_KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of: ${WALLET_KINDS.join(', ')}` });
  }
  if (!WALLET_CURRENCIES.includes(currency)) {
    return res.status(400).json({ error: `currency must be one of: ${WALLET_CURRENCIES.join(', ')}` });
  }

  try {
    const wallet = transaction(() => {
      const info = db
        .prepare('INSERT INTO wallets (name, kind, currency, low_balance, note) VALUES (?, ?, ?, ?, ?)')
        .run(String(name).trim(), kind, currency, roundAmount(lowBalance, currency), note || null);

      // An opening balance is just the first top-up, so it appears on the
      // statement rather than being a figure with no movement behind it.
      if (Number(opening) > 0) {
        recordMovement({
          walletId: info.lastInsertRowid,
          kind: 'top_up',
          amount: Number(opening),
          note: 'Opening balance',
          userId: req.user.id,
        });
      }
      return walletById(info.lastInsertRowid);
    })();
    res.status(201).json({ wallet });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A wallet with that name already exists' });
    }
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', requireAuth, requirePermission('cards'), (req, res) => {
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.id);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

  const { name, kind, lowBalance, note, active, sendsCredit, smsFee, creditPriceLbp } =
    req.body || {};
  if (kind !== undefined && !WALLET_KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of: ${WALLET_KINDS.join(', ')}` });
  }

  /*
   * The currency is deliberately not editable. Changing it would leave every
   * past movement denominated in a currency the wallet no longer uses, and the
   * balance would be a sum of two different things.
   */
  const merged = {
    name: name === undefined ? wallet.name : String(name).trim(),
    kind: kind === undefined ? wallet.kind : kind,
    low_balance: lowBalance === undefined ? wallet.low_balance : roundAmount(lowBalance, wallet.currency),
    note: note === undefined ? wallet.note : note || null,
    active: active === undefined ? wallet.active : active ? 1 : 0,
    /*
     * Whether the shop can top a customer up out of this balance by SMS, and
     * what the carrier charges per message. Only a wallet marked this way
     * appears in the register's credit dialog — a gift-card float is a balance
     * too, and sending "$" out of it means nothing.
     */
    sends_credit: sendsCredit === undefined ? wallet.sends_credit : sendsCredit ? 1 : 0,
    sms_fee: smsFee === undefined ? wallet.sms_fee : Number(smsFee),
    /*
     * What a dollar of credit sells for, in pounds — "110,000 a dollar" is the
     * figure the counter quotes, so it is stored as that rather than derived
     * from a USD price and today's rate.
     */
    credit_price_lbp:
      creditPriceLbp === undefined ? wallet.credit_price_lbp : Number(creditPriceLbp),
  };
  if (!merged.name) return res.status(400).json({ error: 'A wallet needs a name' });
  if (!Number.isFinite(merged.sms_fee) || merged.sms_fee < 0) {
    return res.status(400).json({ error: 'A message fee cannot be negative' });
  }
  if (!Number.isFinite(merged.credit_price_lbp) || merged.credit_price_lbp < 0) {
    return res.status(400).json({ error: 'A credit price cannot be negative' });
  }

  try {
    db.prepare(
      `UPDATE wallets SET name = ?, kind = ?, low_balance = ?, note = ?, active = ?,
                          sends_credit = ?, sms_fee = ?, credit_price_lbp = ?
       WHERE id = ?`,
    ).run(
      merged.name,
      merged.kind,
      merged.low_balance,
      merged.note,
      merged.active,
      merged.sends_credit,
      merged.sms_fee,
      merged.credit_price_lbp,
      wallet.id,
    );
  } catch {
    return res.status(409).json({ error: 'A wallet with that name already exists' });
  }
  res.json({ wallet: walletById(wallet.id) });
});

router.delete('/:id', requireAuth, requirePermission('cards'), (req, res) => {
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.id);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

  /*
   * Cards funded by a wallet that has gone would have nowhere to take their
   * cost from, and would quietly start looking like pure profit. Say so instead.
   */
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM products WHERE wallet_id = ? AND active = 1').get(wallet.id);
  if (n > 0) {
    return res.status(409).json({
      error: `${n} card${n === 1 ? ' is' : 's are'} funded by ${wallet.name}. Point them somewhere else first.`,
    });
  }

  db.prepare('UPDATE wallets SET active = 0 WHERE id = ?').run(wallet.id);
  res.json({ ok: true });
});

router.get('/:id/movements', requireAuth, requirePermission('cards'), (req, res) => {
  const wallet = walletById(req.params.id);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  res.json({ wallet, movements: movementsFor(wallet.id, req.query.limit) });
});

/**
 * Put credit in, take it out, or correct it.
 *
 * Topping up is the shop paying its supplier; a correction is the shop agreeing
 * with the supplier's statement. Both are the same row with a different name on
 * it, which is what makes the balance a single sum.
 */
router.post('/:id/movements', requireAuth, requirePermission('cards'), (req, res) => {
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.id);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

  const { kind = 'top_up', amount, note = null } = req.body || {};
  if (!['top_up', 'withdrawal', 'adjustment'].includes(kind)) {
    return res.status(400).json({ error: 'kind must be top_up, withdrawal or adjustment' });
  }

  const value = Number(amount);
  if (!Number.isFinite(value) || value === 0) {
    return res.status(400).json({ error: 'Enter an amount' });
  }
  // Direction belongs to the kind, not to the typist: a top-up of -50 would
  // read on the statement as money added.
  const signed = kind === 'withdrawal' ? -Math.abs(value) : kind === 'top_up' ? Math.abs(value) : value;

  try {
    recordMovement({ walletId: wallet.id, kind, amount: signed, note, userId: req.user.id });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.status(201).json({ wallet: walletById(wallet.id) });
});

/**
 * Fill the catalogue with the cards a Lebanese phone shop already sells.
 *
 * Nobody wants to type ninety products before selling their first recharge, and
 * these prices are the same in every shop on the street.
 */
router.post('/starter-catalogue', requireAuth, requirePermission('cards'), (req, res) => {
  const result = transaction(() => installStarterCatalogue({ userId: req.user.id }))();
  res.status(201).json({ ...result, total: STARTER_CARD_COUNT, wallets: listWallets() });
});

export default router;

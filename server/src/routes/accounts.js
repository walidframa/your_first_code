import { Router } from 'express';
import { branchParams, branchScope } from '../lib/branchScope.js';
import { db } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { accountsSummary } from '../lib/accounts.js';
import { accountRegistry, registrySummary } from '../lib/registry.js';
import {
  CASH_ACCOUNT_KINDS,
  archiveAccount,
  createAccount,
  updateAccount,
} from '../lib/cashAccounts.js';

const router = Router();

/**
 * Every account the shop has, of every kind.
 *
 * Readable by anyone signed in, because the pickers on the counter screens need
 * it — the balances it carries are the shop's own figures, not a customer's
 * private business, and the ledger behind each one still takes `parties`.
 */
router.get('/registry', requireAuth, (req, res) => {
  const registry = accountRegistry({
    activeOnly: req.query.activeOnly === 'true',
    branchId: branchScope(req),
  });
  res.json({ registry, summary: registrySummary(registry), cashKinds: CASH_ACCOUNT_KINDS });
});

/*
 * Tills are the one kind of account with no screen of its own — a customer has
 * Customers, a wallet has Cards — so they are created and renamed here.
 */
router.post('/cash', requireAuth, requirePermission('cashbox'), (req, res) => {
  try {
    res.status(201).json({ account: createAccount({ branchId: req.branchId, ...(req.body || {}) }) });
  } catch (err) {
    const conflict = String(err.message).includes('UNIQUE');
    res.status(conflict ? 409 : 400).json({
      error: conflict ? 'A till with that name already exists' : err.message,
    });
  }
});

router.put('/cash/:id', requireAuth, requirePermission('cashbox'), (req, res) => {
  try {
    res.json({ account: updateAccount(Number(req.params.id), req.body || {}) });
  } catch (err) {
    const conflict = String(err.message).includes('UNIQUE');
    res.status(conflict ? 409 : 400).json({
      error: conflict ? 'A till with that name already exists' : err.message,
    });
  }
});

router.delete('/cash/:id', requireAuth, requirePermission('cashbox'), (req, res) => {
  try {
    res.json({ account: archiveAccount(Number(req.params.id)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/summary', requireAuth, requirePermission('parties'), (req, res) => {
  res.json(accountsSummary());
});

/** Recent movement across both sides of the book — the cash-flow feed. */
router.get('/entries', requireAuth, requirePermission('parties'), (req, res) => {
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
       WHERE (? IS NULL OR e.branch_id = ?)
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ?`,
    )
    .all(...branchParams(req), limit);

  res.json({ entries });
});

export default router;

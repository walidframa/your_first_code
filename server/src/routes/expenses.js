import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import {
  EXPENSE_CATEGORIES,
  PAID_WITH,
  addExpense,
  deleteExpense,
  expenseSummary,
  listExpenses,
} from '../lib/expenses.js';
import { presetRange, profitForSession, profitReport } from '../lib/profit.js';

const router = Router();
/*
 * Recording what the shop spends and reading what it made are different jobs.
 * A transfer operator paying for the water needs the first and has no business
 * with the second.
 */
const spending = [requireAuth, requirePermission('expenses')];
const reporting = [requireAuth, requirePermission('reports')];

router.get('/categories', requireAuth, (req, res) => {
  res.json({ categories: EXPENSE_CATEGORIES, paidWith: PAID_WITH });
});

router.get('/', ...spending, (req, res) => {
  const { from, to, category, preset } = req.query;
  const range = preset ? presetRange(preset) : { from, to };

  res.json({
    expenses: listExpenses({ ...range, category }),
    summary: expenseSummary(range),
    period: range,
  });
});

router.post('/', ...spending, (req, res) => {
  const { spentOn, category, amountUsd, amountLbp, paidWith, supplierId, note } = req.body || {};
  try {
    const expense = addExpense({
      spentOn,
      category,
      amountUsd,
      amountLbp,
      paidWith,
      supplierId,
      note,
      userId: req.user.id,
    });
    res.status(201).json({ expense });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', ...spending, (req, res) => {
  try {
    res.json(deleteExpense(Number(req.params.id), req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * The profit report.
 *
 * `includeExpenses=false` answers a different question — whether the pricing
 * works, before the cost of keeping the doors open — so it is a choice rather
 * than a different report.
 */
router.get('/profit', ...reporting, (req, res) => {
  const { from, to, preset, sessionId, includeExpenses } = req.query;
  const withExpenses = includeExpenses !== 'false';

  if (sessionId) {
    const report = profitForSession(Number(sessionId), { includeExpenses: withExpenses });
    if (!report) return res.status(404).json({ error: 'Session not found' });
    return res.json(report);
  }

  const range = preset ? presetRange(preset) : { from: from || null, to: to || null };
  res.json(profitReport({ ...range, includeExpenses: withExpenses }));
});

export default router;

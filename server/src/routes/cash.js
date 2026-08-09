import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { can } from '../lib/permissions.js';
import {
  CASH_IN_REASONS,
  CASH_OUT_REASONS,
  defaultAccountId,
  DENOMINATIONS,
  closeSession,
  currentSession,
  expectedIn,
  listSessions,
  movementsFor,
  openSession,
  recordMovement,
  requiresSession,
  sessionSummary,
} from '../lib/cash.js';

const router = Router();

/**
 * The register needs to know whether the drawer is open, so this is not
 * admin-only — but the expected figure is withheld while the session is running.
 * A cashier who can see what the drawer should hold can make their count match
 * it, and the close would tell nobody anything.
 */
router.get('/current', requireAuth, (req, res) => {
  // Which till is being asked about; every screen names its own, and anything
  // that does not care gets the default one.
  const accountId = Number(req.query.accountId) || null;
  const session = currentSession(accountId);
  if (!session) {
    return res.json({
      session: null,
      required: requiresSession(),
      denominations: DENOMINATIONS,
      accountId: accountId ?? defaultAccountId(),
    });
  }

  const movements = movementsFor(session.id);
  const seesTheTill = can(req.user, 'cashbox');
  res.json({
    session,
    accountId: session.account_id,
    required: requiresSession(),
    denominations: DENOMINATIONS,
    reasons: { in: CASH_IN_REASONS, out: CASH_OUT_REASONS },
    movementCount: movements.length,
    /*
     * Whoever is trusted with the till's history may see what should be in it;
     * everyone else counts blind, so the figure at close means something. Tied
     * to the permission rather than the role, so a shop that wants its transfer
     * operator to see the drawer can simply grant it.
     */
    expected: seesTheTill ? expectedIn(session.id) : null,
    movements: seesTheTill ? movements : movements.filter((m) => m.kind !== 'opening_float'),
  });
});

router.post('/open', requireAuth, (req, res) => {
  const { openingUsd = 0, openingLbp = 0, note, accountId = null } = req.body || {};
  try {
    const session = openSession({
      userId: req.user.id,
      accountId,
      openingUsd,
      openingLbp,
      note,
    });
    res.status(201).json({ session });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Money in or out of the drawer by hand: petty cash put in, a supplier paid
 * from the till, the day's takings run to the bank.
 */
router.post('/movements', requireAuth, (req, res) => {
  const { direction, amountUsd = 0, amountLbp = 0, reason, note, accountId = null } = req.body || {};
  const session = currentSession(accountId);
  if (!session) return res.status(400).json({ error: 'Open the cashbox first' });

  if (!['in', 'out'].includes(direction)) {
    return res.status(400).json({ error: 'Say whether the money is going in or out' });
  }

  const allowed = direction === 'in' ? CASH_IN_REASONS : CASH_OUT_REASONS;
  if (!allowed.includes(reason)) {
    return res.status(400).json({ error: `Reason must be one of: ${allowed.join(', ')}` });
  }

  const usd = Math.abs(Number(amountUsd) || 0);
  const lbp = Math.abs(Number(amountLbp) || 0);
  if (usd === 0 && lbp === 0) {
    return res.status(400).json({ error: 'Enter an amount in dollars, pounds, or both' });
  }

  // Taking out more than is there is a counting mistake, not a transaction.
  if (direction === 'out') {
    const expected = expectedIn(session.id);
    if (usd > expected.usd || lbp > expected.lbp) {
      return res.status(400).json({
        error: `The drawer only holds ${expected.usd.toFixed(2)} USD and ${expected.lbp.toLocaleString()} LL`,
      });
    }
  }

  const sign = direction === 'in' ? 1 : -1;
  recordMovement({
    sessionId: session.id,
    kind: direction === 'in' ? 'cash_in' : 'cash_out',
    amountUsd: sign * usd,
    amountLbp: sign * lbp,
    reason,
    note: note || null,
    userId: req.user.id,
  });

  res.status(201).json({
    session,
    expected: req.user.role === 'admin' ? expectedIn(session.id) : null,
  });
});

/** Closing is a count, so the drawer's expected contents comes back with it. */
router.post('/close', requireAuth, (req, res) => {
  const { countedUsd = 0, countedLbp = 0, carriedUsd = null, carriedLbp = null, note, accountId = null } =
    req.body || {};
  const session = currentSession(accountId);
  if (!session) return res.status(400).json({ error: 'The cashbox is not open' });
  try {
    const summary = closeSession({
      sessionId: session.id,
      userId: req.user.id,
      countedUsd,
      countedLbp,
      carriedUsd,
      carriedLbp,
      note,
    });
    res.json(summary);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/sessions', requireAuth, requirePermission('cashbox'), (req, res) => {
  res.json({ sessions: listSessions(req.query.limit, Number(req.query.accountId) || null) });
});

router.get('/sessions/:id', requireAuth, requirePermission('cashbox'), (req, res) => {
  const summary = sessionSummary(Number(req.params.id));
  if (!summary) return res.status(404).json({ error: 'Session not found' });
  res.json(summary);
});

export default router;

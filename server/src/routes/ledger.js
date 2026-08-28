import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import {
  ACCOUNT_TYPES,
  accountLedger,
  accountById,
  archiveAccount,
  checkLines,
  createAccount,
  entryById,
  listAccounts,
  listEntries,
  postEntry,
  reverseEntry,
  trialBalance,
  updateAccount,
} from '../lib/ledger.js';
import { DIMENSIONS, archive, create, list, performance, update } from '../lib/dimensions.js';
import { settlementLines, vatReturn } from '../lib/vat.js';
import { revaluation, revaluationLines } from '../lib/revaluation.js';
import { getSettings } from '../lib/settings.js';
import { db } from '../db.js';

const router = Router();
const books = [requireAuth, requirePermission('ledger')];

/* --------------------------------------------- cost centres and areas */

/**
 * The two axes share one set of routes because they are one idea pointed at
 * two questions — see lib/dimensions.js. Writing them twice would be two sets
 * of rules to keep in step for no gain.
 */
for (const kind of Object.keys(DIMENSIONS)) {
  const path = kind === 'centre' ? 'cost-centres' : 'areas';

  router.get(`/${path}`, ...books, (req, res) => {
    res.json({ items: list(kind, { activeOnly: req.query.activeOnly === 'true' }) });
  });

  router.post(`/${path}`, ...books, (req, res) => {
    try {
      res.status(201).json({ item: create(kind, req.body || {}) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put(`/${path}/:id`, ...books, (req, res) => {
    try {
      res.json({ item: update(kind, Number(req.params.id), req.body || {}) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete(`/${path}/:id`, ...books, (req, res) => {
    try {
      res.json({ item: archive(kind, Number(req.params.id)) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** What each one earned and spent — the question the chart cannot answer. */
  router.get(`/${path}/performance`, ...books, (req, res) => {
    res.json(performance(kind, { from: req.query.from || null, to: req.query.to || null }));
  });
}

/* ------------------------------------------------------ chart of accounts */

router.get('/accounts', ...books, (req, res) => {
  res.json({
    accounts: listAccounts({ activeOnly: req.query.activeOnly === 'true' }),
    types: ACCOUNT_TYPES,
  });
});

router.post('/accounts', ...books, (req, res) => {
  try {
    res.status(201).json({ account: createAccount(req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/accounts/:id', ...books, (req, res) => {
  try {
    res.json({ account: updateAccount(Number(req.params.id), req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/accounts/:id', ...books, (req, res) => {
  try {
    res.json({ account: archiveAccount(Number(req.params.id)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** One account's own page: every line posted to it, with a running balance. */
router.get('/accounts/:id/ledger', ...books, (req, res) => {
  const page = accountLedger(Number(req.params.id), {
    from: req.query.from || null,
    to: req.query.to || null,
  });
  if (!page) return res.status(404).json({ error: 'That account does not exist' });
  res.json(page);
});

/* ---------------------------------------------------------- journal entries */

router.get('/entries', ...books, (req, res) => {
  res.json({
    entries: listEntries({
      from: req.query.from || null,
      to: req.query.to || null,
      accountId: Number(req.query.accountId) || null,
      limit: req.query.limit,
    }),
  });
});

router.get('/entries/:id', ...books, (req, res) => {
  const entry = entryById(Number(req.params.id));
  if (!entry) return res.status(404).json({ error: 'That entry does not exist' });
  res.json({ entry });
});

/**
 * Say whether these lines would post, without posting them.
 *
 * So the form can show "out by 12.00" while somebody is still typing, rather
 * than after they press save. The same function the write path uses, because a
 * second copy of the balancing rule is a second copy that will disagree.
 */
router.post('/entries/check', ...books, (req, res) => {
  res.json({ problem: checkLines(req.body?.lines || []) });
});

router.post('/entries', ...books, (req, res) => {
  try {
    const entry = postEntry({
      entryDate: req.body?.entryDate || null,
      memo: req.body?.memo || null,
      lines: req.body?.lines || [],
      branchId: req.branchId,
      userId: req.user.id,
    });
    res.status(201).json({ entry });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Undone by its opposite, never by deletion — see lib/ledger.js. */
router.post('/entries/:id/reverse', ...books, (req, res) => {
  try {
    res.status(201).json({
      entry: reverseEntry(Number(req.params.id), { userId: req.user.id, memo: req.body?.memo || null }),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ---------------------------------------------------------------- reports */

/* -------------------------------------------------------------------- VAT */

router.get('/vat', ...books, (req, res) => {
  res.json(vatReturn({ from: req.query.from || null, to: req.query.to || null }));
});

/**
 * Settle a period: clear both tax accounts and pay or reclaim the difference.
 *
 * A real entry rather than a note on a screen, because that is what settling
 * *is*. A shop that pays its tax and leaves the payable standing will be shown
 * the same money owed again next quarter, and will pay it twice.
 */
router.post('/vat/settle', ...books, (req, res) => {
  const from = req.body?.from || null;
  const to = req.body?.to || null;

  const settlement = settlementLines({ from, to });
  if (!settlement) return res.status(400).json({ error: 'There is nothing to settle for those dates' });

  /* Which account the money moves through. Named by the caller, because paying
     the tax office from the drawer and paying it from the bank are different
     facts and only the shop knows which happened. */
  const throughCode = String(req.body?.through || '1120');
  const through = db
    .prepare('SELECT id, name FROM gl_accounts WHERE code = ? AND active = 1 AND is_group = 0')
    .get(throughCode);
  if (!through) return res.status(400).json({ error: `No account has the code ${throughCode}` });

  try {
    const lines = settlement.lines.map((l) => ({
      accountId: db.prepare('SELECT id FROM gl_accounts WHERE code = ?').get(l.code).id,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo,
    }));

    // The difference: paid out if the shop owes it, taken in if it is owed.
    if (settlement.due !== 0) {
      lines.push({
        accountId: through.id,
        debit: settlement.due < 0 ? Math.abs(settlement.due) : 0,
        credit: settlement.due > 0 ? settlement.due : 0,
        memo: settlement.due > 0 ? `Paid through ${through.name}` : `Reclaimed into ${through.name}`,
      });
    }

    const entry = postEntry({
      entryDate: to,
      memo: `${getSettings().tax_name || 'Tax'} settled${from || to ? ` for ${from || 'the start'} to ${to || 'today'}` : ''}`,
      lines,
      source: 'vat',
      branchId: req.branchId,
      userId: req.user.id,
    });
    res.status(201).json({ entry, settlement });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------------------------------------------------- exchange differences */

router.get('/revaluation', ...books, (req, res) => {
  res.json(revaluation());
});

/**
 * Restate the pounds at today's rate.
 *
 * One entry dated today. The entries already written are left exactly as they
 * are — a sale records what it was worth when it was rung up, and rewriting
 * that every time the rate moves would make last month's accounts disagree
 * with themselves.
 */
router.post('/revaluation', ...books, (req, res) => {
  const restatement = revaluationLines();
  if (!restatement) {
    return res.status(400).json({ error: 'There is nothing to restate at the current rate' });
  }

  try {
    const entry = postEntry({
      entryDate: req.body?.date || null,
      memo: `Pounds restated at ${restatement.rate.toLocaleString('en-US')}`,
      lines: restatement.lines,
      source: 'revaluation',
      branchId: req.branchId,
      userId: req.user.id,
    });
    res.status(201).json({ entry, restatement });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/trial-balance', ...books, (req, res) => {
  res.json(trialBalance({ from: req.query.from || null, to: req.query.to || null }));
});

export default router;

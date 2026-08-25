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

router.get('/trial-balance', ...books, (req, res) => {
  res.json(trialBalance({ from: req.query.from || null, to: req.query.to || null }));
});

export default router;

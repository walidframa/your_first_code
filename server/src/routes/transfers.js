import { Router } from 'express';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth.js';
import { listAccounts as listCashAccounts } from '../lib/cashAccounts.js';
import {
  TRANSFER_COMPANIES,
  TRANSFER_DIRECTIONS,
  cancelTransfer,
  listTransfers,
  recordTransfer,
  summarise,
  transferById,
} from '../lib/transfers.js';
import {
  companyById,
  createCompany,
  listCompanies,
  setOpeningBalance,
  updateCompany,
} from '../lib/transferCompanies.js';
import { listEntries } from '../lib/accounts.js';

const router = Router();

// The whole desk is one permission: an operator either runs it or does not.
const desk = [requireAuth, requirePermission('transfers')];

/**
 * The one thing at this desk that is the owner's alone.
 *
 * An agency's opening balance is not a transfer — it is the figure every later
 * balance is measured from, and moving it moves what the shop appears to owe
 * without anything having happened at the counter. An operator who is four
 * hundred dollars short has an obvious way to make that disappear, and it
 * would leave no trace at the till.
 *
 * Recording transfers is still the operator's job. Saying where the count
 * starts is not.
 */
const owner = [...desk, requireRole('admin')];

router.get('/meta', ...desk, (req, res) => {
  // The desk's own till is picked here rather than assumed: a transfer counter
  // with its own float is the whole reason tills are named.
  res.json({
    // The names a Lebanese shop usually deals with, and the agencies this one
    // actually has an account with — which after the first transfer is the
    // list that matters.
    companies: TRANSFER_COMPANIES,
    agencies: listCompanies(),
    directions: TRANSFER_DIRECTIONS,
    tills: listCashAccounts({ activeOnly: true }),
  });
});

/* --------------------------------------------------------------- agencies */

/**
 * What the shop stands at with each agency.
 *
 * The figure an operator compares against the agency's own app at the end of a
 * day, which is the whole point of keeping it.
 */
router.get('/companies', ...desk, (req, res) => {
  res.json({ companies: listCompanies({ includeInactive: req.query.all === '1' }) });
});

router.get('/companies/:id', ...desk, (req, res) => {
  const company = companyById(req.params.id);
  if (!company) return res.status(404).json({ error: 'That agency does not exist' });
  res.json({
    company,
    entries: listEntries('transfer_company', company.id),
  });
});

router.post('/companies', ...desk, (req, res) => {
  try {
    const company = createCompany({ ...req.body, userId: req.user.id });
    res.status(201).json({ company });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/companies/:id', ...desk, (req, res) => {
  try {
    res.json({ company: updateCompany(req.params.id, req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Where the balance starts, for a shop that was trading before this screen.
 *
 * Owner only — see `owner` above.
 */
router.put('/companies/:id/opening', ...owner, (req, res) => {
  try {
    const company = setOpeningBalance(req.params.id, { ...req.body, userId: req.user.id });
    res.json({ company });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * The counter's day.
 *
 * The list and its totals come back together: an operator asking "how am I
 * doing" and an operator asking "where is that transfer" are the same person
 * looking at the same screen.
 */
router.get('/', ...desk, (req, res) => {
  const { preset = 'today', search = '', mine } = req.query;
  const transfers = listTransfers({
    preset,
    search: String(search).trim(),
    operatorId: mine === 'true' ? req.user.id : null,
  });
  res.json({ transfers, summary: summarise(transfers) });
});

router.get('/:id', ...desk, (req, res) => {
  const transfer = transferById(req.params.id);
  if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
  res.json({ transfer });
});

router.post('/', ...desk, (req, res) => {
  try {
    const transfer = recordTransfer({ ...req.body, userId: req.user.id });
    res.status(201).json({ transfer });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/cancel', ...desk, (req, res) => {
  try {
    res.json({ transfer: cancelTransfer(req.params.id, req.user.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;

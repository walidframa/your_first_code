import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { can } from '../lib/permissions.js';
import {
  archiveBranch,
  branchById,
  createBranch,
  ensureBranchTill,
  listBranches,
  reopenBranch,
  updateBranch,
} from '../lib/branches.js';
import { stockByBranch } from '../lib/stock.js';
import { incomingCount } from '../lib/stockTransfers.js';

const router = Router();
const setup = [requireAuth, requirePermission('branches')];

/**
 * Which branches exist, and which one the caller is in.
 *
 * Open to any signed-in user, because the app has to be able to say where you
 * are working — but `canSwitch` is what decides whether the picker is a choice
 * or a label.
 */
router.get('/', requireAuth, (req, res) => {
  const canSwitch = can(req.user, 'branches');
  const all = listBranches({ activeOnly: !canSwitch });

  res.json({
    branches: canSwitch ? all : all.filter((b) => b.id === req.branchId),
    current: req.branchId,
    home: req.user.branch_id ?? null,
    canSwitch,
    /*
     * How many shops there are, as distinct from how many this person may see.
     *
     * Somebody pinned to a counter is sent one branch — their own — so the app
     * could not tell "a shop with one branch" from "a cashier at one of three",
     * and hid the branch name in both cases. The first is right: a shop with
     * one counter should never be told which counter. The second left a clerk
     * at Saida with nothing on screen saying so, which matters the moment
     * somebody has to check they are ringing up against the right shelf.
     */
    total: listBranches({ activeOnly: true }).length,
    incoming: incomingCount(req.branchId),
  });
});

router.get('/:id', ...setup, (req, res) => {
  const branch = branchById(Number(req.params.id));
  if (!branch) return res.status(404).json({ error: 'That branch does not exist' });
  res.json({ branch });
});

/**
 * Open a second shop.
 *
 * It gets a till of its own straight away — a branch that cannot take a cash
 * sale is not open, and finding that out at the counter on the first morning is
 * the worst possible time.
 */
router.post('/', ...setup, (req, res) => {
  try {
    const branch = createBranch(req.body || {});
    ensureBranchTill(branch.id);
    res.status(201).json({ branch });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', ...setup, (req, res) => {
  try {
    res.json({ branch: updateBranch(Number(req.params.id), req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', ...setup, (req, res) => {
  try {
    res.json({ branch: archiveBranch(Number(req.params.id)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/reopen', ...setup, (req, res) => {
  res.json({ branch: reopenBranch(Number(req.params.id)) });
});

/** Where one product is, across every shop. */
router.get('/stock/:productId', requireAuth, (req, res) => {
  res.json({ branches: stockByBranch(Number(req.params.productId)) });
});

export default router;

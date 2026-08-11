import { Router } from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { KEEP, backupDir, listBackups, makeBackup } from '../lib/backups.js';

const router = Router();

/*
 * A backup is the whole shop in one file — every customer, every price, and the
 * encrypted passwords held on customers' behalf. So it sits behind `settings`,
 * the permission the shop already treats as "runs this place", rather than
 * behind merely being signed in.
 */
router.get('/', requireAuth, requirePermission('settings'), (req, res) => {
  res.json({ backups: listBackups(), directory: backupDir(), keep: KEEP });
});

router.post('/', requireAuth, requirePermission('settings'), (req, res) => {
  try {
    res.status(201).json({ backup: makeBackup() });
  } catch (err) {
    res.status(500).json({ error: `Could not take a backup: ${err.message}` });
  }
});

/**
 * Download one, to somewhere that is not this machine.
 *
 * The name is checked against the directory listing rather than sanitised: a
 * name that is not one of ours is not a name to reason about, and matching
 * against what actually exists cannot be walked out of with `..`.
 */
router.get('/:name', requireAuth, requirePermission('settings'), (req, res) => {
  const known = listBackups().some((b) => b.name === req.params.name);
  const file = path.join(backupDir(), req.params.name);
  if (!known || !existsSync(file)) return res.status(404).json({ error: 'No such backup' });

  res.download(file, req.params.name);
});

export default router;

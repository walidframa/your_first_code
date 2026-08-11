/**
 * Copies of the shop's books.
 *
 * The whole business is one SQLite file on one machine: every sale, every
 * customer, every IMEI, every repair and every password the shop is holding on
 * a customer's behalf. Lose the machine and the shop loses its memory — and the
 * moment somebody notices is the moment it is too late to have thought about
 * it.
 *
 * Two things make a backup real rather than reassuring:
 *
 * It is taken with `VACUUM INTO`, which asks SQLite itself for a consistent
 * copy. Copying the file with the filesystem while the server is running gives
 * you a torn database and a WAL you have not copied — it usually opens, which
 * is worse than failing, because you find out at restore time.
 *
 * And **`server/.env` is not in it**. The customer passwords and repair
 * passcodes inside are encrypted with `ACCOUNT_SECRET`, which lives there. A
 * database restored without that file has all of them permanently unreadable,
 * so every screen that offers a backup says so, and the file is named to make
 * the pairing obvious.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { databasePath, db } from '../db.js';

/** How many nightly copies to keep before the oldest is dropped. */
export const KEEP = 14;

/**
 * Where copies go: beside the database unless told otherwise.
 *
 * Beside it is the wrong place for a fire and the right place for the far more
 * likely accident — a bad import, a wrong bulk edit, a restore needed ten
 * minutes later. Somewhere else entirely is what `BACKUP_DIR` is for, and what
 * the screen tells the shop to arrange.
 */
export function backupDir() {
  return process.env.BACKUP_DIR || path.join(path.dirname(databasePath), 'backups');
}

const STAMP = /^pos-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.sqlite$/;

/** A name that sorts by age and says when it was taken. */
function nameFor(now = new Date()) {
  return `pos-${now.toISOString().slice(0, 19).replaceAll(':', '-')}.sqlite`;
}

/**
 * Take one, now.
 *
 * `VACUUM INTO` refuses to overwrite, which is the behaviour we want: a name
 * collision means two backups within the same second, and the first one is
 * every bit as good as the second.
 */
export function makeBackup() {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });

  const name = nameFor();
  const file = path.join(dir, name);
  if (existsSync(file)) return describe(dir, name);

  // Quoted rather than bound: VACUUM INTO takes a literal, not a parameter.
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);

  prune(dir);
  return describe(dir, name);
}

function describe(dir, name) {
  const taken = STAMP.exec(name)?.[1]?.replaceAll('-', ':').replace('T', ' ') ?? null;
  return {
    name,
    bytes: statSync(path.join(dir, name)).size,
    // Read back off the name rather than the file's mtime: a copied or synced
    // file keeps its name and loses its timestamps.
    takenAt: taken ? `${taken.slice(0, 10).replaceAll(':', '-')} ${taken.slice(11)}` : null,
  };
}

/** Newest first, so the one somebody wants is the one at the top. */
export function listBackups() {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => STAMP.test(n))
    .sort()
    .reverse()
    .map((n) => describe(dir, n));
}

/** Drop the oldest beyond `KEEP`, so a year of nightly copies is not a problem. */
function prune(dir, keep = KEEP) {
  const old = readdirSync(dir)
    .filter((n) => STAMP.test(n))
    .sort()
    .reverse()
    .slice(keep);
  for (const name of old) rmSync(path.join(dir, name), { force: true });
  return old.length;
}

/**
 * One a night, while the server is up.
 *
 * Checked every half hour rather than scheduled for a particular time: a shop's
 * machine is turned off at night and on again in the morning, so a backup timed
 * for 3am would never once fire. This takes one whenever the newest is a day
 * old, which on a machine that runs from nine to seven means one a day, taken
 * shortly after it is switched on.
 */
export function startNightlyBackups({ everyMs = 30 * 60 * 1000 } = {}) {
  const due = () => {
    const [newest] = listBackups();
    if (!newest) return true;
    const age = Date.now() - new Date(`${newest.takenAt.replace(' ', 'T')}Z`).getTime();
    return !(age < 24 * 60 * 60 * 1000);
  };

  const tick = () => {
    try {
      if (due()) makeBackup();
    } catch (err) {
      // A failed backup must never take the shop's till down with it.
      console.error('Backup failed:', err.message);
    }
  };

  tick();
  const timer = setInterval(tick, everyMs);
  // Nothing here should hold the process open on its own.
  timer.unref?.();
  return timer;
}

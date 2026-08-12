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

/*
 * The name carries the second it was taken, and — only when it has to — which
 * one within that second. See `makeBackup` for why the second half exists.
 */
const STAMP = /^pos-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:-(\d+))?\.sqlite$/;

/** A name that says when it was taken, and tells two in one second apart. */
function nameFor(now = new Date(), seq = 1) {
  const stamp = now.toISOString().slice(0, 19).replaceAll(':', '-');
  return `pos-${stamp}${seq > 1 ? `-${seq}` : ''}.sqlite`;
}

/**
 * Take one, now.
 *
 * The name has to be free, and finding a free one is not fussiness. This used
 * to hand back the existing copy when the second collided, on the reasoning
 * that two backups a second apart are the same backup. That reasoning is wrong
 * in exactly one place, and it is the place that matters most: a restore takes
 * a safety copy of where the shop is *now* immediately before standing on it.
 * If a copy had been taken in the same second — which is precisely what happens
 * when somebody takes one, looks at it, and decides to roll back — the "safety
 * copy" was the old state, and the work being undone was saved nowhere at all.
 *
 * `VACUUM INTO` still refuses to overwrite, which is the backstop.
 */
export function makeBackup() {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });

  const now = new Date();
  let name = nameFor(now);
  // A second holding a hundred backups is a loop somewhere, not a shop.
  for (let seq = 2; existsSync(path.join(dir, name)) && seq < 100; seq += 1) {
    name = nameFor(now, seq);
  }

  const file = path.join(dir, name);
  // Quoted rather than bound: VACUUM INTO takes a literal, not a parameter.
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);

  prune(dir);
  return describe(dir, name);
}

/** Sortable: the second it was taken, then its place within that second. */
function order(name) {
  const [, stamp, seq] = STAMP.exec(name);
  return `${stamp}-${String(seq ? Number(seq) : 1).padStart(3, '0')}`;
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

/**
 * Newest first, so the one somebody wants is the one at the top.
 *
 * Sorted by the parsed name rather than by the string. Plain string order puts
 * `pos-…-2.sqlite` *before* `pos-….sqlite`, because a hyphen sorts below a dot
 * — so the second copy in a second would be listed as the older of the two, and
 * "restore the newest" would reach for the wrong one.
 */
export function listBackups() {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => STAMP.test(n))
    .sort((a, b) => order(b).localeCompare(order(a)))
    .map((n) => describe(dir, n));
}

/** Drop the oldest beyond `KEEP`, so a year of nightly copies is not a problem. */
function prune(dir, keep = KEEP) {
  const old = readdirSync(dir)
    .filter((n) => STAMP.test(n))
    // The same order as the list, for the same reason: pruning by string order
    // would drop the second copy in a second before an older one.
    .sort((a, b) => order(b).localeCompare(order(a)))
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

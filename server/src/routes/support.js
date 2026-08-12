import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { JWT_SECRET, requireAuth, requirePermission } from '../middleware/auth.js';
import { databasePath, stagedRestorePath } from '../db.js';
import { db } from '../db.js';
import { backupDir, listBackups, makeBackup } from '../lib/backups.js';
import { setPassword } from '../lib/passwords.js';
import { activeSession, endSession, redeem, supportUser, visits } from '../lib/support.js';

const router = Router();

/*
 * Guessing a ticket is not a plan — it is 32 random bytes with a five-minute
 * life — but an endpoint that answers an unlimited number of guesses for free
 * is still an endpoint worth pointing a script at. This makes it boring.
 */
const MAX_TRIES = 10;
const COOL_OFF_MS = 10 * 60 * 1000;
const tries = new Map();

export function forgetRedeemAttempts() {
  tries.clear();
}

function tooManyTries(ip) {
  const seen = tries.get(ip);
  if (!seen) return false;
  if (Date.now() - seen.first > COOL_OFF_MS) {
    tries.delete(ip);
    return false;
  }
  return seen.count >= MAX_TRIES;
}

function noteFailure(ip) {
  const seen = tries.get(ip);
  if (!seen || Date.now() - seen.first > COOL_OFF_MS) {
    tries.set(ip, { count: 1, first: Date.now() });
    return;
  }
  seen.count += 1;
}

/**
 * Come in, on a ticket the vendor's console wrote.
 *
 * Open, because whoever is redeeming has no account here yet — that is the
 * point of it. What stands in for a login is the ticket: minted by the console,
 * good for this shop only, good for five minutes, and good exactly once.
 *
 * The token is minted **here**, with this shop's own signing key. The console
 * never had that key and never will, so a console that was broken into cannot
 * forge a session — it can only write tickets, which this shop is free to stop
 * honouring by any means it likes.
 */
router.post('/redeem', (req, res) => {
  const ip = req.ip || 'unknown';
  if (tooManyTries(ip)) {
    return res.status(429).json({ error: 'Too many tries. Wait ten minutes.' });
  }

  const session = redeem(req.body?.token);
  if (!session) {
    noteFailure(ip);
    // One answer for expired, forged, for another shop, and already used.
    // Which of those it was is not information worth handing over.
    return res.status(401).json({ error: 'That link is not valid any more.' });
  }

  const user = supportUser();
  const payload = {
    id: user.id,
    username: user.username,
    name: `Support (${session.operator})`,
    role: 'admin',
    support: session.id,
  };

  res.json({
    token: jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' }),
    user: { ...payload, mustChangePassword: false },
    session: { operator: session.operator, reason: session.reason },
  });
});

/**
 * Is somebody in here right now?
 *
 * Asked by every signed-in screen so the shop can show the bar. Any signed-in
 * account may ask: a cashier at the counter has as much right to know that a
 * stranger is in the till as the owner does.
 */
router.get('/state', requireAuth, (req, res) => {
  const session = activeSession();
  res.json({
    support: session
      ? { active: true, operator: session.operator, reason: session.reason, since: session.started_at }
      : { active: false },
  });
});

/**
 * Leave, honestly, rather than by going quiet for twenty minutes.
 *
 * Ends the caller's own visit, read off their token — not whichever visit
 * happens to be the most recent. Two people from the vendor can be in at once,
 * and one of them leaving must not take the other's name off the bar.
 */
router.post('/end', requireAuth, (req, res) => {
  if (!req.user.support) return res.status(403).json({ error: 'Not a support session' });
  endSession(req.user.support);
  res.json({ ended: true });
});

/**
 * Who has been in, and what they did — the shop's copy.
 *
 * Behind `settings`, the permission the shop treats as "runs this place". Not
 * behind anything of the vendor's: a record the vendor could withhold is not
 * the record this is meant to be.
 */
router.get('/visits', requireAuth, requirePermission('settings'), (req, res) => {
  res.json({ visits: visits() });
});

/* ----------------------------------------------------- only for a visit */

/**
 * These three are the reason a visit exists at all, and none of them is
 * something a shop's own admin should be doing to themselves through this door.
 */
function requireSupport(req, res, next) {
  if (!req.user?.support) {
    return res.status(403).json({ error: 'Only a support session can do this' });
  }
  next();
}

/**
 * Give the owner a way back in.
 *
 * The password is generated here rather than chosen by the vendor, and it must
 * be changed on first use — so the vendor never knows the password the shop
 * ends up with, and a phone call reading it out loud is not a lasting key.
 */
router.post('/reset-password', requireAuth, requireSupport, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const user = db.prepare('SELECT id, username, name FROM users WHERE username = ?').get(username);
  if (!user) return res.status(404).json({ error: 'No such account' });

  // Readable over a phone line, and long enough that reading it over one is not
  // the weak part. No look-alike characters: a password given by voice and
  // typed wrong three times is a second phone call.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const password = Array.from(
    crypto.randomBytes(14),
    (byte) => alphabet[byte % alphabet.length],
  ).join('');

  setPassword(user.id, password);
  db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(user.id);

  res.json({ username: user.username, name: user.name, password });
});

/** A fresh copy of this shop, taken now. */
router.post('/backup', requireAuth, requireSupport, (req, res) => {
  try {
    res.status(201).json({ backup: makeBackup() });
  } catch (err) {
    res.status(500).json({ error: `Could not take a backup: ${err.message}` });
  }
});

/**
 * Put the shop back to one of its copies.
 *
 * Staged rather than done: the file being replaced is the one this process has
 * open, so the swap happens on the way back up, in db.js, before anything opens
 * anything. See there for why.
 *
 * A copy of where the shop is *now* is taken first, without asking. Somebody
 * restoring yesterday because of a bad import will occasionally find that
 * today's work mattered after all, and the moment to think of that is not after
 * it has gone.
 */
router.post('/restore', requireAuth, requireSupport, (req, res) => {
  const name = String(req.body?.name || '');
  const known = listBackups().find((b) => b.name === name);
  if (!known) return res.status(404).json({ error: 'No such backup' });

  let safety;
  try {
    safety = makeBackup();
    copyFileSync(path.join(backupDir(), name), stagedRestorePath);
  } catch (err) {
    return res.status(500).json({ error: `Could not stage the restore: ${err.message}` });
  }

  res.json({
    restoring: name,
    safetyCopy: safety.name,
    database: databasePath,
    message: 'The shop will restart in a moment and come back on that copy.',
  });

  /*
   * After the reply is on the wire, not before — a restart that beats its own
   * answer out of the door looks to the console exactly like a crash.
   *
   * systemd brings it straight back (Restart=always). Run by hand without a
   * service manager, this stops, which is the honest outcome: nothing else here
   * can restart a process.
   */
  setTimeout(() => process.exit(0), 250).unref?.();
});

export default router;

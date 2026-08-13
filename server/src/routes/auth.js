import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { JWT_SECRET, requireAuth } from '../middleware/auth.js';
import { effectivePermissions } from '../lib/permissions.js';
import {
  checkPassword,
  restorePasswordHash,
  setPassword,
  verifyPassword,
} from '../lib/passwords.js';

const router = Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const attempt = user ? verifyPassword(password, user.password_hash) : { ok: false };
  if (!user || !attempt.ok) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  /*
   * A hash written before passwords were normalised is quietly rewritten in the
   * settled form, now that somebody has proved they know the password.
   *
   * Without this the fallback in `verifyPassword` would be load-bearing for
   * ever. With it, each account repairs itself the next time its owner signs
   * in, and the fallback becomes what it should be — a bridge, not a feature.
   */
  if (attempt.stale) restorePasswordHash(user.id, password);

  /*
   * Permissions are deliberately not in the token. They travel with the reply
   * so the app knows what to show, but every route re-reads them: a permission
   * taken away at ten o'clock must not still work until the session expires.
   */
  const payload = { id: user.id, username: user.username, name: user.name, role: user.role };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
  res.json({
    token,
    user: {
      ...payload,
      permissions: effectivePermissions(user),
      // Sign-in is the safe moment to insist: no sale is in progress, and a
      // cashier is not halfway through a customer.
      mustChangePassword: Boolean(user.must_change_password),
      // So a machine this person has never used comes up at the size they read
      // at, rather than at the size the last person to touch it chose.
      textSize: user.text_size || null,
    },
  });
});

router.get('/me', requireAuth, (req, res) => {
  const account = db
    .prepare('SELECT must_change_password, text_size FROM users WHERE id = ?')
    .get(req.user.id);
  res.json({
    user: {
      ...req.user,
      permissions: effectivePermissions(req.user),
      mustChangePassword: Boolean(account?.must_change_password),
      textSize: account?.text_size || null,
    },
  });
});

/**
 * Remember how big this person likes the text.
 *
 * On the account rather than only in the browser: a shopkeeper signs in on the
 * counter tablet, the office laptop and their phone, and setting it again on
 * each is the kind of small friction that ends with nobody bothering.
 *
 * Anything unrecognised is stored as nothing rather than refused — the worst
 * this can do is show somebody the wrong size, and a 400 in the middle of a
 * settings screen over a display preference is a worse outcome than that.
 */
router.put('/text-size', requireAuth, (req, res) => {
  const wanted = String(req.body?.textSize || '');
  const size = ['default', 'medium', 'large'].includes(wanted) ? wanted : null;
  db.prepare('UPDATE users SET text_size = ? WHERE id = ?').run(size, req.user.id);
  res.json({ textSize: size });
});

/**
 * Change your own password.
 *
 * The current one is required even though you are already signed in, because
 * "signed in" on a shop's register means the screen somebody walked away from.
 * Without it, a minute alone at the counter is enough to take the owner's
 * account.
 */
router.post('/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'This account no longer exists' });

  if (!currentPassword || !verifyPassword(currentPassword, user.password_hash).ok) {
    return res.status(401).json({ error: 'That is not your current password' });
  }

  const problem = checkPassword(newPassword);
  if (problem) return res.status(400).json({ error: problem });

  if (verifyPassword(newPassword, user.password_hash).ok) {
    return res.status(400).json({ error: 'That is the password you already have' });
  }

  setPassword(user.id, newPassword);

  /*
   * A fresh token, or the change would sign you out of the screen you are
   * standing at — the middleware refuses tokens older than the password behind
   * them, and the one in this browser is now one of those.
   */
  const payload = { id: user.id, username: user.username, name: user.name, role: user.role };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
  res.json({
    token,
    user: { ...payload, permissions: effectivePermissions(user), mustChangePassword: false },
  });
});

export default router;

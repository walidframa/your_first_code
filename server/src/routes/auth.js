import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { JWT_SECRET, requireAuth } from '../middleware/auth.js';
import { effectivePermissions } from '../lib/permissions.js';
import { checkPassword, setPassword } from '../lib/passwords.js';

const router = Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

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
    },
  });
});

router.get('/me', requireAuth, (req, res) => {
  const account = db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(req.user.id);
  res.json({
    user: {
      ...req.user,
      permissions: effectivePermissions(req.user),
      mustChangePassword: Boolean(account?.must_change_password),
    },
  });
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

  if (!currentPassword || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'That is not your current password' });
  }

  const problem = checkPassword(newPassword);
  if (problem) return res.status(400).json({ error: problem });

  if (bcrypt.compareSync(newPassword, user.password_hash)) {
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

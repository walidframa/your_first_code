import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { JWT_SECRET, requireAuth } from '../middleware/auth.js';
import { effectivePermissions } from '../lib/permissions.js';

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
  res.json({ token, user: { ...payload, permissions: effectivePermissions(user) } });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { ...req.user, permissions: effectivePermissions(req.user) } });
});

export default router;

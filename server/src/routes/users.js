import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

function serializeUser(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, created_at: u.created_at };
}

router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at').all();
  res.json({ users: users.map(serializeUser) });
});

router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username || !password || !name || !['admin', 'cashier'].includes(role)) {
    return res.status(400).json({ error: 'username, password, name and a valid role are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  try {
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)'
    ).run(username, bcrypt.hashSync(password, 10), name, role);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ user: serializeUser(user) });
  } catch {
    res.status(409).json({ error: 'Username already exists' });
  }
});

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  } catch {
    return res.status(409).json({ error: 'Cannot delete a user with existing order history' });
  }
  res.json({ ok: true });
});

export default router;

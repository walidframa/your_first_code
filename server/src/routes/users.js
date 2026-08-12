import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { checkPassword, setPassword } from '../lib/passwords.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import {
  DEFAULT_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_GROUPS,
  effectivePermissions,
  permissionMap,
  setPermissions,
} from '../lib/permissions.js';

const router = Router();

function serializeUser(u, permissions) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    created_at: u.created_at,
    permissions: permissions ?? effectivePermissions(u),
  };
}

/*
 * The catalogue of what can be granted, sent to the client rather than
 * duplicated there: a permission added on the server has to appear on the form
 * that grants it, or it is a permission nobody can ever be given.
 */
router.get('/permissions', requireAuth, requirePermission('users'), (req, res) => {
  res.json({ groups: PERMISSION_GROUPS, permissions: PERMISSIONS, defaults: DEFAULT_PERMISSIONS });
});

router.get('/', requireAuth, requirePermission('users'), (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at').all();
  const granted = permissionMap();
  res.json({
    users: users.map((u) =>
      serializeUser(u, u.role === 'admin' ? [...PERMISSIONS] : granted.get(u.id) || []),
    ),
  });
});

router.post('/', requireAuth, requirePermission('users'), (req, res) => {
  const { username, password, name, role, permissions } = req.body || {};
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

    /*
     * A new account starts with the role's defaults unless the form said
     * otherwise — hiring somebody for the transfer desk should not mean
     * creating them and then remembering to come back and tick a box.
     */
    setPermissions(
      info.lastInsertRowid,
      role === 'admin' ? [] : (permissions ?? DEFAULT_PERMISSIONS[role] ?? []),
    );

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ user: serializeUser(user) });
  } catch {
    res.status(409).json({ error: 'Username already exists' });
  }
});

router.delete('/:id', requireAuth, requirePermission('users'), (req, res) => {
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

/**
 * Reset somebody else's password.
 *
 * No current password asked for, because the whole point is that the owner does
 * not have it — a cashier who has forgotten theirs, or one who has left and
 * whose session needs ending now. Setting it signs them out everywhere, which
 * is the half of "reset the password" that people assume already happens.
 */
router.put('/:id/password', requireAuth, requirePermission('users'), (req, res) => {
  /*
   * Your own goes through the other route, before anything is written here.
   *
   * This one hands back no token, so using it on yourself would sign this
   * browser out mid-click — the session it is holding predates the password it
   * just set. Changing your own asks for the current one and returns a fresh
   * token, which is the whole difference between the two.
   */
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({
      error: 'Use Settings to change your own password — it asks for your current one.',
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const problem = checkPassword(req.body?.password);
  if (problem) return res.status(400).json({ error: problem });

  setPassword(user.id, req.body.password);
  res.json({ ok: true });
});

/**
 * Set what one person may do.
 *
 * An admin's permissions are their role, so there is nothing here to change —
 * saying so is kinder than accepting a list that would be ignored.
 */
router.put('/:id/permissions', requireAuth, requirePermission('users'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'admin') {
    return res.status(400).json({ error: 'An admin already has every permission' });
  }
  if (!Array.isArray(req.body?.permissions)) {
    return res.status(400).json({ error: 'permissions must be a list' });
  }

  try {
    setPermissions(user.id, req.body.permissions);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ user: serializeUser(user) });
});

export default router;

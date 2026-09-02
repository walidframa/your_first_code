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
      // And in the light or the dark they set it to, for the same reason.
      theme: user.theme || null,
    },
  });
});

router.get('/me', requireAuth, (req, res) => {
  const account = db
    .prepare('SELECT must_change_password, text_size, theme, favourites FROM users WHERE id = ?')
    .get(req.user.id);
  res.json({
    user: {
      ...req.user,
      permissions: effectivePermissions(req.user),
      mustChangePassword: Boolean(account?.must_change_password),
      textSize: account?.text_size || null,
      theme: account?.theme || null,
      favourites: readFavourites(account?.favourites),
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
 * Light or dark, remembered against the person rather than the machine.
 *
 * Same reasoning as the text size above: a shopkeeper uses the counter tablet,
 * the office laptop and their phone, and setting a display preference again on
 * each one is how somebody stops bothering. The device still keeps its own
 * copy — that is what makes the screen right before the first paint — and this
 * is what makes it right on a machine they have never sat at.
 */
router.put('/theme', requireAuth, (req, res) => {
  const wanted = String(req.body?.theme || '');
  /* Kept in step with THEMES in client/src/lib/theme.js. A look missing from
     here is not rejected loudly — it is stored as null, so the choice appears
     to work on the machine that made it and is gone on the next one. */
  const theme = ['system', 'light', 'dark', 'ledger'].includes(wanted) ? wanted : null;
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, req.user.id);
  res.json({ theme });
});

/**
 * The screens somebody starred, kept at the top of the menu.
 *
 * A shop uses six of thirty screens all day and walks past the other
 * twenty-four every time. Starring is how they say which six, and this is where
 * that lives — on the account, so it follows them to the office laptop rather
 * than belonging to whichever machine they happened to set it on.
 *
 * Stored as the addresses themselves. The menu is a list of places, an address
 * is what a place is, and a screen renamed tomorrow keeps its star. Anything
 * that is not a path is dropped rather than refused: the worst this can do is
 * show somebody the wrong shortcuts, and a 400 in the middle of a menu over a
 * bookmark is a worse outcome than that.
 */
function readFavourites(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string' && p.startsWith('/')) : [];
  } catch {
    return [];
  }
}

router.put('/favourites', requireAuth, (req, res) => {
  const wanted = Array.isArray(req.body?.favourites) ? req.body.favourites : [];
  const favourites = [
    ...new Set(
      wanted
        .filter((p) => typeof p === 'string' && p.startsWith('/'))
        .map((p) => p.trim())
        .filter(Boolean)
        /* A menu is a shortcut list, not a second copy of the app. Past a
           couple of dozen it stops being either. */
        .slice(0, 24),
    ),
  ];

  db.prepare('UPDATE users SET favourites = ? WHERE id = ?').run(
    JSON.stringify(favourites),
    req.user.id,
  );
  res.json({ favourites });
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

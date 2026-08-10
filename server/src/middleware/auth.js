import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { can } from '../lib/permissions.js';
import { branchFor } from '../lib/branches.js';

const isProduction = process.env.NODE_ENV === 'production';

function resolveSecret() {
  const secret = process.env.JWT_SECRET;

  if (secret && secret.trim()) {
    if (secret.length < 32 && isProduction) {
      throw new Error('JWT_SECRET must be at least 32 characters in production.');
    }
    return secret;
  }

  if (isProduction) {
    throw new Error(
      'JWT_SECRET is not set. Refusing to start in production with an insecure signing key.\n' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    );
  }

  // Development only: a random per-process secret. Tokens do not survive a
  // restart, which is the intended nudge to set JWT_SECRET properly.
  const ephemeral = crypto.randomBytes(48).toString('hex');
  console.warn(
    '\x1b[33m[warn] JWT_SECRET is not set — using a random development secret.\x1b[0m\n' +
      '       Sessions will be invalidated on every restart. Set JWT_SECRET in server/.env.',
  );
  return ephemeral;
}

const JWT_SECRET = resolveSecret();

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }
  const token = header.slice('Bearer '.length);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  /*
   * Every authenticated request happens somewhere. Resolved here rather than
   * bolted onto each route, because a route that forgot would quietly read the
   * main branch's shelf while somebody stood at the other counter.
   */
  return resolveBranch(req, res, next);
}

/**
 * Guard a route by what someone is allowed to do rather than what they are
 * called. An admin passes everything; anyone else needs the grant.
 *
 * Read from the database on each request, not from the token: taking a
 * permission away has to take effect now, not whenever the session expires.
 */
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!can(req.user, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Which shop this request is about.
 *
 * Read on every request rather than carried in the token, for the same reason
 * permissions are: somebody moved to another branch has to be moved now, not
 * when their session happens to expire.
 *
 * A cashier is pinned to their own counter — being able to sell off the other
 * shop's shelf by changing a dropdown is how stock goes missing from a branch
 * nobody was standing in. Whoever holds `branches`, in practice the owner, may
 * look at any of them.
 */
export function resolveBranch(req, res, next) {
  if (!req.user) return next();

  const stored = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(req.user.id);
  const user = { ...req.user, branch_id: stored?.branch_id ?? null };

  const asked = req.get('X-Branch-Id') || req.query.branchId || null;
  req.branchId = branchFor(user, asked, { canSwitch: can(req.user, 'branches') });
  req.user.branch_id = user.branch_id;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

export { JWT_SECRET };

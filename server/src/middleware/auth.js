import crypto from 'crypto';
import jwt from 'jsonwebtoken';

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
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
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

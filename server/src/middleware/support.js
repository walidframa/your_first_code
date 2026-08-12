import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './auth.js';
import { record, touch } from '../lib/support.js';

/** Reads are not changes, and a log of everything drowns the part that matters. */
const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Write down what a support visit does, as it does it.
 *
 * This runs before the routes and reads the token itself rather than waiting
 * for `requireAuth`, for one reason: it has to see requests that the route then
 * **refuses**. A vendor who tried to delete something and was stopped is part
 * of the record a shopkeeper would want, and a log that only contained the
 * successes would be the vendor's account of the visit rather than the shop's.
 *
 * The line is written when the response finishes, so it carries what actually
 * happened rather than what was attempted.
 */
export function recordSupportWrites(req, res, next) {
  if (!CHANGES.has(req.method)) return next();

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();

  let session;
  try {
    session = jwt.verify(header.slice('Bearer '.length), JWT_SECRET).support;
  } catch {
    // Not a token this shop signed. Whatever it is, it is not a visit, and
    // failing to log it is not this middleware's problem to solve.
    return next();
  }
  if (!session) return next();

  /*
   * Read now, not in the handler below.
   *
   * By the time the response finishes, Express has rewritten `req.path` to
   * whatever is left after the router's own mount point — so a price change at
   * `/api/products/12` is recorded as `/12`, and the shopkeeper's log fills up
   * with numbers. `originalUrl` is the address as it arrived, and the query
   * string comes off it because a log is not the place for whatever was in it.
   */
  const path = req.originalUrl.split('?')[0];
  const method = req.method;

  /*
   * Ending a visit is the one write that must not extend it. Without this,
   * clicking "leave" marks the session finished and then immediately touches it
   * back to life, and the bar never comes down.
   */
  if (!path.startsWith('/api/support/end')) touch(session);

  res.on('finish', () => {
    try {
      record(session, { method, path, status: res.statusCode });
    } catch {
      // A shop must never lose a sale because the log of a support visit could
      // not be written. The visit is already visible on screen either way.
    }
  });

  next();
}

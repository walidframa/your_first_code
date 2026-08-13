import { isTenant, licenceForTenant } from '../lib/control.js';
import { MODULE_KEYS, moduleForPath, moduleName, parseModules } from '../lib/modules.js';
import { licenceMessage, licenceState } from '../lib/licence.js';

/**
 * A shop that has stopped paying stops selling — and keeps its books.
 *
 * The line is drawn at *trading*, not at access. Everything that takes money,
 * moves stock or changes a record is refused. Signing in still works, the
 * licence screen explains itself, and the owner can still take a copy of their
 * own data away with them.
 *
 * That last part is deliberate and is not generosity. A shop's sales history is
 * its accounting record — in most places, the thing a tax authority can demand
 * of it — and a vendor holding it behind an unpaid invoice has a problem of
 * their own rather than leverage. The pressure to pay is identical either way:
 * they cannot trade.
 */

/*
 * What still answers when the licence has run out.
 *
 * Prefixes, checked against the path. Deliberately short, and deliberately
 * containing nothing that writes to the shop's own records.
 */
const OPEN_WHEN_LOCKED = [
  '/api/health',
  '/api/licence',
  // Signing in, seeing who you are, and changing your password. Locking
  // somebody out of their own account as well would be a second punishment for
  // the same thing.
  '/api/auth',
  // Their data, on the way out. Making a fresh copy is a read of the shop's
  // database and a write of a file beside it — it changes nothing in the books.
  '/api/backups',
  /*
   * And the vendor's own way in. A stopped shop is the likeliest moment to need
   * it: the owner cannot sign in, or wants their data out, or has just paid and
   * something is wrong. Locking the vendor out of a shop the vendor locked
   * would leave nobody able to put it right.
   *
   * This opens the support routes only. Selling still goes through the routes
   * above this line, so a visit cannot ring up a sale on a stopped till.
   */
  '/api/support',
];

export function licenceStatus() {
  const row = licenceForTenant();

  /*
   * Told it is a tenant, but there is no row for it.
   *
   * Locked, not free. A missing row means the vendor removed this shop, or the
   * control database has been replaced by one that does not know about it —
   * and "we lost your record" must never be the cheapest way to get the app.
   */
  if (!row && isTenant()) {
    return { state: 'locked', reason: 'unknown_tenant', daysLeft: null, lockedOn: null };
  }

  return licenceState(row);
}

/**
 * What this shop bought, as a list the client can hide screens with.
 *
 * A copy that is nobody's tenant has everything — that is the vendor's own
 * shop, and anybody running this for themselves.
 */
export function enabledModules() {
  const row = licenceForTenant();
  if (!isTenant()) return [...MODULE_KEYS];
  return parseModules(row?.modules);
}

/**
 * Refuse what the shop has not paid for.
 *
 * A different axis from permissions, and the difference matters: permissions
 * decide whether *this cashier* may open the drawer, and the shop's own owner
 * passes all of them. This decides whether the shop has the transfer desk at
 * all, so the owner is refused too.
 *
 * 403 rather than 402: 402 means "your licence has run out, pay and it comes
 * back", and the client turns that into a lock screen. This is "you never
 * bought this", which is a different conversation and a different screen.
 */
export function enforceModules(req, res, next) {
  if (!isTenant()) return next();
  if (!req.path.startsWith('/api/')) return next();

  const needed = moduleForPath(req.path);
  if (!needed) return next();
  if (enabledModules().includes(needed)) return next();

  return res.status(403).json({
    error: `${moduleName(needed)} is not part of this shop's plan.`,
    module: needed,
  });
}

export function enforceLicence(req, res, next) {
  const status = licenceStatus();
  req.licence = status;

  if (status.state !== 'locked') return next();

  /*
   * The app itself is always served, licence or no licence.
   *
   * Only the API is withheld. This same handler sits in front of the built
   * client, so refusing everything would hand the shop a page of JSON where the
   * screen explaining the lock should be — and a shopkeeper staring at
   * `{"error":...}` has been given no way to pay, and no way to reach their own
   * records either.
   */
  if (!req.path.startsWith('/api/')) return next();

  if (OPEN_WHEN_LOCKED.some((prefix) => req.path.startsWith(prefix))) return next();

  /*
   * 402, which is the one status code that means exactly this and is otherwise
   * never used — so nothing in the app can mistake it for an ordinary failure
   * and retry it, the way it would a 500.
   */
  return res.status(402).json({
    error: licenceMessage(status),
    licence: status,
  });
}

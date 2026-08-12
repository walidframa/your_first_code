import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

/**
 * The vendor's book of who has paid, seen from inside a shop's own app.
 *
 * One database, kept outside every tenant, listing the shops and what each one
 * has paid for. A tenant's process opens it **read-only** and never writes to
 * it, which is the entire security model of the licence: a shop's owner has
 * full rights over every table in their own database, so an expiry date stored
 * there is an expiry date they can edit. This file is not theirs.
 *
 * A copy with no `CONTROL_DB` set has no licence at all and runs unrestricted —
 * that is the vendor's own shop, and anyone running this for themselves.
 */

export const controlPath = process.env.CONTROL_DB || null;
export const tenantSlug = process.env.TENANT_SLUG || null;

/**
 * Is this process somebody's rented copy?
 *
 * The distinction that matters, and it is not the same as "has a licence row".
 * A process told nothing about a control database is the vendor's own shop and
 * runs unrestricted. A process told it is tenant `rami` but finding no row for
 * `rami` is a tenant whose licence is *missing* — which has to lock, because
 * the obvious way for a row to go missing is the vendor deleting it, and a
 * deletion that handed out unlimited free service would be the exact opposite
 * of what was meant by it.
 */
export function isTenant() {
  return Boolean(controlPath && tenantSlug);
}

/**
 * The schema, kept here rather than in the console so that a tenant process can
 * be pointed at a control database and read it without the console being
 * installed anywhere near it.
 */
export function ensureControlSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      slug         TEXT UNIQUE NOT NULL,
      shop_name    TEXT NOT NULL,
      owner_name   TEXT,
      owner_phone  TEXT,
      plan         TEXT NOT NULL DEFAULT 'monthly',
      price        REAL NOT NULL DEFAULT 0,

      -- The last day covered. Null means nothing has been paid for yet, which
      -- locks rather than opens: a vendor who has not filled this in has not
      -- given anybody a licence.
      paid_through TEXT,

      -- Days past the deadline before selling stops. Per tenant, so one shop
      -- can be given longer without changing anybody else's terms.
      grace_days   INTEGER NOT NULL DEFAULT 10,

      -- The vendor's own switch, independent of the dates.
      suspended    INTEGER NOT NULL DEFAULT 0,

      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS payments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    INTEGER NOT NULL REFERENCES tenants(id),
      amount       REAL NOT NULL,
      periods      INTEGER NOT NULL DEFAULT 1,
      -- What the licence ran to before and after, so a disputed month can be
      -- reconstructed from the payments rather than from memory.
      was_paid_through  TEXT,
      now_paid_through  TEXT NOT NULL,
      note         TEXT,
      taken_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id, taken_at);
  `);
  return db;
}

let handle = null;

/**
 * The control database, read-only, opened once.
 *
 * Held open rather than reopened per request: the licence is checked on every
 * call the till makes, and a fresh file handle each time would be the most
 * expensive thing in a request that otherwise only reads a few rows.
 *
 * Missing file is treated as no licence rather than as an error. A tenant whose
 * control database has been moved should keep selling and let somebody notice,
 * rather than shutting a shop because of a path.
 */
export function controlDb() {
  if (handle !== null) return handle || null;
  if (!controlPath || !existsSync(controlPath)) {
    handle = false;
    return null;
  }
  try {
    handle = new DatabaseSync(controlPath, { readOnly: true });
  } catch {
    handle = false;
    return null;
  }
  return handle;
}

/**
 * This shop's licence row, or null when there is not one to have.
 *
 * Read fresh every time rather than cached. A vendor who takes a payment wants
 * the shop selling again on the customer's next tap, not at the end of some
 * cache window they cannot see — and the read is a primary-key lookup in a file
 * the operating system is already holding in memory.
 */
export function licenceForTenant(slug = tenantSlug) {
  const db = controlDb();
  if (!db || !slug) return null;
  try {
    return (
      db
        .prepare(
          `SELECT slug, shop_name, plan, paid_through, grace_days, suspended
             FROM tenants
            WHERE slug = ? AND removed_at IS NULL`,
        )
        .get(slug) || null
    );
  } catch {
    return null;
  }
}

/** For tests, which open and discard several of these in one process. */
export function resetControlHandle() {
  if (handle) handle.close();
  handle = null;
}

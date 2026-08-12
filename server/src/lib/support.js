import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { controlDb, tenantSlug } from './control.js';
import { findTicket } from './supportTickets.js';

/**
 * The vendor, inside a shop that is not theirs.
 *
 * Somebody has to be able to get in. A shopkeeper who has locked himself out,
 * a price that will not save, an import that went wrong on a Sunday — none of
 * those are fixable from a licence screen, and the alternative is the vendor
 * editing a live SQLite file over SSH with no record of what they touched.
 *
 * The rule here is not "ask permission". It is **leave a mark**. The shop is
 * told, on screen, for as long as the visit lasts; every write is written down
 * under the visitor's name; and the log is the shop's to read, not the
 * vendor's. That protects the vendor at least as much as the client — a
 * complaint that "you deleted my sales" is answerable with a list.
 */

/** After this long with nothing happening, the visit is over. */
export const IDLE_MINUTES = 20;

/** The reserved account a visit signs in as. */
export const SUPPORT_USERNAME = '__support';

export function ensureSupportSchema(database = db) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS support_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      -- The ticket this visit was let in on. Unique, which is what makes a
      -- ticket single-use: the shop records it here, so the second attempt to
      -- redeem the same one finds it already spent. Enforced by the shop rather
      -- than by the console, because the shop reads the book of shops
      -- read-only and cannot write "used" back into it.
      ticket      TEXT UNIQUE NOT NULL,
      operator    TEXT NOT NULL,
      reason      TEXT,
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS support_actions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL REFERENCES support_sessions(id),
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      status      INTEGER,
      at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_support_actions ON support_actions(session_id, at);
  `);
  return database;
}

/**
 * The account a visit acts as.
 *
 * A real row in the shop's own users table, not a special case threaded through
 * the auth middleware. Everything that already records who did something —
 * a sale, a stock adjustment, a price change — then names the visit without a
 * single one of those places having to learn what a visit is.
 *
 * Its password is random and thrown away, so it is not an account anybody can
 * sign into. The only way to be it is to redeem a ticket.
 */
export function supportUser() {
  const found = db.prepare('SELECT * FROM users WHERE username = ?').get(SUPPORT_USERNAME);
  if (found) return found;

  db.prepare(
    `INSERT INTO users (username, password_hash, name, role, must_change_password)
     VALUES (?, ?, ?, 'admin', 0)`,
  ).run(SUPPORT_USERNAME, bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10), 'Support');

  return db.prepare('SELECT * FROM users WHERE username = ?').get(SUPPORT_USERNAME);
}

/**
 * Turn a ticket into a visit, once.
 *
 * Returns null for anything wrong — expired, forged, for another shop, or
 * already used. The caller says "no" the same way to all of them, because
 * telling a stranger *which* of those it was is telling them how to get
 * closer.
 */
export function redeem(token, { slug = tenantSlug, now = new Date() } = {}) {
  const book = controlDb();
  if (!book || !slug) return null;

  const ticket = findTicket(book, { token, slug, now });
  if (!ticket) return null;

  const spent = db.prepare('SELECT 1 FROM support_sessions WHERE ticket = ?').get(ticket.ticket);
  if (spent) return null;

  const id = db
    .prepare('INSERT INTO support_sessions (ticket, operator, reason) VALUES (?, ?, ?) RETURNING id')
    .get(ticket.ticket, ticket.operator, ticket.reason || '').id;

  return { id, ticket: ticket.ticket, operator: ticket.operator, reason: ticket.reason || '' };
}

/**
 * The visit happening right now, if there is one.
 *
 * "Right now" is decided by the clock rather than by anybody remembering to
 * sign out. A vendor who closes the tab mid-visit must not leave a banner up in
 * somebody's shop for the rest of the week, and must not leave a session that
 * still counts as live either.
 */
export function activeSession({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - IDLE_MINUTES * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  return (
    db
      .prepare(
        `SELECT id, operator, reason, started_at, last_seen_at
           FROM support_sessions
          WHERE ended_at IS NULL AND last_seen_at > ?
       ORDER BY id DESC
          LIMIT 1`,
      )
      .get(cutoff) || null
  );
}

/** Still here. */
export function touch(id) {
  db.prepare(`UPDATE support_sessions SET last_seen_at = datetime('now') WHERE id = ?`).run(id);
}

/** Gone, deliberately — the honest end of a visit rather than the timed one. */
export function endSession(id) {
  db.prepare(
    `UPDATE support_sessions SET ended_at = datetime('now') WHERE id = ? AND ended_at IS NULL`,
  ).run(id);
}

/**
 * Write down something the visit did.
 *
 * Every write, at the door, rather than a line added to each route that
 * changes something. Twenty-odd route files would each have to remember, and
 * the one that forgot would be invisible — which is the failure that makes a
 * log worth less than no log, because it is trusted and incomplete.
 */
export function record(sessionId, { method, path, status }) {
  db.prepare(
    'INSERT INTO support_actions (session_id, method, path, status) VALUES (?, ?, ?, ?)',
  ).run(sessionId, method, path, status ?? null);
}

/**
 * Every visit, and what was done on it — the shop's copy.
 *
 * Read by the shop's own owner from their own settings screen. That is the
 * whole point of keeping it: a record the vendor cannot quietly be the only
 * holder of.
 */
export function visits({ limit = 20 } = {}) {
  const sessions = db
    .prepare(
      `SELECT id, operator, reason, started_at, last_seen_at, ended_at
         FROM support_sessions
     ORDER BY id DESC
        LIMIT ?`,
    )
    .all(limit);

  const actions = db.prepare(
    'SELECT method, path, status, at FROM support_actions WHERE session_id = ? ORDER BY id',
  );

  return sessions.map((session) => ({
    ...session,
    changes: actions.all(session.id),
  }));
}

/*
 * The tables, made on import rather than by the main schema file.
 *
 * Every other table in this app is created in db.js. These are not, because the
 * whole of support is meant to be liftable out of a copy that is nobody's
 * tenant — and because this file already depends on db.js, so putting the
 * schema the other way round would be a circle.
 */
ensureSupportSchema();

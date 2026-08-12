import bcrypt from 'bcryptjs';

/**
 * Who may look at the book of shops.
 *
 * A separate set of accounts from any shop's staff, in the control database, so
 * that a shop's own admin — who has every right inside their own till — has no
 * account here at all. There is no route from one to the other: different
 * database, different signing key, different address.
 *
 * This is the most dangerous login in the system. It can stop every shop at
 * once, so the rules around it are stricter than the ones for a cashier.
 */

export function ensureOperatorSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operators (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at  TEXT
    );
  `);
  return db;
}

const MIN_LENGTH = 12;

/**
 * Longer than a shop's staff need.
 *
 * Twelve rather than eight, because this one account is worth every shop on the
 * machine, and because there are only ever one or two of them — the cost of
 * a longer password falls on the person who benefits from it.
 */
export function checkOperatorPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    return `The console password must be at least ${MIN_LENGTH} characters`;
  }
  return null;
}

export function createOperator(db, username, password) {
  const problem = checkOperatorPassword(password);
  if (problem) throw new Error(problem);
  if (!/^[a-z0-9_.-]{2,40}$/i.test(String(username || ''))) {
    throw new Error('Username: letters, digits, dot, dash or underscore');
  }
  db.prepare('INSERT INTO operators (username, password_hash) VALUES (?, ?)').run(
    username,
    bcrypt.hashSync(password, 10),
  );
  return username;
}

export function setOperatorPassword(db, username, password) {
  const problem = checkOperatorPassword(password);
  if (problem) throw new Error(problem);
  const res = db
    .prepare('UPDATE operators SET password_hash = ? WHERE username = ?')
    .run(bcrypt.hashSync(password, 10), username);
  if (res.changes === 0) throw new Error(`No console user called "${username}"`);
}

/**
 * Check a password, in a way that takes the same time whether or not the
 * username exists.
 *
 * Without the dummy hash, a wrong username returns instantly and a wrong
 * password takes ~100ms — which tells anyone who is looking exactly which
 * usernames are real. That is the whole list of accounts that can stop every
 * shop on the machine.
 */
const DUMMY = bcrypt.hashSync('not-a-real-password', 10);

export function verifyOperator(db, username, password) {
  const found = db.prepare('SELECT * FROM operators WHERE username = ?').get(String(username || ''));
  const ok = bcrypt.compareSync(String(password || ''), found ? found.password_hash : DUMMY);
  return ok && found ? found : null;
}

export function touchOperator(db, id) {
  db.prepare(`UPDATE operators SET last_seen_at = datetime('now') WHERE id = ?`).run(id);
}

/**
 * How many wrong guesses before a name is put down for a while.
 *
 * In memory rather than in the database: a restart clearing it is fine, since
 * the point is to make guessing slow rather than to keep a record. Kept per
 * username *and* per address, so one attacker cannot lock the real operator out
 * by guessing at their name all day.
 */
const ATTEMPTS = new Map();
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 10 * 60 * 1000;

export function attemptKey(username, ip) {
  return `${String(username || '').toLowerCase()}@${ip || 'unknown'}`;
}

export function lockedFor(key, now = Date.now()) {
  const record = ATTEMPTS.get(key);
  if (!record || record.count < MAX_ATTEMPTS) return 0;
  const left = record.until - now;
  if (left <= 0) {
    ATTEMPTS.delete(key);
    return 0;
  }
  return left;
}

export function noteFailure(key, now = Date.now()) {
  const record = ATTEMPTS.get(key) || { count: 0, until: 0 };
  record.count += 1;
  record.until = now + LOCKOUT_MS;
  ATTEMPTS.set(key, record);
  return record.count;
}

export function noteSuccess(key) {
  ATTEMPTS.delete(key);
}

/** For tests, which need a clean slate between cases. */
export function forgetAttempts() {
  ATTEMPTS.clear();
}

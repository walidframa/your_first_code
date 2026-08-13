/**
 * A book of shops that was made before the column existed.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing at all once the table is there, so
 * every column added afterwards reaches new installations and no existing one.
 * This is not theoretical: the vendor's own console had been running for a day
 * when Features was pressed for the first time, and the save died on
 * `no such column: modules` — from a live page, with nothing on screen but
 * "That did not work".
 *
 * The tenant side reads these columns inside a try/catch and carries on without
 * them, so the shops never noticed. That made it quieter, not smaller.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureControlSchema } from '../src/lib/control.js';
import { MODULE_KEYS, parseModules, serialiseModules } from '../src/lib/modules.js';

/** The book of shops exactly as it was before modules were a thing. */
function yesterdaysControlDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tenants (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      slug         TEXT UNIQUE NOT NULL,
      shop_name    TEXT NOT NULL,
      owner_name   TEXT,
      owner_phone  TEXT,
      plan         TEXT NOT NULL DEFAULT 'monthly',
      price        REAL NOT NULL DEFAULT 0,
      port         INTEGER UNIQUE,
      paid_through TEXT,
      grace_days   INTEGER NOT NULL DEFAULT 10,
      suspended    INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at   TEXT
    );
  `);
  db.prepare(`INSERT INTO tenants (slug, shop_name) VALUES ('rami', 'Rami Mobile')`).run();
  return db;
}

const columns = (db) =>
  db
    .prepare('PRAGMA table_info(tenants)')
    .all()
    .map((c) => c.name);

test('an existing book of shops gains the column it is missing', () => {
  const db = yesterdaysControlDb();
  assert.ok(!columns(db).includes('modules'), 'the fixture is not actually the old shape');

  ensureControlSchema(db);
  assert.ok(columns(db).includes('modules'));
});

test('and the shops in it can then be sold features', () => {
  // The write that failed on the live console, start to finish.
  const db = ensureControlSchema(yesterdaysControlDb());

  db.prepare('UPDATE tenants SET modules = ? WHERE slug = ?').run(
    serialiseModules(['repairs', 'sims']),
    'rami',
  );

  const row = db.prepare('SELECT modules FROM tenants WHERE slug = ?').get('rami');
  assert.deepEqual(parseModules(row.modules), ['repairs', 'sims']);
});

test('a shop that was already there keeps everything until it is told otherwise', () => {
  // The column arrives NULL, which reads as the whole app — which is what that
  // shop was sold, and what it has been using.
  const db = ensureControlSchema(yesterdaysControlDb());
  const row = db.prepare('SELECT modules FROM tenants WHERE slug = ?').get('rami');
  assert.equal(row.modules, null);
  assert.deepEqual(parseModules(row.modules), MODULE_KEYS);
});

test('running it again over an up-to-date book changes nothing', () => {
  // It runs on every console start and on every `pos-tenant` command, so it has
  // to be safe to run a hundred times.
  const db = ensureControlSchema(yesterdaysControlDb());
  const first = columns(db);

  ensureControlSchema(db);
  ensureControlSchema(db);

  assert.deepEqual(columns(db), first);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n, 1);
});

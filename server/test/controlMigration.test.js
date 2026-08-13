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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControlSchema, missingColumns } from '../src/lib/control.js';
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

test('and the console can say which columns are missing before anyone presses Save', () => {
  // The question that could not be answered from a browser: is this console
  // running old code, or new code against a database that never caught up?
  const db = yesterdaysControlDb();
  assert.deepEqual(missingColumns(db), ['modules']);

  ensureControlSchema(db);
  assert.deepEqual(missingColumns(db), []);
});

test('asking a database with no tenants table at all is not an error', () => {
  // A control file that was never set up. The console still has to render.
  const db = new DatabaseSync(':memory:');
  assert.deepEqual(missingColumns(db), ['modules']);
});

test('a book it cannot write to does not stop the console starting', () => {
  /*
   * The realistic failure is ownership: `pos-tenant` runs as root and makes
   * these files, the console runs as `pos`. Before the migration existed that
   * was a button that did not work. It must not become a console that will not
   * boot — that is the same problem, made worse, at the moment somebody is
   * trying to fix it.
   */
  const file = join(mkdtempSync(join(tmpdir(), 'control-')), 'control.sqlite');
  ensureControlSchema(new DatabaseSync(file)).close();

  // Take the column back out, then reopen with no way to put it back.
  const strip = new DatabaseSync(file);
  strip.exec('ALTER TABLE tenants DROP COLUMN modules');
  strip.close();

  const readOnly = new DatabaseSync(file, { readOnly: true });
  assert.doesNotThrow(() => ensureControlSchema(readOnly));
  // And it reports the gap rather than pretending the column is there.
  assert.deepEqual(missingColumns(readOnly), ['modules']);
  readOnly.close();
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

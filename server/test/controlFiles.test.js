/**
 * Who owns the book of shops.
 *
 * `pos-tenant` runs as root and creates the control database. The console runs
 * as `pos` and has to write payments into it. If the hand-over misses a file,
 * the first payment taken on the web console dies with "attempt to write a
 * readonly database" — which is the same failure that crash-looped the tills
 * the first time a shop was set up, arriving by a different door.
 *
 * The chown itself needs root and cannot be run here. What can be checked is
 * the list it is given: a database is more than its .sqlite, and forgetting the
 * journal beside it is the quiet half of the same bug.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { databaseFiles, ensureControlSchema } from '../src/lib/control.js';

const inTmp = (run) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pos-files-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('a real database is listed', () => {
  inTmp((dir) => {
    const file = path.join(dir, 'control.sqlite');
    const db = ensureControlSchema(new DatabaseSync(file));
    db.close();
    assert.deepEqual(databaseFiles(file), [file]);
  });
});

test('the journal beside it is listed too', () => {
  inTmp((dir) => {
    const file = path.join(dir, 'control.sqlite');
    // Both spellings: the control database uses a rollback journal, a tenant's
    // uses WAL, and this list has to hand over either.
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      writeFileSync(`${file}${suffix}`, '');
    }
    assert.deepEqual(databaseFiles(file), [
      file,
      `${file}-journal`,
      `${file}-wal`,
      `${file}-shm`,
    ]);
  });
});

test('a file that is not there is not listed', () => {
  inTmp((dir) => {
    // chown refuses the whole call when one name in it does not exist, so a
    // list padded with sidecars that were never written would hand over
    // nothing at all — the failure this exists to prevent.
    const file = path.join(dir, 'control.sqlite');
    assert.deepEqual(databaseFiles(file), []);

    writeFileSync(file, '');
    assert.deepEqual(databaseFiles(file), [file]);
  });
});

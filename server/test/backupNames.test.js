/**
 * Two copies taken in the same second.
 *
 * This looks like a corner until you see where it happens: a restore takes a
 * safety copy of where the shop is *now*, immediately before replacing it. If
 * somebody takes a copy, looks at it, and decides to roll back, both happen
 * inside one second — and the old behaviour handed back the copy that already
 * existed rather than taking a new one. The "safety copy" was then the state
 * being restored *to*, and the work being undone was saved nowhere.
 *
 * Each file in this suite gets its own process, so pointing the database
 * somewhere disposable before importing it is safe here and nowhere else.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workDir = mkdtempSync(path.join(tmpdir(), 'pos-backup-names-'));
process.env.DB_PATH = path.join(workDir, 'shop.sqlite');
process.env.BACKUP_DIR = path.join(workDir, 'backups');

const { listBackups, makeBackup } = await import('../src/lib/backups.js');

before(() => {
  // Something in it, so a copy is a copy of something.
  process.env.NODE_ENV = 'test';
});

after(() => rmSync(workDir, { recursive: true, force: true }));

test('two copies in one second are two copies, not one', () => {
  const first = makeBackup();
  const second = makeBackup();
  const third = makeBackup();

  assert.notEqual(second.name, first.name, 'the second copy was silently the first one');
  assert.notEqual(third.name, second.name);
  assert.equal(new Set([first.name, second.name, third.name]).size, 3);
});

test('the newest of them is listed as the newest', () => {
  // Plain string order puts `pos-…-2.sqlite` before `pos-….sqlite`, because a
  // hyphen sorts below a dot. Listed that way, "restore the newest" reaches for
  // the oldest of the three.
  const newest = makeBackup();
  assert.equal(listBackups()[0].name, newest.name);
});

test('every copy still says when it was taken', () => {
  // The suffix must not break the date read back off the name — the list shows
  // it, and it is what the nightly backup uses to decide one is due.
  for (const backup of listBackups()) {
    assert.match(backup.takenAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, backup.name);
    assert.ok(backup.bytes > 0);
  }
});

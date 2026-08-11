/**
 * Put a backup back.
 *
 * Deliberately a command rather than a button. Restoring throws away everything
 * that has happened since the copy was taken, and it has to happen with the
 * server stopped — a database swapped underneath a running process is a
 * database with half of one shop's day and half of another's. Neither of those
 * belongs behind something clickable at a counter.
 *
 *   npm run restore -- <file>
 *
 * The database being replaced is copied aside first, under `.replaced-<time>`,
 * because the commonest restore mistake is restoring the wrong copy — and the
 * only thing worse than losing today is losing today and having no way back.
 */
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const source = process.argv[2];
const target = process.env.DB_PATH || path.join(import.meta.dirname, '..', 'data.sqlite');

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!source) {
  die('Say which backup to restore:  npm run restore -- backups/pos-2026-08-11T20-14-03.sqlite');
}
if (!existsSync(source)) die(`There is no file at ${source}`);

/*
 * Opened and read before anything is moved. A truncated download or a file that
 * is not a database at all should fail here, with the shop's real books still
 * exactly where they were.
 */
try {
  const check = new DatabaseSync(source, { readOnly: true });
  const { n } = check.prepare('SELECT COUNT(*) AS n FROM orders').get();
  check.close();
  console.log(`  ${source}\n  looks like a shop with ${n} sale${n === 1 ? '' : 's'} in it.`);
} catch (err) {
  die(`That file is not a usable backup: ${err.message}`);
}

if (existsSync(target)) {
  const aside = `${target}.replaced-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}`;
  renameSync(target, aside);
  console.log(`  The database that was there is kept at\n  ${aside}`);
}

/*
 * The write-ahead log and its index belong to the database that has just been
 * moved aside. Left behind, SQLite would try to replay them onto the restored
 * file and refuse to open it.
 */
for (const suffix of ['-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true });

copyFileSync(source, target);
console.log(`\n  Restored to ${target}.\n  Start the server and check the day's takings before trusting it.\n`);

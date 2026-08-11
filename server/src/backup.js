/**
 * Take a backup from the command line.
 *
 *   npm run backup
 *
 * The same copy the server takes nightly, for a shop that would rather run it
 * from a scheduled task, or that wants one in their hand before doing something
 * they are not sure about — an import, a bulk price change, an upgrade.
 */
import { makeBackup, backupDir } from './lib/backups.js';

const backup = makeBackup();
console.log(`\n  ${backup.name}  (${(backup.bytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  in ${backupDir()}`);
console.log(
  '\n  Copy it somewhere that is not this machine — and keep server/.env with it,\n' +
    '  or the customer passwords and repair passcodes inside cannot be read back.\n',
);

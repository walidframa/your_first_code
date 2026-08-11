/**
 * Give the shop a signing key of its own, once.
 *
 * Without `server/.env` the server invents a random key at boot, and every
 * restart therefore invalidates every session — which in development means
 * being thrown back to the login screen with "Invalid or expired token" on top
 * of whatever you were typing, several times an afternoon.
 *
 * The two keys are deliberately separate. JWT_SECRET is rotated when a session
 * leaks; ACCOUNT_SECRET must not be, because rotating it makes every customer
 * password the shop is holding unreadable. Sharing one would mean rotating
 * either one destroys the other's work.
 *
 * Never overwrites an existing file: on a real installation that file is the
 * thing standing between a restart and a shop full of unreadable passwords.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(repoRoot, 'server', '.env');

const key = () => randomBytes(48).toString('hex');

if (!existsSync(envPath)) {
  writeFileSync(
    envPath,
    [
      '# Written once by `npm run setup`. Keep it — and back it up.',
      '#',
      '# JWT_SECRET signs the login tokens. Change it and everybody is logged out,',
      '# which is what you want after a laptop goes missing.',
      `JWT_SECRET=${key()}`,
      '',
      '# ACCOUNT_SECRET encrypts the iCloud and email passwords the shop keeps on a',
      '# customer’s behalf, and the passcodes left with a repair. Change it and every',
      '# one of them becomes unreadable, permanently. Back it up somewhere that is',
      '# not this machine: a database restored without it has those gone for good.',
      `ACCOUNT_SECRET=${key()}`,
      '',
    ].join('\n'),
  );
  console.log('Created server/.env with a signing key — your sessions will now survive a restart.');
} else {
  /*
   * A file that exists but is missing a key is the same failure with an extra
   * step: the server still falls back to a per-boot secret. Fill the gap rather
   * than touching anything already set.
   */
  const current = readFileSync(envPath, 'utf8');
  const missing = ['JWT_SECRET', 'ACCOUNT_SECRET'].filter(
    (name) => !new RegExp(`^${name}=.+`, 'm').test(current),
  );

  if (missing.length > 0) {
    writeFileSync(
      envPath,
      `${current.trimEnd()}\n\n${missing.map((name) => `${name}=${key()}`).join('\n')}\n`,
    );
    console.log(`Added ${missing.join(' and ')} to server/.env.`);
  }
}

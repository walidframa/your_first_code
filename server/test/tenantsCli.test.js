/**
 * The vendor's command, run for real.
 *
 * The parts that need root — systemd, nginx, certbot — are pointed at a
 * temporary directory and their commands are left to fail harmlessly, so what
 * this actually exercises is the half that decides things: names, ports,
 * dates, and what each subcommand does to the book. That half is the one that
 * can quietly charge somebody twice or hand out a name that is already taken.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { addDays, today } from '../src/lib/licence.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(serverRoot, 'src', 'tenants.js');

let workDir;

/** Run pos-tenant with everything pointed somewhere disposable. */
function pos(...argv) {
  const res = spawnSync(process.execPath, [cli, ...argv], {
    encoding: 'utf8',
    env: {
      ...process.env,
      POS_DOMAIN: 'xtechpos.com',
      CONTROL_DB: path.join(workDir, 'control.sqlite'),
      POS_TENANT_DATA: path.join(workDir, 'tenants'),
      POS_ENV_DIR: path.join(workDir, 'env'),
      POS_NGINX_DIR: path.join(workDir, 'nginx'),
      POS_NGINX_ENABLED: path.join(workDir, 'nginx-enabled'),
      POS_CERT_EMAIL: '',
      // The child seeds a database of its own; keep it off this one.
      DB_PATH: path.join(workDir, 'unused.sqlite'),
    },
  });
  return { ...res, out: `${res.stdout}${res.stderr}` };
}

const book = () => new DatabaseSync(path.join(workDir, 'control.sqlite'));
const row = (slug) => {
  const db = book();
  const found = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  db.close();
  return found;
};

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-cli-'));
});
after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* --------------------------------------------------------------- listing */

test('with nothing in it, it says so rather than showing an empty table', () => {
  assert.match(pos('list').out, /No shops yet/);
});

/* ------------------------------------------------------------- dry runs */

test('a dry run writes nothing at all', () => {
  const res = pos('add', 'rami', 'Rami Mobile', '--dry-run');
  assert.match(res.out, /would write/);
  assert.match(res.out, /rami\.xtechpos\.com/);
  assert.ok(!existsSync(path.join(workDir, 'env', 'rami.env')), 'a dry run created a file');
  assert.equal(row('rami'), undefined, 'a dry run wrote to the book');
});

test('a real shop is set up as a shop, not as the demo', () => {
  // Without `--starter` a paying client opens their new till and finds sixteen
  // coffees and a Bakery shelf, and has to delete all of it before a single
  // figure on the screen means anything.
  const res = pos('add', 'rami', 'Rami Mobile', '--dry-run');
  assert.match(res.out, /seed\.js --starter/, 'the new shop would be seeded with demo stock');
});

test('a dry run shows the database the seed would go into', () => {
  // Getting this wrong seeds a new client into somebody else's shop, and the
  // seed is quiet about it because it skips whatever is already there.
  const res = pos('add', 'rami', 'Rami Mobile', '--dry-run');
  assert.match(res.out, /DB_PATH=.*tenants\/rami\.sqlite.*seed\.js/);
});

/* ----------------------------------------------------------- adding one */

test('adding a shop records it, with its own port and a trial', () => {
  const res = pos('add', 'rami', 'Rami Mobile', '--plan', 'monthly', '--price', '25', '--trial', '14');
  assert.match(res.out, /Rami Mobile is set up/);

  const tenant = row('rami');
  assert.equal(tenant.shop_name, 'Rami Mobile');
  assert.equal(tenant.plan, 'monthly');
  assert.equal(tenant.price, 25);
  assert.equal(tenant.port, 4100, 'the first shop takes the base port');
  assert.equal(tenant.paid_through, addDays(today(), 14));
  assert.equal(tenant.suspended, 0);
});

test('its settings file names that shop and nothing else', () => {
  const env = path.join(workDir, 'env', 'rami.env');
  assert.ok(existsSync(env));
  const text = readFileSync(env, 'utf8');
  assert.match(text, /^TENANT_SLUG=rami$/m);
  assert.match(text, /^PORT=4100$/m);
  assert.match(text, /^JWT_SECRET=[0-9a-f]{96}$/m);
  assert.match(text, /^ACCOUNT_SECRET=[0-9a-f]{96}$/m);
});

test('a second shop gets the next port, and its own keys', () => {
  pos('add', 'nabil', 'Nabil Phones');
  assert.equal(row('nabil').port, 4101);

  const read = (slug) => readFileSync(path.join(workDir, 'env', `${slug}.env`), 'utf8');
  const secret = (text, key) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))[1];

  // One shop's token being accepted by another is the whole game.
  assert.notEqual(secret(read('rami'), 'JWT_SECRET'), secret(read('nabil'), 'JWT_SECRET'));
  assert.notEqual(secret(read('rami'), 'ACCOUNT_SECRET'), secret(read('nabil'), 'ACCOUNT_SECRET'));
});

test('the same name twice is refused rather than overwriting a live shop', () => {
  const res = pos('add', 'rami', 'Someone Else');
  assert.notEqual(res.status, 0);
  assert.match(res.out, /already exists/);
  assert.equal(row('rami').shop_name, 'Rami Mobile', 'the first shop was overwritten');
});

test('a reserved name is refused before anything is written', () => {
  const res = pos('add', 'admin', 'Sneaky');
  assert.notEqual(res.status, 0);
  assert.match(res.out, /reserved/);
  assert.ok(!existsSync(path.join(workDir, 'env', 'admin.env')));
});

/* -------------------------------------------------------------- payments */

test('paying extends from the day already paid for', () => {
  const before = row('rami').paid_through;
  pos('pay', 'rami', '--periods', '1', '--amount', '25');
  const after = row('rami').paid_through;

  // A month on from the day already covered, not from today: paying a week
  // late must not quietly buy a week less.
  const expected = new Date(`${before}T00:00:00Z`);
  expected.setUTCMonth(expected.getUTCMonth() + 1);
  assert.equal(after, expected.toISOString().slice(0, 10));
});

test('a payment is written down, with both dates', () => {
  const db = book();
  const paid = db.prepare('SELECT * FROM payments ORDER BY id DESC LIMIT 1').get();
  db.close();
  assert.equal(paid.amount, 25);
  assert.equal(paid.periods, 1);
  assert.ok(paid.was_paid_through);
  assert.ok(paid.now_paid_through > paid.was_paid_through, 'a disputed month can be reconstructed');
});

test('a shop returning after a long lapse starts again from today', () => {
  // Extending from a date six months gone would sell them a month that has
  // already been and gone.
  const db = book();
  db.prepare(`UPDATE tenants SET paid_through = ? WHERE slug = 'nabil'`).run(addDays(today(), -200));
  db.close();

  pos('pay', 'nabil');
  const after = row('nabil').paid_through;
  assert.ok(after > today(), `a lapsed shop got ${after}`);
});

/* --------------------------------------------------- suspend and restore */

test('suspending and resuming flips one switch', () => {
  pos('suspend', 'rami');
  assert.equal(row('rami').suspended, 1);
  pos('resume', 'rami');
  assert.equal(row('rami').suspended, 0);
});

test('paying an overdue shop takes it off suspension too', () => {
  // Otherwise a vendor takes the money and the till stays dark, which is the
  // worst possible minute to be looking for a second command.
  pos('suspend', 'rami');
  pos('pay', 'rami');
  assert.equal(row('rami').suspended, 0);
});

/* ------------------------------------------------- removing, and purging */

test('removing a shop keeps every byte of it', () => {
  pos('remove', 'nabil');
  assert.ok(row('nabil').removed_at, 'not marked as removed');
  assert.ok(
    existsSync(path.join(workDir, 'tenants', 'nabil.sqlite')),
    'removing a shop deleted their books',
  );
});

test('a removed shop still shows in the list, as removed', () => {
  const out = pos('list').out;
  assert.match(out, /nabil\s+removed/);
});

test('purging refuses without being told twice', () => {
  const res = pos('purge', 'nabil');
  assert.notEqual(res.status, 0);
  assert.match(res.out, /--yes/);
  assert.ok(existsSync(path.join(workDir, 'tenants', 'nabil.sqlite')));
});

test('purging refuses a shop that is still on the air', () => {
  const res = pos('purge', 'rami', '--yes');
  assert.notEqual(res.status, 0);
  assert.match(res.out, /Stop it first/);
  assert.ok(existsSync(path.join(workDir, 'tenants', 'rami.sqlite')));
});

test('purging deletes the data and forgets who they were', () => {
  pos('purge', 'nabil', '--yes');
  assert.ok(!existsSync(path.join(workDir, 'tenants', 'nabil.sqlite')));
  assert.ok(!existsSync(path.join(workDir, 'env', 'nabil.env')));

  // The row survives without anything identifying in it: the payments against
  // it are the vendor's own accounts.
  const gone = row('nabil');
  assert.match(gone.shop_name, /deleted/);
  assert.equal(gone.owner_name, null);
});

test('the shop that was not purged is untouched', () => {
  assert.ok(existsSync(path.join(workDir, 'tenants', 'rami.sqlite')));
  assert.equal(row('rami').shop_name, 'Rami Mobile');
});

/* ------------------------------------------------------------- the usage */

test('an unknown command explains itself rather than guessing', () => {
  const res = pos('destroy-everything');
  assert.notEqual(res.status, 0);
  assert.match(res.out, /pos-tenant/);
});

test('a step that cannot finish is reported, not fatal', () => {
  /*
   * systemd and nginx are not available here, so every `add` above has been
   * exercising this path — which is the point. By the time those run, the shop
   * has a seeded database, its own keys and a licence. Dying at that point
   * would leave all of it in place with no service running, no word about what
   * to finish, and a name the vendor can no longer re-add.
   */
  const res = pos('add', 'later', 'Finish By Hand');
  assert.match(res.out, /Finish By Hand is set up/);
  assert.match(res.out, /Some steps did not finish/);
  assert.match(res.out, /systemctl enable --now pos-tenant@later/);
  assert.ok(row('later'), 'the shop was still recorded');
});

/* ---------------------------------------------------- reading its settings */

test('it reads /etc/pos.env itself rather than needing a sourced shell', () => {
  /*
   * `set -a; . /etc/pos.env` lasts exactly as long as one terminal. Tomorrow,
   * or from another computer, POS_CERT_EMAIL is empty again — and `add` then
   * sets a shop up with no certificate and mentions it in one grey line among
   * thirty. Silence is the whole danger here, so it is pinned.
   */
  const settings = path.join(workDir, 'pos.env');
  writeFileSync(
    settings,
    [
      '# a comment, and a blank line follow',
      '',
      'POS_DOMAIN=fromfile.example',
      'POS_CERT_EMAIL = spaced@example.com ',
      // The vendor's own shop's keys live in this file too, and this command
      // has no business with them.
      'JWT_SECRET=must-not-be-read',
      'NOT_OURS=ignored',
    ].join('\n'),
  );

  const res = spawnSync(process.execPath, [cli, 'add', 'fromfile', 'From File', '--dry-run'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      POS_ENV_FILE: settings,
      CONTROL_DB: path.join(workDir, 'control.sqlite'),
      POS_TENANT_DATA: path.join(workDir, 'tenants'),
      POS_ENV_DIR: path.join(workDir, 'env'),
      POS_NGINX_DIR: path.join(workDir, 'nginx'),
      POS_NGINX_ENABLED: path.join(workDir, 'nginx-enabled'),
      DB_PATH: path.join(workDir, 'unused.sqlite'),
      // Deliberately absent, so the file is the only place they could come from.
      POS_DOMAIN: undefined,
      POS_CERT_EMAIL: undefined,
    },
  });
  const out = `${res.stdout}${res.stderr}`;

  assert.match(out, /fromfile\.fromfile\.example/, 'the domain came from the file');
  assert.match(out, /certbot .*-m spaced@example\.com/, 'the email came from the file, trimmed');

  /*
   * The two flags that decide whether a shop is actually reachable over HTTPS.
   *
   * Without --redirect, certbot issues the certificate and leaves port 80
   * serving the same pages unencrypted. Without --reinstall, a name that
   * already has a certificate — a slug used twice, a re-run after something
   * else failed — takes a shortcut: certbot finds one that is not due for
   * renewal, writes no config, and reports success, so --redirect is skipped
   * too. Both failures look like a shop that works, until somebody notices the
   * address bar.
   */
  assert.match(out, /certbot .*--redirect/, 'port 80 is a redirect, not a second front door');
  assert.match(out, /certbot .*--reinstall/, 'and a name that already has a certificate is not skipped');
  assert.ok(!out.includes('must-not-be-read'), 'it read keys that are none of its business');
});

test('what is already in the environment beats the file', () => {
  // So that `CONTROL_DB=... pos-tenant …` still works, and so the tests above
  // are not quietly reading a real /etc/pos.env on whatever machine they run on.
  const settings = path.join(workDir, 'pos.env');
  const res = spawnSync(process.execPath, [cli, 'add', 'override', 'Override', '--dry-run'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      POS_ENV_FILE: settings,
      POS_DOMAIN: 'fromenv.example',
      CONTROL_DB: path.join(workDir, 'control.sqlite'),
      POS_TENANT_DATA: path.join(workDir, 'tenants'),
      POS_ENV_DIR: path.join(workDir, 'env'),
      POS_NGINX_DIR: path.join(workDir, 'nginx'),
      POS_NGINX_ENABLED: path.join(workDir, 'nginx-enabled'),
      DB_PATH: path.join(workDir, 'unused.sqlite'),
    },
  });
  assert.match(`${res.stdout}${res.stderr}`, /override\.fromenv\.example/);
});

/* --------------------------------------------------------- who owns it all */

test('it hands the shop over to the user that will run it', () => {
  /*
   * This command is run by root, so everything it creates belongs to root —
   * while the service runs as `pos`. SQLite cannot write a database it does not
   * own, so the shop starts, fails, and is restarted by systemd for ever:
   * `activating (auto-restart)`, nothing listening on the port, and a status
   * line that says nothing whatsoever about permissions.
   *
   * Caught on a real server. The dry run is the only place the ownership step
   * can be checked from here, since this container has no `pos` user.
   */
  const res = pos('add', 'owned', 'Owned Properly', '--dry-run');
  assert.match(res.out, /chown -R pos:pos .*tenants/, 'the databases and backups');
  assert.match(res.out, /chown pos:pos .*owned\.env/, 'and the settings file');
});

test('a chown that cannot run is reported rather than swallowed', () => {
  // There is no `pos` user here, so this is the failure path — which must leave
  // the shop recorded and tell the vendor the exact command to finish.
  const res = pos('add', 'nouser', 'No Such User');
  assert.match(res.out, /Some steps did not finish/);
  assert.match(res.out, /chown/);
  assert.ok(row('nouser'), 'the shop was still recorded');
});

/* --------------------------------------------------------------- renaming */

/**
 * A shop that changes its address.
 *
 * The slug is six things at once — the subdomain, the database file, the
 * backups beside it, the settings file, the nginx block and the systemd
 * instance — so the thing worth testing is that they all move together and that
 * nothing is quietly regenerated on the way.
 */
test('rename moves the shop, its data and its address', () => {
  pos('add', 'oldname', 'Old Name Mobile', '--price', '30');

  const envFile = path.join(workDir, 'env', 'oldname.env');
  const before = readFileSync(envFile, 'utf8');
  const secret = before.match(/^ACCOUNT_SECRET=(.+)$/m)[1];
  const jwt = before.match(/^JWT_SECRET=(.+)$/m)[1];
  const port = row('oldname').port;

  // Something in the database, so "the data came too" is a real claim.
  const shopDb = new DatabaseSync(path.join(workDir, 'tenants', 'oldname.sqlite'));
  const marker = shopDb.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  shopDb.close();
  assert.ok(marker > 0, 'the fixture shop has no users, so nothing would prove it moved');

  const res = pos('rename', 'oldname', 'protech');
  assert.equal(res.status, 0, res.out);

  // The book answers to the new name and has forgotten the old one.
  assert.equal(row('oldname'), undefined);
  assert.equal(row('protech').shop_name, 'Old Name Mobile');
  assert.equal(row('protech').port, port, 'it kept its port, so nothing else has to move');
  assert.equal(row('protech').price, 30, 'and its terms');

  // The database moved rather than being made again.
  assert.ok(!existsSync(path.join(workDir, 'tenants', 'oldname.sqlite')));
  const moved = new DatabaseSync(path.join(workDir, 'tenants', 'protech.sqlite'));
  assert.equal(moved.prepare('SELECT COUNT(*) AS n FROM users').get().n, marker);
  moved.close();

  /*
   * The secrets are the same ones.
   *
   * This is the assertion worth having. ACCOUNT_SECRET encrypts every customer
   * password and repair passcode the shop holds — a rename that re-rolled it
   * would destroy all of them, permanently, and the shop would not find out
   * until somebody asked for a repair passcode weeks later.
   */
  const nowEnv = readFileSync(path.join(workDir, 'env', 'protech.env'), 'utf8');
  assert.match(nowEnv, new RegExp(`^ACCOUNT_SECRET=${secret}$`, 'm'));
  assert.match(nowEnv, new RegExp(`^JWT_SECRET=${jwt}$`, 'm'));
  assert.match(nowEnv, /^TENANT_SLUG=protech$/m);
  assert.match(nowEnv, /^DB_PATH=.*protech\.sqlite$/m);
  assert.ok(!existsSync(envFile), 'the old settings file would start a second copy');

  // The address: a block for the new name, and none for the old.
  assert.ok(existsSync(path.join(workDir, 'nginx', 'pos-protech')));
  assert.ok(!existsSync(path.join(workDir, 'nginx', 'pos-oldname')));
  assert.match(readFileSync(path.join(workDir, 'nginx', 'pos-protech'), 'utf8'), /protech\.xtechpos\.com/);
});

test('rename refuses a name that is spoken for', () => {
  pos('add', 'taken', 'Someone Else');
  pos('add', 'mover', 'Wants To Move');

  const res = pos('rename', 'mover', 'taken');
  assert.notEqual(res.status, 0);
  assert.match(res.out, /already taken/i);
  assert.ok(row('mover'), 'and left the shop exactly where it was');
});

test('rename refuses a name a browser or a filesystem would not like', () => {
  pos('add', 'fussy', 'Fussy Phones');

  for (const bad of ['admin', 'UPPER', 'has space', 'has.dot', 'x']) {
    const res = pos('rename', 'fussy', bad);
    assert.notEqual(res.status, 0, `"${bad}" was accepted`);
  }
  assert.ok(row('fussy'), 'and none of them moved it');
});

test('a removed shop still owns its name', () => {
  // Its row and its database are both still there, so handing the name out
  // would put two shops' files on top of each other. `purge` gives it back.
  pos('add', 'gone', 'Gone Away');
  pos('remove', 'gone');
  pos('add', 'newcomer', 'Newcomer');

  const res = pos('rename', 'newcomer', 'gone');
  assert.notEqual(res.status, 0);
  assert.match(res.out, /already taken/i);
});

test('a dry run of a rename changes nothing at all', () => {
  pos('add', 'pretend', 'Pretend Phones');

  const res = pos('rename', 'pretend', 'pretend2', '--dry-run');
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /would move/);

  assert.ok(row('pretend'), 'the book still knows the old name');
  assert.equal(row('pretend2'), undefined);
  assert.ok(existsSync(path.join(workDir, 'tenants', 'pretend.sqlite')));
  assert.ok(existsSync(path.join(workDir, 'env', 'pretend.env')));
  assert.ok(!existsSync(path.join(workDir, 'env', 'pretend2.env')));
});

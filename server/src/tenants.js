#!/usr/bin/env node
/**
 * The vendor's command for the shops that rent this app.
 *
 *   pos-tenant add rami "Rami Mobile" --plan monthly --price 25 --trial 14
 *   pos-tenant list
 *   pos-tenant pay rami --periods 1 --amount 25
 *   pos-tenant suspend rami        /  resume rami
 *   pos-tenant rename rami protech # a new address, same shop and same data
 *   pos-tenant remove rami         /  restore rami
 *   pos-tenant purge rami          # deletes their data, on request
 *   pos-tenant operator walid      # a login for the console
 *
 * Run on the server as root. `--dry-run` prints every file it would write and
 * every command it would run, and touches nothing — which is the only way to
 * read what a command like this is about to do to a machine with other people's
 * shops on it.
 *
 * Adding a shop is the one action that needs root: it writes a systemd unit and
 * an nginx server block, and asks Let's Encrypt for a certificate. Everything
 * after that — payments, suspending, restoring — is rows in a database, and the
 * console does those.
 */
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseFiles, ensureControlSchema } from './lib/control.js';
import { createOperator, ensureOperatorSchema, setOperatorPassword } from './lib/operators.js';
import { PLANS, addDays, extend, licenceState, today } from './lib/licence.js';
import {
  checkSlug,
  newSecret,
  nextPort,
  redactSecrets,
  renameEnv,
  renderEnv,
  renderNginx,
  slugify,
  welcome,
} from './lib/provision.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * The settings file, read by this command rather than by the shell.
 *
 * Sourcing `/etc/pos.env` by hand lasts exactly as long as that one terminal.
 * Come back tomorrow, or from another computer, and `POS_CERT_EMAIL` is empty
 * again — at which point `add` cheerfully sets a shop up with no certificate
 * and says so in one grey line among thirty. A step somebody has to remember
 * before every use is a step that will be forgotten on the day it matters.
 *
 * Anything already in the environment wins, so an explicit `CONTROL_DB=...
 * pos-tenant …` still overrides the file, and the tests keep their temporary
 * directories.
 */
function loadSettings(file = process.env.POS_ENV_FILE || '/etc/pos.env') {
  if (!existsSync(file)) return;
  // Only the keys this command uses. The file also holds the vendor's own
  // shop's signing keys, and there is no reason to pull those into a process
  // that will never need them.
  const WANTED = new Set([
    'POS_DOMAIN',
    'CONTROL_DB',
    'POS_TENANT_DATA',
    'POS_ENV_DIR',
    'POS_NGINX_DIR',
    'POS_NGINX_ENABLED',
    'POS_CERT_EMAIL',
  ]);
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && WANTED.has(match[1]) && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

loadSettings();

const CONFIG = {
  domain: process.env.POS_DOMAIN || 'xtechpos.com',
  controlDb: process.env.CONTROL_DB || '/var/lib/pos/control.sqlite',
  tenantData: process.env.POS_TENANT_DATA || '/var/lib/pos/tenants',
  envDir: process.env.POS_ENV_DIR || '/etc/pos/tenants',
  nginxDir: process.env.POS_NGINX_DIR || '/etc/nginx/sites-available',
  nginxEnabled: process.env.POS_NGINX_ENABLED || '/etc/nginx/sites-enabled',
  certEmail: process.env.POS_CERT_EMAIL || '',
  // Who the service runs as. Everything this command creates has to end up
  // owned by them, because root created it and root is not who will run it.
  user: process.env.POS_USER || 'pos',
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : fallback;
};

const say = (m) => console.log(m);
const step = (m) => console.log(`\n\x1b[1;36m==> ${m}\x1b[0m`);
const die = (m) => {
  console.error(`\n\x1b[1;31m!! ${m}\x1b[0m`);
  process.exit(1);
};

/** Write a file, or say what would have been written. */
function put(file, contents) {
  if (dryRun) {
    // Shown with the keys taken out. A dry run exists to be read before
    // anything happens, which means it is read often, scrolled back through,
    // pasted into a chat to ask what went wrong, and photographed. None of
    // those are places for a shop's signing keys.
    say(`\n--- would write ${file} ---\n${redactSecrets(contents)}`);
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, { mode: file.endsWith('.env') ? 0o600 : 0o644 });
  say(`    wrote ${file}`);
}

/** Run something, or say what would have been run. */
function run(command, argv, { allowFail = false, env } = {}) {
  if (dryRun) {
    const shown = env ? `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')} ` : '';
    say(`    would run: ${shown}${command} ${argv.join(' ')}`);
    return { status: 0 };
  }
  const res = spawnSync(command, argv, {
    stdio: 'inherit',
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (res.status !== 0 && !allowFail) die(`${command} ${argv.join(' ')} failed`);
  return res;
}

/**
 * The book of shops.
 *
 * Opened **read-only** for a dry run, so that a mode whose whole promise is
 * "this changes nothing" is enforced by SQLite rather than by every write in
 * this file remembering to ask. The reads still work, so a dry run can still
 * tell you the port it would pick and whether the name is taken.
 */
function control() {
  if (dryRun) {
    return existsSync(CONFIG.controlDb)
      ? new DatabaseSync(CONFIG.controlDb, { readOnly: true })
      : null;
  }
  mkdirSync(path.dirname(CONFIG.controlDb), { recursive: true });
  const db = ensureControlSchema(new DatabaseSync(CONFIG.controlDb));
  handToService(CONFIG.controlDb);
  return db;
}

/**
 * Give the book of shops to the service user.
 *
 * This command runs as root, so every file it creates is root's. The console
 * runs as `pos` and has to *write* to this one — it records payments. A
 * root-owned control database means the first payment taken on the web console
 * fails with "attempt to write a readonly database", which is exactly how the
 * tills failed the first time round.
 *
 * The sidecar files matter as much as the database: SQLite writes through a
 * journal beside it, and one of those left owned by root is the same failure
 * with a less obvious name.
 */
function handToService(dbFile) {
  // Only root can give a file away, and only root created it in the first
  // place. Anywhere else — a developer's machine, the tests — this is neither
  // possible nor wanted, and shouting about it would be noise.
  if (process.getuid?.() !== 0) return;

  const files = databaseFiles(dbFile);
  if (files.length) {
    spawnSync('chown', [`${CONFIG.user}:${CONFIG.user}`, ...files], { stdio: 'ignore' });
  }
}

/*
 * Steps that failed, and what to type to finish them.
 *
 * Both `add` and `rename` reach a point past which dying would be worse than
 * carrying on: the shop exists, or it has already half moved, and stopping
 * midway leaves that in place with no service running and no word about which
 * step to do by hand. So from that point they report rather than exit, and
 * whatever did not work is printed at the end as a command to run.
 */
const unfinished = [];
const attempt = (label, command, argv) => {
  const res = run(command, argv, { allowFail: true });
  if (res.status !== 0) unfinished.push(`${label}:  ${command} ${argv.join(' ')}`);
};

/** Say which steps were left, if any. */
function reportUnfinished(what) {
  if (!unfinished.length) return;
  say(`  Some steps did not finish. ${what}`);
  say('  Run these by hand:\n');
  for (const line of unfinished) say(`    ${line}`);
  say('');
}

const tenantOr404 = (db, slug) => {
  const row = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  if (!row) die(`No shop called "${slug}". Try: pos-tenant list`);
  return row;
};

/* ------------------------------------------------------------------- add */

function add() {
  const [, slugArg, shopName] = positional;
  const slug = slugArg || slugify(shopName);
  const name = shopName || slug;

  const problem = checkSlug(slug);
  if (problem) die(problem);

  const plan = flag('plan', 'monthly');
  if (!PLANS[plan]) die(`Plan must be one of: ${Object.keys(PLANS).join(', ')}`);
  const price = Number(flag('price', '0'));
  const trial = Number(flag('trial', '14'));

  const db = control();
  if (db?.prepare('SELECT 1 FROM tenants WHERE slug = ?').get(slug)) {
    die(`"${slug}" already exists. Use "pos-tenant pay ${slug}" or pick another name.`);
  }

  const taken = db ? db.prepare('SELECT port FROM tenants WHERE port IS NOT NULL').all() : [];
  const port = nextPort(taken.map((r) => r.port));
  const paidThrough = addDays(today(), trial);

  const dbPath = path.join(CONFIG.tenantData, `${slug}.sqlite`);
  const backupDir = path.join(CONFIG.tenantData, `${slug}-backups`);
  const envFile = path.join(CONFIG.envDir, `${slug}.env`);
  const nginxFile = path.join(CONFIG.nginxDir, `pos-${slug}`);

  step(`Setting up ${name} at ${slug}.${CONFIG.domain}`);

  put(
    envFile,
    renderEnv({
      slug,
      port,
      dbPath,
      backupDir,
      controlDb: CONFIG.controlDb,
      jwtSecret: newSecret(),
      accountSecret: newSecret(),
    }),
  );

  step('Creating their database');
  if (!dryRun) mkdirSync(CONFIG.tenantData, { recursive: true });
  /*
   * DB_PATH is passed explicitly, and getting this wrong is how a new client
   * ends up seeded into somebody else's shop — or into the vendor's own. The
   * seed skips anything already present, so the damage would be quiet.
   */
  /*
   * `--starter`, because this is somebody's actual shop rather than a demo.
   * They get the shelves a phone shop files by and an empty catalogue; a new
   * client finding sixteen imaginary coffees in their stock has to delete them
   * before they can trust a single figure on the screen.
   */
  run(process.execPath, [path.join(srcDir, 'seed.js'), '--starter'], {
    env: { DB_PATH: dbPath },
  });

  /*
   * Hand it all to the user that will actually run it.
   *
   * This command is run by root, so everything it just created belongs to root
   * — while the service runs as `pos`. SQLite cannot write a database it does
   * not own, so the shop starts, fails, and is restarted by systemd for ever:
   * `activating (auto-restart)`, with nothing listening on the port and a
   * status line that says nothing about permissions.
   *
   * The whole directory rather than this one shop's files, so that a tenant
   * created before this existed is repaired the next time anything is added.
   */
  step('Handing it to the service user');
  attempt(`give it to ${CONFIG.user}`, 'chown', [
    '-R',
    `${CONFIG.user}:${CONFIG.user}`,
    CONFIG.tenantData,
  ]);
  attempt(`give it to ${CONFIG.user}`, 'chown', [`${CONFIG.user}:${CONFIG.user}`, envFile]);

  step('Recording the licence');
  if (!dryRun) {
    db.prepare(
      `INSERT INTO tenants (slug, shop_name, owner_name, owner_phone, plan, price, port, paid_through)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      slug,
      name,
      flag('owner'),
      flag('phone'),
      plan,
      price,
      port,
      paidThrough,
    );
  } else {
    say(`    would record ${slug} on ${plan}, paid through ${paidThrough}, port ${port}`);
  }

  step('Starting it');
  attempt('start it', 'systemctl', ['enable', '--now', `pos-tenant@${slug}`]);

  step('Putting it on the web');
  put(nginxFile, renderNginx({ slug, domain: CONFIG.domain, port }));
  attempt('link the site', 'ln', [
    '-sf',
    nginxFile,
    path.join(CONFIG.nginxEnabled, `pos-${slug}`),
  ]);
  attempt('check nginx', 'nginx', ['-t']);
  attempt('reload nginx', 'systemctl', ['reload', 'nginx']);

  if (CONFIG.certEmail) {
    step('Getting its certificate');
    run(
      'certbot',
      [
        '--nginx',
        '-d',
        `${slug}.${CONFIG.domain}`,
        '--non-interactive',
        '--agree-tos',
        '-m',
        CONFIG.certEmail,
        '--redirect',
        //
        // Without this, a name that already has a certificate takes a shortcut
        // nobody wants: certbot finds one that is not due for renewal, decides
        // there is nothing to do, and returns success having changed no config
        // at all — so `--redirect` above is quietly skipped and the shop serves
        // in the clear.
        //
        // Reached whenever a slug is used a second time: a shop removed and put
        // back, or a re-run after something else in this command failed. The
        // certificate is not re-issued, so this costs nothing against Let's
        // Encrypt's rate limits.
        //
        '--reinstall',
      ],
      { allowFail: true },
    );
  } else {
    say('    POS_CERT_EMAIL is not set, so no certificate. The shop is on http only.');
  }

  db?.close();
  say(
    welcome({
      slug,
      domain: CONFIG.domain,
      shopName: name,
      port,
      paidThrough,
      password: 'admin123',
      secure: Boolean(CONFIG.certEmail),
      pretend: dryRun,
    }),
  );

  reportUnfinished('The shop is recorded and its database exists.');
}

/* ------------------------------------------------------------------ list */

function list() {
  const db = control();
  if (!db) return say('No control database yet.');

  const rows = db.prepare('SELECT * FROM tenants ORDER BY removed_at IS NOT NULL, slug').all();
  if (rows.length === 0) return say('No shops yet. Add one with: pos-tenant add <name> "Shop Name"');

  const width = Math.max(...rows.map((r) => r.slug.length), 6);
  say('');
  say(`  ${'SHOP'.padEnd(width)}  ${'STATE'.padEnd(9)}  ${'PAID TO'.padEnd(10)}  PORT   NAME`);
  for (const row of rows) {
    const status = row.removed_at ? { state: 'removed' } : licenceState(row);
    say(
      `  ${row.slug.padEnd(width)}  ${status.state.padEnd(9)}  ` +
        `${String(row.paid_through || '—').padEnd(10)}  ${String(row.port || '—').padEnd(5)}  ${row.shop_name}`,
    );
  }
  say('');
  db.close();
}

/* ------------------------------------------------------------------- pay */

function pay() {
  const slug = positional[1];
  const db = control();
  const tenant = tenantOr404(db, slug);

  const periods = Number(flag('periods', '1'));
  if (!Number.isInteger(periods) || periods < 1) die('--periods must be a whole number, 1 or more');
  const amount = Number(flag('amount', String(tenant.price * periods)));

  /*
   * Extended from the day already paid for, not from today — a shop that pays a
   * week late has still bought a whole month, and one that pays early keeps the
   * remainder. A licence that lapsed long ago starts again from today instead,
   * or a shop returning after six months would buy a month that has already
   * been and gone.
   */
  const from = tenant.paid_through && tenant.paid_through >= today() ? tenant.paid_through : today();
  const now = extend(from, tenant.plan, periods);

  if (dryRun) return say(`    would move ${slug} from ${tenant.paid_through || 'never'} to ${now}`);

  db.prepare('UPDATE tenants SET paid_through = ?, suspended = 0 WHERE id = ?').run(now, tenant.id);
  db.prepare(
    `INSERT INTO payments (tenant_id, amount, periods, was_paid_through, now_paid_through, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(tenant.id, amount, periods, tenant.paid_through, now, flag('note'));

  say(`\n  ${tenant.shop_name} is paid through ${now}.\n`);
  db.close();
}

/* ------------------------------------------------ suspend, resume, remove */

function setFlags(fields, message) {
  const slug = positional[1];
  const db = control();
  const tenant = tenantOr404(db, slug);
  if (dryRun) return say(`    would set ${JSON.stringify(fields)} on ${slug}`);

  const sets = Object.keys(fields)
    .map((k) => `${k} = ?`)
    .join(', ');
  db.prepare(`UPDATE tenants SET ${sets} WHERE id = ?`).run(...Object.values(fields), tenant.id);
  say(`\n  ${tenant.shop_name}: ${message}\n`);
  db.close();
}

/** Move a file, or say what would have been moved. */
function move(from, to) {
  if (!existsSync(from)) return false;
  if (dryRun) {
    say(`    would move ${from} -> ${to}`);
    return true;
  }
  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
  say(`    moved ${from} -> ${to}`);
  return true;
}

/**
 * Give a shop a different address.
 *
 * The slug is not just the subdomain. It names the database file, the backups
 * beside it, the settings file, the nginx block and the systemd instance, so
 * changing it is six moves that have to agree with each other, and a shop whose
 * database says one thing and whose service says another does not start.
 *
 * Three things this is careful about, in the order they can hurt:
 *
 * **The secrets survive.** The settings file is rewritten line by line, not
 * regenerated. `ACCOUNT_SECRET` encrypts every customer password and repair
 * passcode the shop holds; a rename that quietly re-rolled it would destroy all
 * of them, permanently, in the course of an operation nobody thinks of as
 * dangerous.
 *
 * **The process is stopped first.** SQLite is a file and a journal beside it,
 * and moving those out from under a running process is how a database gets
 * corrupted rather than moved.
 *
 * **The old name stays taken.** The row keeps its history and simply answers to
 * something else, so a renamed shop cannot collide with a new one later.
 *
 * What it deliberately does not do is keep the old address working. A redirect
 * would need its own certificate for a name nobody is going to use again, and
 * the honest version of "this shop moved" is telling the shop.
 */
function rename() {
  const [, from, to] = positional;
  if (!from || !to) die('Usage: pos-tenant rename <current-name> <new-name>');
  if (from === to) die(`"${from}" is already its name.`);

  const problem = checkSlug(to);
  if (problem) die(problem);

  const db = control();
  const tenant = tenantOr404(db, from);

  /*
   * Removed shops count as taken.
   *
   * Their row is still there and so is their database, so handing the name to
   * somebody else would put two shops' files on top of each other. `purge` is
   * how a name is really given back.
   */
  if (db.prepare('SELECT 1 FROM tenants WHERE slug = ?').get(to)) {
    die(`"${to}" is already taken. Try: pos-tenant list`);
  }

  const oldDb = path.join(CONFIG.tenantData, `${from}.sqlite`);
  const newDb = path.join(CONFIG.tenantData, `${to}.sqlite`);
  const oldEnv = path.join(CONFIG.envDir, `${from}.env`);
  const newEnv = path.join(CONFIG.envDir, `${to}.env`);
  const newBackups = path.join(CONFIG.tenantData, `${to}-backups`);

  step(`Renaming ${tenant.shop_name}: ${from}.${CONFIG.domain} -> ${to}.${CONFIG.domain}`);

  // Stopped, and stopped by name: the instance is called after the old slug and
  // there will be nothing by that name once this is done.
  run('systemctl', ['disable', '--now', `pos-tenant@${from}`], { allowFail: true });

  // The database and everything SQLite keeps beside it. Leaving a `-wal` behind
  // loses whatever had not been checkpointed into the file yet — which on a
  // busy till is the last few sales.
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    move(`${oldDb}${suffix}`, `${newDb}${suffix}`);
  }
  move(path.join(CONFIG.tenantData, `${from}-backups`), newBackups);

  // The settings file, rewritten rather than rebuilt — see above.
  if (existsSync(oldEnv)) {
    const before = readFileSync(oldEnv, 'utf8');
    put(newEnv, renameEnv(before, { slug: to, dbPath: newDb, backupDir: newBackups }));
    if (!dryRun) rmSync(oldEnv, { force: true });
  } else {
    say(`    no settings file at ${oldEnv} — the service will not start without one`);
  }

  // A new server block, and the old one gone from both directories. Left in
  // place it would keep answering for a name whose process no longer exists.
  put(path.join(CONFIG.nginxDir, `pos-${to}`), renderNginx({
    slug: to,
    domain: CONFIG.domain,
    port: tenant.port,
  }));
  if (!dryRun) mkdirSync(CONFIG.nginxEnabled, { recursive: true });
  attempt('link the new site', 'ln', [
    '-sf',
    path.join(CONFIG.nginxDir, `pos-${to}`),
    path.join(CONFIG.nginxEnabled, `pos-${to}`),
  ]);
  attempt('unlink the old site', 'rm', [
    '-f',
    path.join(CONFIG.nginxEnabled, `pos-${from}`),
    path.join(CONFIG.nginxDir, `pos-${from}`),
  ]);
  attempt('check nginx', 'nginx', ['-t']);
  attempt('reload nginx', 'systemctl', ['reload', 'nginx']);

  if (!dryRun) {
    // The book of shops, and the support visits that name this shop — a ticket
    // pointing at a slug that no longer exists cannot be redeemed.
    db.prepare('UPDATE tenants SET slug = ? WHERE id = ?').run(to, tenant.id);
    db.prepare('UPDATE support_tickets SET slug = ? WHERE slug = ?').run(to, from);
  }

  if (CONFIG.certEmail) {
    step('Getting a certificate for the new address');
    run(
      'certbot',
      ['--nginx', '-d', `${to}.${CONFIG.domain}`, '--non-interactive', '--agree-tos', '-m', CONFIG.certEmail, '--redirect', '--reinstall'],
      { allowFail: true },
    );
  }

  attempt('start it under the new name', 'systemctl', ['enable', '--now', `pos-tenant@${to}`]);

  db?.close();

  if (dryRun) return;
  reportUnfinished(`The shop has moved and its data is at ${newDb}.`);
  say(`\n  ${tenant.shop_name} is now at https://${to}.${CONFIG.domain}`);
  say(`\n  Two things this command cannot do for you:`);
  say(`    · ${to}.${CONFIG.domain} needs to resolve. With a wildcard DNS record it`);
  say(`      already does; without one, add an A record before telling the shop.`);
  say(`    · The old address is gone, not redirected. Anyone with a bookmark or an`);
  say(`      installed app pointing at ${from}.${CONFIG.domain} has to be told.\n`);
}

/**
 * Take a shop off the air, keeping every byte of it.
 *
 * Stopping the process and removing the address is enough to end the service.
 * The database stays exactly where it is, because "we are not renting to them
 * any more" and "delete their books" are different decisions and only one of
 * them can be undone.
 */
function remove() {
  const slug = positional[1];
  const db = control();
  const tenant = tenantOr404(db, slug);

  step(`Taking ${tenant.shop_name} off the air`);
  run('systemctl', ['disable', '--now', `pos-tenant@${slug}`], { allowFail: true });
  run('rm', ['-f', path.join(CONFIG.nginxEnabled, `pos-${slug}`)], { allowFail: true });
  run('systemctl', ['reload', 'nginx'], { allowFail: true });

  if (!dryRun) {
    db.prepare(`UPDATE tenants SET removed_at = datetime('now') WHERE id = ?`).run(tenant.id);
    say(`\n  ${tenant.shop_name} is stopped. Their data is still at:`);
    say(`    ${path.join(CONFIG.tenantData, `${slug}.sqlite`)}`);
    say(`  To delete it for good: pos-tenant purge ${slug} --yes\n`);
  }
  db?.close();
}

/**
 * Delete a shop's data, because they asked.
 *
 * Separate from `remove`, and refuses without `--yes`, because it is the one
 * action here that cannot be taken back — and the reason for doing it is
 * usually somebody exercising a right to be forgotten, which is exactly when
 * getting the wrong shop would be worst.
 */
function purge() {
  const slug = positional[1];
  if (!args.includes('--yes')) {
    die(`This deletes ${slug}'s database for good. Add --yes if that is really what you want.`);
  }
  const db = control();
  const tenant = tenantOr404(db, slug);
  if (!tenant.removed_at) die(`Stop it first: pos-tenant remove ${slug}`);

  const dbPath = path.join(CONFIG.tenantData, `${slug}.sqlite`);
  step(`Deleting ${tenant.shop_name}'s data`);
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (dryRun) say(`    would delete ${file}`);
    else rmSync(file, { force: true });
  }
  if (dryRun) {
    say(`    would delete ${path.join(CONFIG.tenantData, `${slug}-backups`)}`);
    say(`    would delete ${path.join(CONFIG.envDir, `${slug}.env`)}`);
    return;
  }
  rmSync(path.join(CONFIG.tenantData, `${slug}-backups`), { recursive: true, force: true });
  rmSync(path.join(CONFIG.envDir, `${slug}.env`), { force: true });

  // The row stays, without anything identifying in it: the payments against it
  // are the vendor's own accounts, and deleting those is a different question.
  db.prepare(
    `UPDATE tenants SET owner_name = NULL, owner_phone = NULL, shop_name = ? WHERE id = ?`,
  ).run(`(deleted ${today()})`, tenant.id);

  say(`\n  Deleted. The payment history against this shop is kept for your own books.\n`);
  db.close();
}

/* -------------------------------------------------------- console logins */

/**
 * Make, or reset, a login for the console.
 *
 *   pos-tenant operator walid 'a long console password'
 *
 * Here rather than in the console itself, because the first one has to exist
 * before anybody can sign in — and a web page that lets a stranger create the
 * account that can stop every shop is not a web page worth having.
 */
function operator() {
  const [, username, password] = positional;
  if (!username || !password) {
    die("Usage: pos-tenant operator <username> '<password>'  (12 characters or more)");
  }
  if (dryRun) return say(`    would create or reset the console login "${username}"`);

  const db = ensureOperatorSchema(control());
  const exists = db.prepare('SELECT 1 FROM operators WHERE username = ?').get(username);
  try {
    if (exists) {
      setOperatorPassword(db, username, password);
      say(`\n  Console password for ${username} changed.\n`);
    } else {
      createOperator(db, username, password);
      say(`\n  Console login ${username} created. Sign in at https://admin.${CONFIG.domain}\n`);
    }
  } catch (err) {
    die(err.message);
  }
  db.close();
}

/* ------------------------------------------------------------------ main */

const commands = {
  add,
  list,
  pay,
  suspend: () => setFlags({ suspended: 1 }, 'suspended — the till stops now'),
  resume: () => setFlags({ suspended: 0 }, 'running again'),
  rename,
  remove,
  restore: () => setFlags({ removed_at: null }, 'restored to the book — start it with systemctl'),
  purge,
  operator,
};

const command = positional[0];
if (!command || !commands[command]) {
  say(`
  pos-tenant — the shops renting this app

    add <slug> "Shop Name" [--plan monthly|yearly] [--price 25] [--trial 14]
                           [--owner "Name"] [--phone 03123456]
    list
    pay <slug> [--periods 1] [--amount 25] [--note "cash"]
    suspend <slug>            stop the till now, whatever the dates say
    resume <slug>
    rename <slug> <new-slug>  change their address, keeping their data
    remove <slug>             stop it and take the address down, keeping the data
    restore <slug>
    purge <slug> --yes        delete their data, on request
    operator <name> '<pw>'    make or reset a login for the web console

  Add --dry-run to any of these to see exactly what it would do.
`);
  process.exit(command ? 1 : 0);
}

commands[command]();

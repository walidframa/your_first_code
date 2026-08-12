#!/usr/bin/env node
/**
 * The vendor's command for the shops that rent this app.
 *
 *   pos-tenant add rami "Rami Mobile" --plan monthly --price 25 --trial 14
 *   pos-tenant list
 *   pos-tenant pay rami --periods 1 --amount 25
 *   pos-tenant suspend rami        /  resume rami
 *   pos-tenant remove rami         /  restore rami
 *   pos-tenant purge rami          # deletes their data, on request
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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureControlSchema } from './lib/control.js';
import { PLANS, addDays, extend, licenceState, today } from './lib/licence.js';
import {
  checkSlug,
  newSecret,
  nextPort,
  renderEnv,
  renderNginx,
  slugify,
  welcome,
} from './lib/provision.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  domain: process.env.POS_DOMAIN || 'xtechpos.com',
  controlDb: process.env.CONTROL_DB || '/var/lib/pos/control.sqlite',
  tenantData: process.env.POS_TENANT_DATA || '/var/lib/pos/tenants',
  envDir: process.env.POS_ENV_DIR || '/etc/pos/tenants',
  nginxDir: process.env.POS_NGINX_DIR || '/etc/nginx/sites-available',
  nginxEnabled: process.env.POS_NGINX_ENABLED || '/etc/nginx/sites-enabled',
  certEmail: process.env.POS_CERT_EMAIL || '',
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
    say(`\n--- would write ${file} ---\n${contents}`);
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
  return ensureControlSchema(new DatabaseSync(CONFIG.controlDb));
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
  run(process.execPath, [path.join(srcDir, 'seed.js')], { env: { DB_PATH: dbPath } });

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

  /*
   * From here on, a failure is reported rather than fatal.
   *
   * The shop already exists by this point — its database is seeded, its keys
   * are written, its licence is recorded. Dying here would leave all of that in
   * place with no service running and no word about which step to finish by
   * hand, and the vendor would be looking at a half-built tenant they cannot
   * re-add because the name is now taken.
   */
  const unfinished = [];
  const attempt = (label, command, argv) => {
    const res = run(command, argv, { allowFail: true });
    if (res.status !== 0) unfinished.push(`${label}:  ${command} ${argv.join(' ')}`);
  };

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
      ],
      { allowFail: true },
    );
  } else {
    say('    POS_CERT_EMAIL is not set, so no certificate. The shop is on http only.');
  }

  db?.close();
  say(welcome({ slug, domain: CONFIG.domain, shopName: name, port, paidThrough, password: 'admin123' }));

  if (unfinished.length) {
    say('  Some steps did not finish. The shop is recorded and its database exists;');
    say('  run these by hand to put it on the air:\n');
    for (const line of unfinished) say(`    ${line}`);
    say('');
  }
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

/* ------------------------------------------------------------------ main */

const commands = {
  add,
  list,
  pay,
  suspend: () => setFlags({ suspended: 1 }, 'suspended — the till stops now'),
  resume: () => setFlags({ suspended: 0 }, 'running again'),
  remove,
  restore: () => setFlags({ removed_at: null }, 'restored to the book — start it with systemctl'),
  purge,
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
    remove <slug>             stop it and take the address down, keeping the data
    restore <slug>
    purge <slug> --yes        delete their data, on request

  Add --dry-run to any of these to see exactly what it would do.
`);
  process.exit(command ? 1 : 0);
}

commands[command]();

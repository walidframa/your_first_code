import { randomBytes } from 'node:crypto';

/**
 * Everything about setting a new shop up, as values rather than side effects.
 *
 * The command that creates a tenant writes four files, edits a database and
 * restarts two services, and none of that can be tried out. So the decisions —
 * what the address may be called, which port it gets, what goes in each file —
 * live here as functions that take arguments and return strings, and the
 * command becomes the thin part that writes what these return.
 */

/**
 * Names that are already something else.
 *
 * A client who takes `admin` takes the console; one who takes `www` takes the
 * main site. Both are reachable through the same wildcard, so the first defence
 * is not handing the name out.
 */
export const RESERVED = new Set([
  'admin',
  'api',
  'app',
  'autoconfig',
  'autodiscover',
  'cdn',
  'control',
  'dev',
  'ftp',
  'imap',
  'localhost',
  'mail',
  'mx',
  'ns',
  'ns1',
  'ns2',
  'pop',
  'smtp',
  'staging',
  'static',
  'support',
  'test',
  'webmail',
  'www',
]);

/**
 * Is this a name we can safely put in a hostname, a filename, a systemd unit
 * and an nginx config?
 *
 * Strict on purpose. This string ends up inside a shell command and a file
 * path, so anything outside letters, digits and hyphens is refused rather than
 * escaped — there is no reason a shop's address needs a full stop in it, and
 * every reason not to find out what happens when one does.
 */
export function checkSlug(slug) {
  if (typeof slug !== 'string' || !slug) return 'Give the shop a short name for its address';
  if (slug !== slug.toLowerCase()) return 'Use lower case only';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return 'Letters, digits and hyphens only, starting and ending with a letter or digit';
  }
  if (slug.length < 2 || slug.length > 30) return 'Between 2 and 30 characters';
  if (RESERVED.has(slug)) return `"${slug}" is reserved`;
  return null;
}

/** A suggestion, from the shop's real name. The vendor can always override it. */
export function slugify(shopName) {
  return String(shopName || '')
    .toLowerCase()
    .normalize('NFD')
    // The accents that NFD has just split off, written as code points rather
    // than as themselves: a range of combining marks in a source file is
    // invisible, and one stray edit turns it into something else entirely.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
}

/**
 * The next free port, counting up from a base well clear of everything else.
 *
 * The vendor's own shop sits on 4000 and the test suites live in the 4500s and
 * 4600s, so tenants start at 4100 and never reach them.
 */
export const PORT_BASE = 4100;

export function nextPort(taken, base = PORT_BASE) {
  const used = new Set((taken || []).map(Number));
  let port = base;
  while (used.has(port)) port += 1;
  return port;
}

export const newSecret = () => randomBytes(48).toString('hex');

/**
 * One shop's settings, as a file systemd hands to its process.
 *
 * Each tenant gets its own signing keys. Sharing them would mean a token minted
 * for one shop being accepted by another, which is the whole game — and
 * rotating one shop's keys would sign every other shop's staff out.
 */
export function renderEnv({ slug, port, dbPath, controlDb, backupDir, jwtSecret, accountSecret }) {
  return [
    `# ${slug} — written by "pos-tenant add". Keep ACCOUNT_SECRET backed up.`,
    '#',
    '# ACCOUNT_SECRET encrypts the customer passwords and repair passcodes this',
    '# shop holds. Replace it and every one of them becomes unreadable, for good.',
    'NODE_ENV=production',
    `PORT=${port}`,
    `DB_PATH=${dbPath}`,
    `BACKUP_DIR=${backupDir}`,
    '',
    '# Which shop this is, and where the licence for it is kept. The file is',
    '# opened read-only: a tenant can read its own licence and change nothing.',
    `TENANT_SLUG=${slug}`,
    `CONTROL_DB=${controlDb}`,
    '',
    `JWT_SECRET=${jwtSecret}`,
    `ACCOUNT_SECRET=${accountSecret}`,
    '',
  ].join('\n');
}

/**
 * The nginx server block for one shop.
 *
 * A file per tenant rather than one clever config with a map, because certbot
 * edits these in place when it issues a certificate, and it finds the right one
 * by the name in `server_name`.
 */
export function renderNginx({ slug, domain, port }) {
  const host = `${slug}.${domain}`;
  return `# ${host} — written by "pos-tenant add". certbot adds the HTTPS block.
server {
    listen 80;
    listen [::]:80;
    server_name ${host};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        client_max_body_size 12m;
        proxy_read_timeout 120s;
    }

    location = /index.html {
        proxy_pass http://127.0.0.1:${port};
        proxy_set_header Host $host;
        add_header Cache-Control "no-cache" always;
    }
}
`;
}

/**
 * What the vendor is told once a shop exists.
 *
 * Two things this must not get wrong, because both are read as fact and acted
 * on:
 *
 * It must not say a shop **is** set up at the end of a dry run. "Rami Mobile is
 * set up" under a wall of "would run" is the one line a person actually reads,
 * and believing it means handing an address to a client that does not exist.
 *
 * And it must not offer an **https** address for a shop that has no
 * certificate. That link is copied straight into a message to the client, who
 * gets a browser warning and concludes the app is broken — when what actually
 * happened is that nobody set an email for Let's Encrypt.
 */
export function welcome({
  slug,
  domain,
  shopName,
  port,
  paidThrough,
  password,
  secure = true,
  pretend = false,
}) {
  const scheme = secure ? 'https' : 'http';
  return [
    '',
    pretend ? `  ${shopName} would be set up. Nothing has been done.` : `  ${shopName} is set up.`,
    '',
    `    Address    ${scheme}://${slug}.${domain}`,
    `    Sign in    admin / ${password}`,
    `    Paid to    ${paidThrough}`,
    '',
    ...(secure
      ? []
      : [
          '  No certificate, so that address is http and cannot be installed as an',
          '  app. Set POS_CERT_EMAIL in /etc/pos.env and run:',
          `    certbot --nginx -d ${slug}.${domain}`,
          '',
        ]),
    '  They will be asked to choose their own password the first time they sign in.',
    `  This shop runs on port ${port}, in its own process, with its own database.`,
    '',
  ].join('\n');
}

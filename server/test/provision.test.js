/**
 * The decisions behind setting a shop up.
 *
 * The command that does it writes systemd units and nginx configs and talks to
 * Let's Encrypt, none of which can be tried out here — so everything it decides
 * before touching the machine is a function, and this is where those get their
 * awkward inputs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PORT_BASE,
  RESERVED,
  checkSlug,
  nextPort,
  renderEnv,
  renderNginx,
  slugify,
} from '../src/lib/provision.js';

/* ------------------------------------------------------------- the name */

test('an ordinary name is fine', () => {
  for (const good of ['rami', 'rami-mobile', 'shop2', 'a1']) {
    assert.equal(checkSlug(good), null, `${good} was refused`);
  }
});

test('anything that would not survive a hostname is refused', () => {
  // This string ends up in a file path, an nginx config and a systemd unit
  // name. Refusing is cheaper than escaping, and there is no shop that needs a
  // full stop in its address.
  for (const bad of [
    'Rami', // upper case
    'rami mobile', // space
    'rami.mobile', // would make a sub-sub-domain
    '-rami', // leading hyphen is not a valid hostname label
    'rami-', //
    'r', // too short to be meant
    'a'.repeat(31),
    '../etc/passwd',
    'rami;reboot',
    'rami$(whoami)',
    '',
    null,
  ]) {
    assert.notEqual(checkSlug(bad), null, `${JSON.stringify(bad)} was allowed`);
  }
});

test('the names that are already something else are refused', () => {
  // A client taking `admin` takes the console; one taking `www` takes the main
  // site. The wildcard points all of them at the same machine.
  for (const taken of ['admin', 'www', 'api', 'mail']) {
    assert.match(checkSlug(taken), /reserved/);
    assert.ok(RESERVED.has(taken));
  }
});

test('a suggested name comes out of a real one', () => {
  assert.equal(slugify('Rami Mobile'), 'rami-mobile');
  assert.equal(slugify('Café Béirut!!'), 'cafe-beirut');
  assert.equal(slugify('  --Odd  Name--  '), 'odd-name');
  assert.equal(slugify('موبايل رامي'), '', 'nothing usable, so nothing suggested');
});

test('a suggestion is always something the checker would accept', () => {
  for (const name of ['Rami Mobile', 'Café Béirut!!', 'A' + 'b'.repeat(60), '2 Fast 2 Phones']) {
    const slug = slugify(name);
    if (slug) assert.equal(checkSlug(slug), null, `${name} -> ${slug} was refused`);
  }
});

/* ------------------------------------------------------------- the port */

test('ports are handed out from a base clear of everything else', () => {
  // The vendor's own shop is on 4000 and the test suites live in the 4500s and
  // 4600s. Tenants start at 4100 and count up.
  assert.equal(nextPort([]), PORT_BASE);
  assert.equal(nextPort([4100, 4101, 4102]), 4103);
});

test('a gap left by a removed shop is filled', () => {
  assert.equal(nextPort([4100, 4102]), 4101);
});

test('ports already in use are never handed out twice', () => {
  const taken = [];
  for (let i = 0; i < 20; i += 1) taken.push(nextPort(taken));
  assert.equal(new Set(taken).size, 20);
});

/* ------------------------------------------------------------ the files */

test("each shop's settings name only that shop", () => {
  const env = renderEnv({
    slug: 'rami',
    port: 4100,
    dbPath: '/var/lib/pos/tenants/rami.sqlite',
    backupDir: '/var/lib/pos/tenants/rami-backups',
    controlDb: '/var/lib/pos/control.sqlite',
    jwtSecret: 'jjj',
    accountSecret: 'aaa',
  });

  assert.match(env, /^TENANT_SLUG=rami$/m);
  assert.match(env, /^PORT=4100$/m);
  assert.match(env, /^DB_PATH=\/var\/lib\/pos\/tenants\/rami\.sqlite$/m);
  assert.match(env, /^CONTROL_DB=\/var\/lib\/pos\/control\.sqlite$/m);
});

test('the two secrets are separate, and per shop', () => {
  // One shop's token being accepted by another is the whole game. And rotating
  // a shared key would sign every other shop's staff out at once.
  const env = renderEnv({
    slug: 'rami',
    port: 4100,
    dbPath: '/d',
    backupDir: '/b',
    controlDb: '/c',
    jwtSecret: 'jay',
    accountSecret: 'ay',
  });
  assert.match(env, /^JWT_SECRET=jay$/m);
  assert.match(env, /^ACCOUNT_SECRET=ay$/m);
});

test('the web config points one address at one port', () => {
  const conf = renderNginx({ slug: 'rami', domain: 'xtechpos.com', port: 4100 });
  assert.match(conf, /server_name rami\.xtechpos\.com;/);
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:4100;/);
  // The page that names the current assets, never cached — an update reaching
  // the server and not the till is the same bug here as anywhere else.
  assert.match(conf, /location = \/index\.html/);
  assert.match(conf, /no-cache/);
});

test('two shops get configs that cannot be confused', () => {
  const a = renderNginx({ slug: 'rami', domain: 'xtechpos.com', port: 4100 });
  const b = renderNginx({ slug: 'nabil', domain: 'xtechpos.com', port: 4101 });
  assert.ok(!a.includes('nabil'));
  assert.ok(!b.includes('rami'));
  assert.ok(!a.includes('4101'));
});

/**
 * What a shop finds in it on the first morning.
 *
 * `seed.js` does two different jobs under one name, and until now only did the
 * first: fill a demo. Every shop the vendor sold a copy to was handed sixteen
 * imaginary coffees and croissants, under categories called Bakery and
 * Apparel, in a phone shop. That is not cosmetic — a shopkeeper cannot trust a
 * stock figure, a profit line or a dashboard until they have found and deleted
 * all of it, and the first thing the app does is give them a reason to doubt
 * every number on the screen.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STARTER_CATEGORIES } from '../src/lib/starterCategories.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let workDir;

/** Seed a throwaway database the way the given caller would. */
function seed(name, ...args) {
  const dbPath = path.join(workDir, `${name}.sqlite`);
  const res = spawnSync(process.execPath, ['src/seed.js', ...args], {
    cwd: serverRoot,
    encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, NODE_ENV: 'test' },
  });
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = (sql) => db.prepare(sql).all();
  const out = {
    products: rows('SELECT name FROM products').map((r) => r.name),
    categories: rows('SELECT name FROM categories').map((r) => r.name),
    users: rows('SELECT username FROM users').map((r) => r.username),
    output: `${res.stdout}${res.stderr}`,
  };
  db.close();
  return out;
}

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-seed-'));
});
after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a shop somebody paid for opens with its own empty catalogue', () => {
  const shop = seed('starter', '--starter');

  assert.deepEqual(shop.products, [], 'a real shop was given demo stock');
  assert.ok(shop.categories.includes('Phones'));
  assert.ok(shop.categories.includes('Chargers'));
  assert.equal(shop.categories.length, STARTER_CATEGORIES.length);

  // And nothing from the demo, which is the whole point.
  for (const gone of ['Bakery', 'Beverages', 'Snacks', 'Apparel']) {
    assert.ok(!shop.categories.includes(gone), `a phone shop was given a ${gone} shelf`);
  }
});

test('but it can still be signed into', () => {
  // The one thing the seed must never skip: a shop nobody can sign into is a
  // shop that has to be rebuilt by hand on the server.
  const shop = seed('starter-users', '--starter');
  assert.deepEqual(shop.users.sort(), ['admin', 'cashier']);
});

test('the demo still has something in it to demonstrate', () => {
  // The screenshots, the development copy and the whole end-to-end run stand on
  // this, so "clean up the seed" must not quietly empty it.
  const demo = seed('demo');
  assert.ok(demo.products.includes('Espresso'));
  assert.ok(demo.products.length >= 16);
  assert.ok(demo.categories.includes('Beverages'));
});

test('setting a shop up twice does not double anything', () => {
  // `pos-tenant add` on a name that half-failed the first time is a normal
  // thing to do, and it must not end with two of every shelf.
  const dbPath = path.join(workDir, 'twice.sqlite');
  for (let i = 0; i < 2; i += 1) {
    const res = spawnSync(process.execPath, ['src/seed.js', '--starter'], {
      cwd: serverRoot,
      encoding: 'utf8',
      env: { ...process.env, DB_PATH: dbPath, NODE_ENV: 'test' },
    });
    assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  db.close();

  assert.equal(count, STARTER_CATEGORIES.length);
  assert.equal(users, 2);
});

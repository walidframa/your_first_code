/**
 * The shelves a phone shop starts with.
 *
 * Two jobs, and the second is the one with teeth. Setting a brand-new shop up
 * is easy. Offering the same list to a shop that has been running for months
 * is where the damage lives: a second shelf called "Chargers" beside the
 * "chargers" they already had splits their stock across two rows that look
 * identical in every list, and nothing in the app will ever tell them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { STARTER_CATEGORIES, addStarterCategories } from '../src/lib/starterCategories.js';

function shop() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE categories (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             name TEXT UNIQUE NOT NULL
           )`);
  return db;
}

const names = (db) => db.prepare('SELECT name FROM categories ORDER BY name').all().map((r) => r.name);

test('a new shop gets the whole list', () => {
  const db = shop();
  const added = addStarterCategories(db);
  assert.equal(added.length, STARTER_CATEGORIES.length);
  assert.deepEqual(names(db).sort(), [...STARTER_CATEGORIES].sort());
});

test('running it twice changes nothing the second time', () => {
  const db = shop();
  addStarterCategories(db);
  assert.deepEqual(addStarterCategories(db), [], 'it added a second copy of everything');
  assert.equal(names(db).length, STARTER_CATEGORIES.length);
});

test('a shelf the shop spelled its own way is left alone', () => {
  // The failure this exists to prevent: "chargers" and "Chargers" side by side,
  // half the cables on each, and no screen in the app that makes that visible.
  const db = shop();
  db.prepare('INSERT INTO categories (name) VALUES (?)').run('chargers');
  db.prepare('INSERT INTO categories (name) VALUES (?)').run('  Phones  ');

  const added = addStarterCategories(db);

  assert.ok(!added.includes('Chargers'), 'it added a second charger shelf');
  assert.ok(!added.includes('Phones'), 'it added a second phone shelf');
  assert.equal(names(db).filter((n) => n.trim().toLowerCase() === 'chargers').length, 1);
  assert.equal(names(db).filter((n) => n.trim().toLowerCase() === 'phones').length, 1);
});

test('what the shop already had is still there afterwards', () => {
  const db = shop();
  db.prepare('INSERT INTO categories (name) VALUES (?)').run('Drones');
  addStarterCategories(db);
  assert.ok(names(db).includes('Drones'), 'it lost a category the shop made itself');
});

test('the list is short enough to be read', () => {
  // Twenty is a filter bar that wraps onto three lines at the register, which
  // costs more room than the categories save.
  assert.ok(STARTER_CATEGORIES.length <= 18, `${STARTER_CATEGORIES.length} is too many`);
  assert.equal(new Set(STARTER_CATEGORIES).size, STARTER_CATEGORIES.length, 'it repeats itself');
});

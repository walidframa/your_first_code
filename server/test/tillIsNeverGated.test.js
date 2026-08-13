/**
 * The routes a till cannot sell without.
 *
 * Modules are things a shop buys. Selling is not one of them — a shop that
 * pays for nothing but the register must still be able to open the register,
 * or the product is not a point-of-sale system, it is a licence check.
 *
 * This exists because `/api/branches` was gated behind the branches module and
 * a live shop's register became a page of grey rectangles: stock is held per
 * branch, so the screen asks which branch it is in before it can show a shelf,
 * and a 403 there is not a feature politely withheld — it is the till failing
 * to load, silently, on the one screen that has a customer standing in front
 * of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_KEYS, moduleForPath, parseModules } from '../src/lib/modules.js';

/*
 * Everything the register and the back office touch before a sale can happen.
 * Adding a module that catches one of these is the mistake this file is for.
 */
const THE_TILL = [
  '/api/health',
  '/api/auth/login',
  '/api/auth/me',
  '/api/auth/password',
  '/api/settings',
  '/api/branding',
  '/api/licence',
  '/api/branches',
  '/api/branches/2',
  '/api/products',
  '/api/products/7',
  '/api/categories',
  '/api/orders',
  '/api/orders/12',
  '/api/customers',
  '/api/suppliers',
  '/api/cashbox',
  '/api/expenses',
  '/api/inventory',
  '/api/reports/summary',
  '/api/users',
];

test('nothing a shop needs in order to sell is behind a module', () => {
  const gated = THE_TILL.filter((path) => moduleForPath(path) !== null).map(
    (path) => `${path} -> ${moduleForPath(path)}`,
  );
  assert.deepEqual(gated, [], 'these would 403 for a shop that bought only the till');
});

test('a shop that has bought nothing can still reach all of it', () => {
  // The realistic worst case: every module unticked in the vendor's console.
  const nothing = parseModules(JSON.stringify([]));
  assert.deepEqual(nothing, [], 'the fixture is not actually empty');

  for (const path of THE_TILL) {
    const needed = moduleForPath(path);
    assert.equal(needed, null, `${path} needs "${needed}", which this shop has not got`);
  }
});

test('the things that really are modules are still gated', () => {
  // The other half: this must not become a file that gates nothing.
  for (const [path, expected] of [
    ['/api/repairs', 'repairs'],
    ['/api/repairs/4/parts', 'repairs'],
    ['/api/sims', 'sims'],
    ['/api/documents', 'documents'],
    ['/api/stock-transfers', 'branches'],
    ['/api/shopify/pull', 'shopify'],
  ]) {
    assert.equal(moduleForPath(path), expected, `${path} stopped being a module`);
  }
});

test('every gated route names a module that exists', () => {
  // A typo here is a route nobody can ever reach, whatever they have paid for.
  for (const path of ['/api/repairs', '/api/sims', '/api/documents', '/api/stock-transfers']) {
    assert.ok(MODULE_KEYS.includes(moduleForPath(path)), `${path} names an unknown module`);
  }
});

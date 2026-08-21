/**
 * The worker that keeps the till on screen, and the update that has to reach it.
 *
 * A shop ran four deploys behind because none of this was true: the cache was
 * keyed on a version string that never changed, the worker seized control of a
 * running page instead of waiting, and the one file that had to change for a
 * browser to notice anything was served with a year-long cache.
 *
 * These are cheap checks on a file nothing else tests, and each of them is a
 * bug that has actually happened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const worker = readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const viteConfig = readFileSync(path.join(root, 'vite.config.js'), 'utf8');
const server = readFileSync(
  path.join(path.dirname(root), 'server', 'src', 'index.js'),
  'utf8',
);

test('the cache is keyed on something the build replaces', () => {
  // The literal token, waiting for the stamp. A hard-coded 'v1' here is the
  // original bug: every deploy shared one cache and none of them won.
  assert.match(worker, /const VERSION = '__BUILD__'/);
  assert.ok(
    worker.includes('`pos-shell-${VERSION}`') && worker.includes('`pos-reads-${VERSION}`'),
    'a cache name that does not carry the version survives the deploy that should clear it',
  );
});

test('the build stamps it, and clears the caches that are not this build', () => {
  assert.match(viteConfig, /__BUILD__/);
  assert.match(viteConfig, /stampServiceWorker/);
  // Old caches go on activate, or a till accumulates one shell per deploy.
  assert.match(worker, /caches\.delete\(name\)/);
});

test('a new worker waits rather than taking the page from under a sale', () => {
  /*
   * There is exactly one call, and it is the one the app makes when somebody
   * presses Reload. Called on install instead, it swaps the assets of a page
   * that may have a sale half rung up.
   */
  const calls = worker.match(/self\.skipWaiting\(\)/g) || [];
  assert.equal(calls.length, 1, `skipWaiting is called ${calls.length} times`);
  assert.match(
    worker,
    /'skip-waiting'\)\s*self\.skipWaiting\(\)/,
    'skipWaiting is called somewhere other than in answer to the app asking',
  );
});

test('the two files that name the current version are never cached', () => {
  /*
   * index.html names the hashed assets; sw.js names the cache the app is
   * served from and cannot carry a hash of its own, because a worker has to
   * sit at the root. Served immutable, sw.js is the one file a browser would
   * never re-fetch — which is the file that has to change for an update to
   * arrive at all.
   */
  assert.match(server, /name === 'index\.html' \|\| name === 'sw\.js'/);
  assert.match(server, /pinned \? 'no-cache'/);
});

/**
 * Serving the built app, from wherever it was told to find it.
 *
 * In production there is no Vite: the API server hands out the built client
 * itself, and `CLIENT_DIST` is how it is told where that is. The interesting
 * case is a *relative* path, because it is the one a person types — `../client/dist`
 * out of the server folder, or `client/dist` from the repo root — and it used
 * to half-work in the worst possible way: express.static resolves a relative
 * root happily, so every asset came back 200, while res.sendFile refuses
 * anything that is not absolute, so every actual page came back 500.
 *
 * An app whose Javascript loads and whose pages do not looks like the app being
 * broken rather than a path being written the short way, so it is worth a test.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4597;
const BASE = `http://127.0.0.1:${PORT}`;

const PAGE = '<!doctype html><title>Front Desk POS</title><div id="root"></div>';

let child;
let workDir;

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready in time');
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-serve-'));

  // A stand-in for `npm run build`, with the two kinds of file that matter:
  // the page, and something with a hashed name beside it.
  const dist = path.join(workDir, 'dist');
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), PAGE);
  writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)\n');
  writeFileSync(path.join(dist, 'manifest.webmanifest'), '{"name":"Front Desk POS"}');

  child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      DB_PATH: path.join(workDir, 'test.sqlite'),
      JWT_SECRET: 'test-secret-long-enough-for-the-production-guard',
      PORT: String(PORT),
      NODE_ENV: 'test',
      // Relative, which is the whole point of this file.
      CLIENT_DIST: path.relative(serverRoot, dist),
    },
  });
  await waitForServer();
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('the front page is served from a relative CLIENT_DIST', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Front Desk POS/);
});

test('a page the server has never heard of is answered with the app', async () => {
  // The app routes in the browser, so /admin/cashbox typed into the address bar
  // is a real page here — it has to come back as the app, which then reads the
  // path itself.
  const res = await fetch(`${BASE}/admin/cashbox`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<div id="root">/);
});

test('assets are served too, and cached hard', async () => {
  const res = await fetch(`${BASE}/assets/index-abc123.js`);
  assert.equal(res.status, 200);
  // Vite puts a content hash in the name, so the file can never change.
  assert.match(res.headers.get('cache-control') || '', /immutable|max-age=31536000/);
});

test('the page itself is never cached', async () => {
  // It is the file that names the current assets. A cached copy is a till
  // permanently stuck on the last deploy, asking for files that are gone.
  const res = await fetch(`${BASE}/`);
  assert.match(res.headers.get('cache-control') || '', /no-cache/);
});

test('the manifest is served, so the till can be installed', async () => {
  const res = await fetch(`${BASE}/manifest.webmanifest`);
  assert.equal(res.status, 200);
});

test('a mistyped API route still says so in JSON', async () => {
  // Handing a page of HTML to something expecting JSON turns a clear 404 into
  // an unparseable mess several layers away.
  const res = await fetch(`${BASE}/api/nothing-here`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'Not found');
});

test('a HEAD asks the same question as a GET, and gets the same answer', async () => {
  /*
   * A HEAD is a GET that stops before the body, and it is what every uptime
   * monitor, load balancer and `curl -I` sends. Answering 404 means a perfectly
   * healthy shop is reported as missing by everything that checks on it without
   * opening a browser — and the first person to run `curl -I` on a new shop
   * concludes the deployment failed.
   */
  for (const route of ['/', '/admin/cashbox']) {
    const head = await fetch(`${BASE}${route}`, { method: 'HEAD' });
    const get = await fetch(`${BASE}${route}`);
    assert.equal(head.status, get.status, `HEAD ${route} disagreed with GET`);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('cache-control'), get.headers.get('cache-control'));
  }
});

test('a HEAD to a mistyped API route is still a 404', async () => {
  // Letting HEAD through must not turn the API into a page-server.
  const res = await fetch(`${BASE}/api/nothing-here`, { method: 'HEAD' });
  assert.equal(res.status, 404);
});

/**
 * What goes back on the wire.
 *
 * A shop with 1,829 products answers `GET /products` with 1.2MB of JSON, and
 * the register asks for it every time somebody opens a screen. The server
 * builds it in 40ms and the till spends seconds downloading it — which is what
 * a shopkeeper means when they say the app is slow.
 *
 * Measured on a catalogue that size: 1224KB becomes 43KB. The claims under test
 * are that it is actually compressed, that it still says exactly what it said
 * before, and that a client which cannot read gzip is not handed some anyway.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4663;

let child;
let workDir;
let token;

/*
 * Raw, deliberately. `fetch` decompresses transparently and drops the header
 * that says it did, so a test written with it passes whether or not any of this
 * works — which is exactly the mistake that hid a broken benchmark.
 */
function raw(route, encoding = 'gzip') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: `/api${route}`,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Accept-Encoding': encoding,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready in time');
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-gzip-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'gzip.sqlite'),
    JWT_SECRET: 'compress-test-secret-long-enough-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  const login = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  token = (await login.json()).token;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('the catalogue travels compressed', async () => {
  const res = await raw('/products');

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.match(res.headers['content-type'], /application\/json/);

  /*
   * Without this a cache can keep the compressed copy and hand it to a client
   * that asked for plain text, which breaks the app for that client only — the
   * worst kind of bug to be told about over the phone.
   */
  assert.match(res.headers.vary, /accept-encoding/i);
});

test('and says exactly what it said before', async () => {
  const [zipped, plain] = [await raw('/products'), await raw('/products', 'identity')];

  assert.equal(plain.headers['content-encoding'], undefined, 'not compressed for a client that said no');

  const unzipped = gunzipSync(zipped.body).toString('utf8');
  assert.deepEqual(
    JSON.parse(unzipped),
    JSON.parse(plain.body.toString('utf8')),
    'the same catalogue, byte for byte once unpacked',
  );
  assert.ok(JSON.parse(unzipped).products.length > 0, 'and it is not an empty list agreeing with itself');

  // The whole point: it has to be markedly smaller, or none of this earns its keep.
  assert.ok(
    zipped.body.length * 2 < plain.body.length,
    `compressed ${zipped.body.length} vs plain ${plain.body.length}`,
  );
});

test('a client that cannot read gzip is not sent any', async () => {
  const res = await raw('/products', 'identity');
  assert.equal(res.headers['content-encoding'], undefined);
  assert.ok(JSON.parse(res.body.toString('utf8')).products, 'and it is plain, readable JSON');
});

test('a small reply is left alone', async () => {
  /*
   * A gzip header is eighteen bytes before a byte of content, and most replies
   * here are a few hundred. Compressing those spends CPU to make them longer.
   */
  const res = await raw('/branches');
  assert.equal(res.status, 200);
  assert.ok(res.body.length < 1024, `branches is ${res.body.length} bytes`);
  assert.equal(res.headers['content-encoding'], undefined);
});

test('an error still reads as an error', async () => {
  /* The status has to survive the wrapping — a 401 delivered as 200 would have
     the client showing an empty screen instead of a login. */
  const saved = token;
  token = null;
  const res = await raw('/products');
  token = saved;

  assert.equal(res.status, 401);
});

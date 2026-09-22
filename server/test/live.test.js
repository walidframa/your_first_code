/**
 * The other PC hears about it.
 *
 * A sale on one counter used to leave the second counter's register showing
 * the phone still on the shelf until somebody pressed F5. Now the server keeps
 * a stream open to every screen and says, after each change, which part of the
 * shop moved — and says which screen did it, so that one can ignore itself.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4700;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;

async function req(method, route, body, headers = {}) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* Some responses carry no body. */
  }
  return { status: res.status, json };
}

/** Open the stream and hand back a way to wait for the next event on it. */
async function listen() {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/live?token=${encodeURIComponent(token)}`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  /* One read in flight at a time: a read abandoned to a timeout would still
     consume the chunk, and the event in it would be lost. */
  let pending = null;
  async function next(timeout = 5000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (events.length) return events.shift();
      if (Date.now() > deadline) throw new Error('no event arrived');
      pending ||= reader.read().finally(() => {
        pending = null;
      });
      const { value, done } = await Promise.race([
        pending,
        new Promise((r) => setTimeout(() => r({ value: null, done: false }), 250)),
      ]);
      if (done) throw new Error('stream closed');
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
        }
      }
    }
  }
  return { next, close: () => controller.abort() };
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-live-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'live-secret-long-enough-for-the-production-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };
  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('the stream needs a login', async () => {
  const res = await fetch(`${BASE}/live`);
  assert.equal(res.status, 401);
  const bad = await fetch(`${BASE}/live?token=not-a-token`);
  assert.equal(bad.status, 401);
});

test('a change on one screen is announced to the others, naming the screen that made it', async () => {
  const stream = await listen();
  try {
    const made = await req(
      'POST',
      '/products',
      { name: 'Live widget', sku: 'LIVE-1', price: 5, cost: 2, stock: 3 },
      { 'X-Client-Id': 'pc-one' },
    );
    assert.equal(made.status, 201, JSON.stringify(made.json));

    const event = await stream.next();
    assert.equal(event.topic, 'products');
    assert.equal(event.origin, 'pc-one');
    assert.ok(event.at > 0);
  } finally {
    stream.close();
  }
});

test('reading changes nothing, and a refused change says nothing', async () => {
  const stream = await listen();
  try {
    await req('GET', '/products');
    const refused = await req('POST', '/products', { name: '' });
    assert.equal(refused.status, 400);
    await assert.rejects(() => stream.next(800), /no event arrived/);

    // A real one still gets through afterwards.
    const ok = await req('POST', '/customers', { name: 'Live customer' });
    assert.equal(ok.status, 201);
    assert.equal((await stream.next()).topic, 'customers');
  } finally {
    stream.close();
  }
});

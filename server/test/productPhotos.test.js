/**
 * Finding a picture for a product from its name.
 *
 * A shop that typed nine hundred products in has nine hundred grey monograms on
 * the register, and photographing every one of them is a week nobody has. So
 * the app goes and looks — which puts it in the business of fetching addresses
 * chosen by somebody else, and most of what is checked here is about being
 * careful with that rather than about finding pictures:
 *
 *  - what it refuses to fetch, and what it refuses to keep once fetched;
 *  - what it does when a library is down, empty, or slow;
 *  - that a run over a catalogue can be stopped, and undone afterwards, because
 *    it is a machine guessing from a name and it will sometimes be wrong.
 *
 * The libraries are a stand-in on 127.0.0.1 — see fakePhotoLibrary.js — so what
 * is exercised is a real request over a real socket rather than a stubbed
 * `fetch` returning a fixed object.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePhotoLibrary, ONE_PIXEL_PNG } from './fakePhotoLibrary.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4693;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;
let library;
let libraryUrl;

async function req(method, route, body, bearer = token) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Some responses legitimately carry no body.
  }
  return { status: res.status, json };
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

/** Poll the run until it stops, rather than guessing how long it takes. */
async function waitForRun(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { json } = await req('GET', '/products/photos/run');
    if (json.run.started && !json.run.running) return json.run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('The photo run did not finish in time');
}

/** A product with no picture, which is what a run looks for. */
async function product(name, sku) {
  const { json } = await req('POST', '/products', { name, sku, price: 5, cost: 2, stock: 3 });
  return json.product;
}

/** What the form and the picker both call: a query, no product needed. */
async function search(query) {
  return req('GET', `/products/photos/search?q=${encodeURIComponent(query)}`);
}

async function setSource(patch) {
  const { status } = await req('PUT', '/settings', { photo_base_url: libraryUrl, ...patch });
  assert.equal(status, 200);
}

before(async () => {
  library = createFakePhotoLibrary();
  libraryUrl = await library.listen();

  workDir = mkdtempSync(path.join(tmpdir(), 'pos-photos-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'photos.sqlite'),
    JWT_SECRET: 'product-photos-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  await setSource({ photo_source: 'auto', photo_google_key: '', photo_google_cx: '' });
});

after(async () => {
  child?.kill();
  await library?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  library.state.searches.length = 0;
  library.state.empty.clear();
  library.state.failing.clear();
});

/* ------------------------------------------------------------------ *
 * What actually goes out
 * ------------------------------------------------------------------ */

test('the name is what gets searched for', async () => {
  const { status, json } = await search('Samsung Galaxy A54 screen protector');

  assert.equal(status, 200);
  assert.equal(json.query, 'Samsung Galaxy A54 screen protector');
  assert.ok(json.candidates.length > 0, 'a library that has one should answer');
  assert.equal(library.state.searches[0].query, 'Samsung Galaxy A54 screen protector');
});

test('a note to the counter is not part of what the thing is called', async () => {
  const { json } = await search('iPhone 14 Pro 128GB (2 left, blue) [ORD-4471]');

  assert.equal(json.query, 'iPhone 14 Pro 128GB');
  assert.ok(!library.state.searches[0].query.includes('ORD-4471'));
});

test('a long name is cut to something a search can narrow', async () => {
  const { json } = await search(
    'Heavy duty outdoor solar panel mounting bracket set for tiled roofs galvanised',
  );
  assert.equal(json.query.split(' ').length, 8);
});

test('a search with nothing to look for is refused rather than guessed at', async () => {
  const { status } = await req('GET', '/products/photos/search?q=%20%20');
  assert.equal(status, 400);
  assert.equal(library.state.searches.length, 0);
});

/*
 * A product being typed in for the first time has no id yet, and wants a
 * picture as much as one that has been on the shelf a year — so nothing here
 * needs a product to exist at all.
 */
test('a picture can be found before the product is saved', async () => {
  const { status, json } = await search('Anker charger');
  assert.equal(status, 200);
  assert.ok(json.candidates.length > 0);
});

/* ------------------------------------------------------------------ *
 * Which library, and what happens when one is not there
 * ------------------------------------------------------------------ */

test('the free libraries are asked first, and the first one to answer wins', async () => {
  const { json } = await search('Espresso machine');

  assert.equal(json.candidates[0].provider, 'Wikimedia Commons');
  // And nothing below it was troubled for an answer already found.
  assert.deepEqual(library.state.searches.map((s) => s.library), ['commons']);
});

test('a library that is down is stepped past rather than being the answer', async () => {
  library.state.failing.add('commons');
  const { json } = await search('Bicycle pump');

  assert.equal(json.candidates[0].provider, 'Wikipedia');
  assert.deepEqual(library.state.searches.map((s) => s.library), ['commons', 'wikipedia']);
  assert.equal(json.tried[0].error, '503');
});

test('a library with nothing to say is stepped past too', async () => {
  library.state.empty.add('commons');
  library.state.empty.add('wikipedia');
  const { json } = await search('Obscure widget');

  assert.match(json.candidates[0].provider, /Openverse/);
  assert.deepEqual(library.state.searches.map((s) => s.library), ['commons', 'wikipedia', 'openverse']);
});

test('nothing anywhere is an empty answer, not an error', async () => {
  for (const l of ['commons', 'wikipedia', 'openverse']) library.state.empty.add(l);
  const { status, json } = await search('Zzzz nonexistent thing');

  assert.equal(status, 200);
  assert.deepEqual(json.candidates, []);
  assert.equal(json.tried.length, 3);
});

test('Google is skipped entirely until the shop puts its own key in', async () => {
  await search('Anker power bank');
  assert.ok(!library.state.searches.some((s) => s.library === 'google'));

  await setSource({ photo_google_key: 'shop-key', photo_google_cx: 'shop-engine' });
  library.state.searches.length = 0;

  const { json } = await search('Anker power bank 20000');

  assert.equal(library.state.searches[0].library, 'google', 'asked first once it is configured');
  assert.equal(library.state.searches[0].key, 'shop-key');
  assert.equal(library.state.searches[0].cx, 'shop-engine');
  assert.match(json.candidates[0].provider, /^Google/);

  await setSource({ photo_google_key: '', photo_google_cx: '' });
});

test("the shop's key never comes back to the browser", async () => {
  await setSource({ photo_google_key: 'shop-key', photo_google_cx: 'shop-engine' });
  const { json } = await req('GET', '/settings');
  assert.notEqual(json.settings.photo_google_key, 'shop-key');
  // The engine id is not a secret and is wanted on screen, so it does come back.
  assert.equal(json.settings.photo_google_cx, 'shop-engine');
  await setSource({ photo_google_key: '', photo_google_cx: '' });
});

test('one library can be pinned instead of walking them all', async () => {
  await setSource({ photo_source: 'openverse' });
  await search('Ceramic mug');

  assert.deepEqual(library.state.searches.map((s) => s.library), ['openverse']);
  await setSource({ photo_source: 'auto' });
});

/* ------------------------------------------------------------------ *
 * Keeping one
 * ------------------------------------------------------------------ */

test('what comes back is the picture, not the link', async () => {
  const { json: found } = await search('Wall clock');

  const { status, json } = await req('POST', '/products/photos/fetch', found.candidates[0]);
  assert.equal(status, 200);
  assert.match(json.image_url, /^data:image\/png;base64,/);
  assert.equal(json.byteSize, ONE_PIXEL_PNG.length);

  // And once saved it is on the product for every register that loads it, with
  // no second request to anywhere.
  const p = await product('Wall clock', 'CLK-1');
  await req('PUT', `/products/${p.id}`, {
    image_url: json.image_url,
    image_source: json.image_source,
  });
  const { json: after } = await req('GET', `/products/${p.id}`);
  assert.equal(after.product.image_url, json.image_url);
});

test('where it came from comes back with it', async () => {
  const { json: found } = await search('Desk lamp');
  const { json } = await req('POST', '/products/photos/fetch', found.candidates[0]);

  assert.match(json.image_source, /Wikimedia Commons/);
  assert.match(json.image_source, /CC BY-SA 4\.0/, 'the licence a shop has to credit');
  assert.match(json.image_source, /wiki\/File:/, 'and the page it is on');
});

test('a run writes down where each picture came from', async () => {
  const p = await product('Bedside table', 'TBL-1');
  await req('POST', '/products/photos/run', {});
  await waitForRun();

  const { json } = await req('GET', `/products/${p.id}`);
  assert.match(json.product.image_source, /Wikimedia Commons/);
  assert.match(json.product.image_source, /CC BY-SA 4\.0/);
  await req('POST', '/products/photos/run/undo', {});
});

test('a picture too big for a tile is refused rather than stored', async () => {
  const { status, json } = await req('POST', '/products/photos/fetch', {
    url: `${libraryUrl}/img/big.png`,
    provider: 'Wikimedia Commons',
  });

  assert.equal(status, 422);
  assert.match(json.error, /too big/);
});

test('a link that answers with a web page is not a picture', async () => {
  const { status, json } = await req('POST', '/products/photos/fetch', {
    url: `${libraryUrl}/img/notreally.png`,
  });

  assert.equal(status, 422);
  assert.match(json.error, /not a picture/i);
});

test('a link that has moved is said plainly', async () => {
  const { status, json } = await req('POST', '/products/photos/fetch', {
    url: `${libraryUrl}/img/gone.png`,
  });

  assert.equal(status, 422);
  assert.match(json.error, /404/);
});

test('only web addresses are fetched at all', async () => {
  const { status, json } = await req('POST', '/products/photos/fetch', {
    url: 'file:///etc/passwd',
  });

  assert.equal(status, 422);
  assert.match(json.error, /web addresses/);
});

test('a cashier cannot go changing what the catalogue looks like', async () => {
  const cashier = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' }))
    .json.token;

  const looked = await req('GET', '/products/photos/search?q=anything', null, cashier);
  assert.equal(looked.status, 403);

  const run = await req('POST', '/products/photos/run', {}, cashier);
  assert.equal(run.status, 403);
});

/* ------------------------------------------------------------------ *
 * Doing the whole catalogue
 * ------------------------------------------------------------------ */

test('a run fills in everything that was grey, and says what it did', async () => {
  const pending = (await req('GET', '/products/photos/pending')).json.pending;
  assert.ok(pending > 0, 'the seeded catalogue has products without pictures');

  const started = await req('POST', '/products/photos/run', {});
  assert.equal(started.status, 202);

  const run = await waitForRun();
  assert.equal(run.total, pending);
  assert.equal(run.done, pending);
  assert.equal(run.found, pending);
  assert.equal(run.missed, 0);

  // And nothing is left grey.
  assert.equal((await req('GET', '/products/photos/pending')).json.pending, 0);
});

test('the run can be put back, and puts back what was there before', async () => {
  // One product keeps a picture the shop chose itself, to prove undo restores
  // rather than merely blanks.
  const mine = await product('Hand-photographed thing', 'MINE-1');
  await req('PUT', `/products/${mine.id}`, { image_url: 'data:image/png;base64,MINE' });

  const fresh = await product('Never seen before', 'NEW-1');

  const started = await req('POST', '/products/photos/run', {});
  assert.equal(started.status, 202);
  const run = await waitForRun();
  assert.equal(run.found, 1, 'only the product without a picture was looked at');

  const before = (await req('GET', `/products/${mine.id}`)).json.product.image_url;
  assert.equal(before, 'data:image/png;base64,MINE', 'the shop\'s own picture was never touched');

  const undone = await req('POST', '/products/photos/run/undo', {});
  assert.equal(undone.json.undone, 1);

  const { json } = await req('GET', `/products/${fresh.id}`);
  assert.ok(!json.product.image_url, 'back to grey');
  assert.ok(!json.product.image_source);
});

test('one row of a run can be put back on its own', async () => {
  const a = await product('Row one', 'ROW-1');
  const b = await product('Row two', 'ROW-2');

  await req('POST', '/products/photos/run', {});
  const run = await waitForRun();
  /* At least these two — an earlier test's undo may have left others grey. */
  assert.ok(run.found >= 2, `expected both to be found, got ${run.found}`);

  await req('POST', '/products/photos/run/undo', { productId: a.id });

  assert.ok(!(await req('GET', `/products/${a.id}`)).json.product.image_url);
  assert.ok((await req('GET', `/products/${b.id}`)).json.product.image_url, 'the other one stays');

  await req('POST', '/products/photos/run/undo', {});
});

test('a product no library has heard of is a miss, and does not stop the rest', async () => {
  library.state.empty.add('commons');
  library.state.empty.add('wikipedia');
  library.state.empty.add('openverse');

  await product('Nothing findable', 'MISS-1');
  await req('POST', '/products/photos/run', {});
  const run = await waitForRun();

  assert.ok(run.missed >= 1);
  assert.equal(run.missed, run.total, 'every one of them came back empty');
  assert.equal(run.found, 0);
  assert.equal(run.failed, 0, 'finding nothing is not a failure');
});

test('two runs at once are refused rather than racing each other', async () => {
  for (let i = 0; i < 6; i += 1) await product(`Queue filler ${i}`, `Q-${i}`);

  const first = await req('POST', '/products/photos/run', {});
  assert.equal(first.status, 202);

  const second = await req('POST', '/products/photos/run', {});
  assert.equal(second.status, 409);
  assert.match(second.json.error, /already running/);

  await waitForRun();
  await req('POST', '/products/photos/run/undo', {});
});

test('a run with nothing to do says so instead of starting', async () => {
  // Everything has a picture by now — anything left is put right first.
  await req('POST', '/products/photos/run', {});
  await waitForRun();

  const { status, json } = await req('POST', '/products/photos/run', {});
  assert.equal(status, 409);
  assert.match(json.error, /already has a picture/);
});

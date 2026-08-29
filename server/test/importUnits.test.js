/**
 * Importing phones rather than quantities.
 *
 * A handset export is one row per physical phone: its own serial, its own
 * cost, the model repeated down the page. The claim under test is that such a
 * file lands as *products with handsets in them* rather than as five hundred
 * one-off products, and that a shop can run the same file twice without
 * doubling its stock.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4654;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;

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

/*
 * The shape a phone shop's system exports: a code per handset, the model name in
 * every row, the serial in a column called SN.
 */
const header = 'Item,#,SN,Price 1,Currency 1,Average cost,Currency,Qty,Family,Barcode';
const csv = (...lines) => [header, ...lines].join('\n');

const preview = async (text) => (await req('POST', '/imports/preview', { csv: text })).json;
const commit = async (text) => (await req('POST', '/imports/commit', { csv: text })).json;
const serialised = async () =>
  (await req('GET', '/products')).json.products.filter((p) => p.tracks_units);
const unitsOf = async (id) => (await req('GET', `/units/product/${id}`)).json.units || [];

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-imp-units-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'iu.sqlite'),
    JWT_SECRET: 'import-units-secret-long-enough-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a column called SN is recognised as the phone’s number', async () => {
  const p = await preview(csv('IPHONE 13 USED,36.1,352725352957472,400,USD,257,USD,1,CELLPHONES,'));
  assert.equal(p.serialised, true, 'the file is handsets, not quantities');
  assert.equal(p.mapping.imei, 'SN');
  assert.equal(p.missingRequired.length, 0, 'and a product code is not demanded of it');
});

test('several handsets of one model become one product, not several', async () => {
  /*
   * The failure this exists to prevent. The code column in an export like this
   * is unique per phone, so grouping by it would give a catalogue of one-off
   * items rather than a shop with three phones of one model on the shelf.
   */
  const text = csv(
    'IPHONE 14 PRO 256GB,36.11,351111111111111,900,USD,700,USD,1,CELLPHONES,',
    'IPHONE 14 PRO 256GB,36.12,352222222222222,900,USD,720,USD,1,CELLPHONES,',
    'IPHONE 14 PRO 256GB,36.13,353333333333333,900,USD,690,USD,1,CELLPHONES,',
  );

  const p = await preview(text);
  assert.equal(p.summary.models, 1, 'one model');
  assert.equal(p.summary.handsets, 3, 'three phones');
  assert.match(p.groups[0].notes.join(' '), /own code/i, 'and it says why the codes were not kept');

  const done = await commit(text);
  assert.equal(done.created, 1);
  assert.equal(done.handsets, 3);

  const [product] = (await serialised()).filter((x) => x.name === 'IPHONE 14 PRO 256GB');
  assert.ok(product, 'the model is one product');
  assert.equal(product.stock, 3, 'and its stock is the count of the phones in it');

  // Each handset kept what it actually cost, which is the whole point of
  // holding them separately.
  const costs = (await unitsOf(product.id)).map((u) => u.cost).sort();
  assert.deepEqual(costs, [690, 700, 720]);
});

test('the condition is read off the model name', async () => {
  const text = csv(
    'GALAXY S22 128GB USED,40.1,354444444444444,300,USD,200,USD,1,CELLPHONES,',
    'GALAXY S22 256GB OB,40.2,355555555555555,350,USD,250,USD,1,CELLPHONES,',
    'GALAXY S23 128GB,40.3,356666666666666,500,USD,400,USD,1,CELLPHONES,',
  );
  const p = await preview(text);
  const by = Object.fromEntries(p.groups.map((g) => [g.name, g.condition]));
  assert.equal(by['GALAXY S22 128GB USED'], 'used');
  assert.equal(by['GALAXY S22 256GB OB'], 'refurbished', 'open box is not new');
  assert.equal(by['GALAXY S23 128GB'], 'new');
});

test('the quantity column is ignored — the handsets are the stock', async () => {
  /*
   * A file that says Qty 1 on every line and also carries three lines for one
   * model is a file that can contradict itself. The phones win.
   */
  const [product] = (await serialised()).filter((x) => x.name === 'IPHONE 14 PRO 256GB');
  assert.equal(product.stock, 3, 'three rows of Qty 1 is three phones, not one');
});

test('running the same file twice does not double the stock', async () => {
  const text = csv(
    'IPHONE 14 PRO 256GB,36.11,351111111111111,900,USD,700,USD,1,CELLPHONES,',
    'IPHONE 14 PRO 256GB,36.12,352222222222222,900,USD,720,USD,1,CELLPHONES,',
  );
  const again = await commit(text);

  assert.equal(again.handsets, 0, 'nothing new was booked in');
  assert.equal(again.errors.length, 2, 'and both lines said why');
  assert.match(again.errors[0].messages.join(' '), /already in stock/i);

  const [product] = (await serialised()).filter((x) => x.name === 'IPHONE 14 PRO 256GB');
  assert.equal(product.stock, 3, 'the shelf is where it was');
});

test('a row with no serial is named, and the rest still lands', async () => {
  const text = csv(
    'PIXEL 8 128GB,50.1,357777777777777,600,USD,450,USD,1,CELLPHONES,',
    'PIXEL 8 256GB,50.2,,700,USD,520,USD,1,CELLPHONES,',
  );
  const done = await commit(text);

  assert.equal(done.handsets, 1, 'the good one came in');
  assert.equal(done.errors.length, 1, 'and the blank one is reported rather than dropped');
  assert.match(done.errors[0].messages.join(' '), /no serial/i);
  assert.equal(done.errors[0].line, 3, 'by line number, so it can be found');
});

test('a short serial is accepted — a shop’s placeholder is still its own', async () => {
  const done = await commit(csv('NOKIA 3310,60.1,123,40,USD,20,USD,1,CELLPHONES,'));
  assert.equal(done.handsets, 1);

  const [product] = (await serialised()).filter((x) => x.name === 'NOKIA 3310');
  assert.equal((await unitsOf(product.id))[0].imei, '123');
});

test('a file with no serial column still imports as plain products', async () => {
  /*
   * The change must not have turned the ordinary catalogue import into a
   * handset one for everybody else.
   */
  const text = ['name,sku,price,stock', 'Screen protector,ACC-1,5,40'].join('\n');
  const p = await preview(text);
  assert.equal(p.serialised, false);

  const done = await commit(text);
  assert.equal(done.created, 1);
  assert.equal(done.handsets, 0);

  const plain = (await req('GET', '/products')).json.products.find((x) => x.sku === 'ACC-1');
  assert.equal(plain.tracks_units, 0, 'it is a quantity, as it always was');
  assert.equal(plain.stock, 40);
});

test('importing is not open to a cashier', async () => {
  const cashier = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' }))
    .json.token;
  assert.equal((await req('POST', '/imports/commit', { csv: 'a,b' }, cashier)).status, 403);
});

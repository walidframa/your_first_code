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

test('a phone with no serial of its own comes in as a plain quantity', async () => {
  /*
   * Two different models, one with a number and one without. The second is not
   * refused: nothing else in the file claims that model is tracked by IMEI, so
   * the honest reading is a shop that has one of them and no number written
   * down. It arrives as an ordinary product with its quantity, and can be
   * switched to IMEI tracking later once the number is to hand.
   *
   * The case where a blank *is* wrong — a model whose other rows carry serials
   * — is covered above, and that one is refused by line.
   */
  const text = csv(
    'PIXEL 8 128GB,50.1,357777777777777,600,USD,450,USD,1,CELLPHONES,',
    'PIXEL 8 256GB,50.2,,700,USD,520,USD,1,CELLPHONES,',
  );
  const done = await commit(text);

  assert.equal(done.handsets, 1, 'the one with a number is a handset');
  assert.equal(done.errors.length, 0, 'and the other is not an error');

  const tracked = (await serialised()).find((x) => x.name === 'PIXEL 8 128GB');
  assert.equal(tracked.stock, 1, 'counted by handset');

  const plain = (await req('GET', '/products')).json.products.find((x) => x.sku === '50.2');
  assert.equal(plain.tracks_units, 0, 'the other is counted by the box');
  assert.equal(plain.stock, 1);
});

test('a short serial is accepted — a shop’s placeholder is still its own', async () => {
  const done = await commit(csv('NOKIA 3310,60.1,123,40,USD,20,USD,1,CELLPHONES,'));
  assert.equal(done.handsets, 1);

  const [product] = (await serialised()).filter((x) => x.name === 'NOKIA 3310');
  assert.equal((await unitsOf(product.id))[0].imei, '123');
});

test('a catalogue of phones AND accessories imports both halves', async () => {
  /*
   * The bug this closes, and it was the first thing a real export did.
   *
   * A shop's catalogue is phones and chargers in one list. The serial column
   * is blank on everything that is not a phone — so treating the whole file as
   * handsets refused every accessory in it, which is most of the file. A blank
   * serial is not a broken row; it is a row about something that does not have
   * one.
   */
  const text = csv(
    'IPHONE 15 128GB,70.1,358888888888881,1100,USD,900,USD,1,CELLPHONES,',
    'IPHONE 15 128GB,70.2,358888888888882,1100,USD,910,USD,1,CELLPHONES,',
    'USB-C CABLE 1M,70.3,,8,USD,3,USD,40,ACCESSORIES,5000111222333',
    'TEMPERED GLASS,70.4,,5,USD,1.5,USD,120,ACCESSORIES,5000111222334',
  );

  const p = await preview(text);
  assert.equal(p.serialised, true, 'there are phones in it');
  assert.equal(p.summary.handsets, 2);
  assert.equal(p.summary.models, 1);
  assert.equal(p.summary.plain, 2, 'and two things that are not phones');
  assert.equal(p.summary.error, 0, 'none of it is refused');

  const done = await commit(text);
  assert.equal(done.handsets, 2);
  assert.equal(done.errors.length, 0, JSON.stringify(done.errors));

  const cable = (await req('GET', '/products')).json.products.find((x) => x.sku === '70.3');
  assert.ok(cable, 'the cable came in');
  assert.equal(cable.tracks_units, 0, 'as a quantity, not a serialised product');
  assert.equal(cable.stock, 40, 'with the quantity the file gave it');

  const phone = (await serialised()).find((x) => x.name === 'IPHONE 15 128GB');
  assert.equal(phone.stock, 2, 'and the phones are counted by handset');
});

test('a model with some serials and one without says so rather than guessing', async () => {
  /*
   * The one case where a blank serial is still wrong: the model already has
   * phones with numbers, so a row of it with the column empty is a phone
   * somebody did not fill in — not a quantity of them. Booking it as loose
   * stock would leave a count and a shelf that disagree for ever.
   */
  const text = csv(
    'PIXEL 9 PRO,80.1,359999999999991,800,USD,600,USD,1,CELLPHONES,',
    'PIXEL 9 PRO,80.2,,800,USD,600,USD,1,CELLPHONES,',
  );
  const p = await preview(text);
  assert.equal(p.summary.handsets, 1);
  const refused = p.rows.filter((r) => r.errors.length);
  assert.equal(refused.length, 1);
  assert.match(refused[0].errors.join(' '), /needs one too/i);

  const phone = (await serialised()).find((x) => x.name === 'PIXEL 9 PRO');
  assert.equal(phone, undefined, 'nothing was written by the preview');
});

test('a file with a serial column but no serials in it is an ordinary catalogue', async () => {
  /*
   * Their export always carries the column. A month where no phones came in
   * must not turn the whole upload into a handset import with nothing in it.
   */
  const text = csv(
    'SCREEN CLEANER,90.1,,4,USD,1,USD,60,ACCESSORIES,',
    'CAR CHARGER,90.2,,12,USD,6,USD,25,ACCESSORIES,',
  );
  const p = await preview(text);
  assert.equal(p.serialised, false, 'an empty column is not a file of phones');
  assert.equal(p.summary.error, 0);

  const done = await commit(text);
  assert.equal(done.created, 2);
  assert.equal(done.handsets, 0);
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

test('a big file says what it comes to, and where the rest of it went', async () => {
  /*
   * The complaint this answers, said in the shop's own words: "I imported a
   * 500 product excel sheet and the app reads 97 only."
   *
   * Both readings of that are possible from the same screen. Five hundred
   * handsets of ninety-seven models really are ninety-seven products, and that
   * is right. Five hundred rows of which four hundred were refused is also
   * ninety-seven products, and that is a broken import. The preview used to
   * show one number for both, with a table capped at a hundred rows — so if
   * the trouble started at line 300 there was nothing on screen that even
   * hinted at it.
   *
   * So the file is made to do both at once, past the cap, and the preview has
   * to account for every line of it.
   */
  const lines = [];
  // 12 models, 20 handsets each: 240 rows that legitimately become 12 products.
  for (let model = 0; model < 12; model += 1) {
    for (let n = 0; n < 20; n += 1) {
      const serial = `3612${String(model).padStart(2, '0')}${String(n).padStart(2, '0')}00000`;
      lines.push(`BULK PHONE ${model},99.${model}.${n},${serial},500,USD,400,USD,1,CELLPHONES,`);
    }
  }
  // And 10 accessories with the price column empty, all of them past row 100.
  for (let n = 0; n < 10; n += 1) {
    lines.push(`BULK CABLE ${n},98.${n},,,USD,1,USD,5,ACCESSORIES,`);
  }

  const p = await preview(csv(...lines));

  assert.equal(p.summary.total, 250, 'every line of the file was read');
  assert.equal(p.rows.length, 100, 'the table is still capped');
  assert.equal(p.truncated, true);

  assert.equal(p.summary.products, 12, 'and it comes to twelve products');
  assert.equal(p.summary.handsets, 240, 'holding two hundred and forty phones');
  assert.equal(p.summary.models, 12);

  /*
   * The part the cap used to hide. The refused rows are lines 242 to 251 —
   * nowhere near the hundred rows the table can show — so the count and the
   * line numbers have to come back in the summary or they do not come back
   * at all.
   */
  const missingPrice = p.summary.reasons.find((r) => /price/i.test(r.message));
  assert.ok(missingPrice, `no reason given: ${JSON.stringify(p.summary.reasons)}`);
  assert.equal(missingPrice.count, 10, 'all ten, not just the ones in the table');
  assert.ok(
    missingPrice.lines.every((line) => line > 100),
    `the lines are past the cap: ${missingPrice.lines.join(', ')}`,
  );
  assert.equal(p.summary.error, 10);
});

test('a plain catalogue counts its products the same way', async () => {
  /*
   * `products` has to mean the same thing on both paths, or the sentence the
   * review screen writes with it is only true half the time.
   */
  const text = [
    'name,sku,price,stock',
    'Counted A,CNT-1,5,10',
    'Counted B,CNT-2,6,10',
    'Counted C,CNT-3,,10',
  ].join('\n');

  const p = await preview(text);
  assert.equal(p.summary.total, 3);
  assert.equal(p.summary.products, 2, 'the one with no price is not a product');
  assert.equal(p.summary.reasons[0].count, 1);
});

test('importing is not open to a cashier', async () => {
  const cashier = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' }))
    .json.token;
  assert.equal((await req('POST', '/imports/commit', { csv: 'a,b' }, cashier)).status, 403);
});

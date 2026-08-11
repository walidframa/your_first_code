/**
 * Importing a spreadsheet.
 *
 * A supplier sends a price list as Excel, and telling a shopkeeper to save it
 * as CSV is where the damage happens — Excel's own export is what turns a
 * 13-digit barcode into 1.23457E+12. So the file is read as it came, and the
 * things worth testing are the ones that quietly corrupt a catalogue: barcodes
 * losing precision, a gap shifting every later column one to the left, and a
 * price in pounds landing in a dollar field.
 *
 * The fixture is built by server/test/fixtures/make-xlsx.py, by hand, so that a
 * pass means a real Excel container round-tripped rather than that two halves
 * of the same library agree.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook, sheetToRecords } from '../src/lib/xlsx.js';
import { buildMapping, detectFormat } from '../src/lib/importFormats.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.dirname(here);
const FIXTURE = path.join(here, 'fixtures', 'supplier-catalogue.xlsx');
const PORT = 4608;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;

async function req(method, route, body, token) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

const workbookBase64 = () => readFileSync(FIXTURE).toString('base64');

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-xlsx-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'xlsx.sqlite'),
    JWT_SECRET: 'xlsx-test-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ reader */

test('a real Excel file opens, with its sheets in the order of the tabs', () => {
  const { sheets } = readWorkbook(readFileSync(FIXTURE));
  assert.deepEqual(
    sheets.map((s) => s.name),
    ['Notes', 'Price list'],
    'named and ordered as the workbook lists them, not as the files are numbered',
  );
});

test('a long barcode survives, digit for digit', () => {
  const { sheets } = readWorkbook(readFileSync(FIXTURE));
  const { records } = sheetToRecords(sheets[1].rows);

  /*
   * The whole reason for reading the file rather than asking for a CSV. Saved
   * out of Excel this arrives as 6.29104E+12 and every one of them is ruined.
   */
  assert.equal(records[0].Barcode, '6291041500213');
  assert.equal(records[2].Barcode, '8806095571584');
});

test('the header is the row of column names, not the title above it', () => {
  const { sheets } = readWorkbook(readFileSync(FIXTURE));
  const { headers, records } = sheetToRecords(sheets[1].rows);

  assert.equal(headers[0], 'Item Name', 'not “Al Rayan Trading — August price list”');
  assert.equal(records.length, 3, 'and the title and the blank rows are not products');
});

test('an empty cell leaves a hole rather than shifting the row', () => {
  const { sheets } = readWorkbook(readFileSync(FIXTURE));
  const { records } = sheetToRecords(sheets[1].rows);

  // The screen protector has no cost. Read positionally, its quantity would
  // land in the cost column and every value after it would be wrong.
  const protector = records.find((r) => r.Code === 'SCR-02');
  assert.equal(protector['Our Cost'], '');
  assert.equal(protector.Qty, '25');
  assert.equal(protector.Group, 'Accessories');
});

test('text edited in pieces comes back whole, and accents survive', () => {
  const { sheets } = readWorkbook(readFileSync(FIXTURE));
  const { records } = sheetToRecords(sheets[1].rows);

  // Stored as two runs because half of it was formatted differently.
  assert.equal(records[0]['Item Name'], 'Braided USB-C cable');
  assert.equal(records[1]['Item Name'], 'Café screen protector');
});

test('two columns with the same name both survive, so either can be mapped', () => {
  // A real till export has "Price 1 / Currency 1 … Discount 1 / Currency 1".
  const rows = [
    ['Item', 'Price', 'Currency', 'Discount', 'Currency'],
    ['Cable', '3', 'USD', '0', 'USD'],
  ];
  const { headers } = sheetToRecords(rows);
  assert.deepEqual(headers, ['Item', 'Price', 'Currency', 'Discount', 'Currency (2)']);
});

test('a file that is not a spreadsheet says so, rather than throwing something cryptic', () => {
  assert.throws(() => readWorkbook(Buffer.from('name,sku,price\nCable,C1,3')), /not a spreadsheet/i);
});

test('an old .xls is named for what it is, with what to do about it', () => {
  // The OLE compound-document signature every .xls starts with.
  const ole = Buffer.alloc(64);
  ole.writeUInt32BE(0xd0cf_11e0, 0);
  assert.throws(() => readWorkbook(ole), /save it as \.xlsx/i);
});

/* ------------------------------------------------------------------ import */

test('a spreadsheet can be previewed and committed like a CSV', async () => {
  const preview = await req(
    'POST',
    '/imports/preview',
    { workbook: workbookBase64(), sheet: 'Price list' },
    adminToken,
  );

  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.sheet, 'Price list');
  assert.deepEqual(
    preview.json.sheets.map((s) => s.name),
    ['Notes', 'Price list'],
    'every sheet is offered, so the shop can pick the right one',
  );
  assert.equal(preview.json.summary.total, 3);

  const committed = await req(
    'POST',
    '/imports/commit',
    { workbook: workbookBase64(), sheet: 'Price list' },
    adminToken,
  );
  assert.equal(committed.status, 200, JSON.stringify(committed.json));
  assert.equal(committed.json.created, 3);

  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const cable = products.find((p) => p.sku === 'CBL-01');
  assert.equal(cable.name, 'Braided USB-C cable');
  assert.equal(cable.price, 3.5);
  assert.equal(cable.stock, 40);
  assert.equal(cable.barcode, '6291041500213', 'the barcode reached the catalogue intact');
});

test('the sheet is chosen by name, and a wrong one is said plainly', async () => {
  const res = await req(
    'POST',
    '/imports/preview',
    { workbook: workbookBase64(), sheet: 'Last year' },
    adminToken,
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /no sheet called/i);
});

test('with no sheet named, the first one with rows in it is read', async () => {
  // Not literally the first tab: "Notes" is one line of prose and choosing it
  // would show the shop an empty preview of a file that is plainly not empty.
  const res = await req('POST', '/imports/preview', { workbook: workbookBase64() }, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.json.sheet, 'Notes', 'the first sheet that has any rows at all');
});

test('uploading neither a CSV nor a workbook is refused', async () => {
  const res = await req('POST', '/imports/preview', { format: 'generic' }, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /CSV or an Excel file/i);
});

/* ---------------------------------------------------------------- currency */

test('a till export that prices in two currencies is recognised', () => {
  const headers = ['Type', '#', 'Barcode', 'Family', 'Item', 'Qty', 'Price 1', 'Currency 1', 'Average cost', 'Currency'];
  assert.equal(detectFormat(headers), 'lebanese_items');

  const mapping = buildMapping(headers, 'lebanese_items');
  assert.equal(mapping.name, 'Item');
  assert.equal(mapping.sku, '#', 'the shop’s own item number, which is always there');
  assert.equal(mapping.price, 'Price 1');
  assert.equal(mapping.currency, 'Currency 1', 'and the column saying what that price is in');
  assert.equal(mapping.category, 'Family');
});

test('a price in pounds is converted, not imported as dollars', async () => {
  const rate = (await req('GET', '/settings', null, adminToken)).json.settings.exchange_rate;

  const csv = [
    'Item,#,Price 1,Currency 1,Qty,Barcode',
    'Power cable trio,IT-900,300000,LBP,3,5001000254009',
    'Braided cable,IT-901,3.5,USD,10,5001000254016',
  ].join('\n');

  const preview = await req('POST', '/imports/preview', { csv }, adminToken);
  assert.equal(preview.status, 200, JSON.stringify(preview.json));

  const pounds = preview.json.rows.find((r) => r.data.sku === 'IT-900');
  const dollars = preview.json.rows.find((r) => r.data.sku === 'IT-901');

  /*
   * The failure this exists to prevent: left alone, a 300,000 LL cable is a
   * $300,000 cable, and nobody reading a preview of five hundred rows catches
   * it. It surfaces at the till, with a customer waiting.
   */
  assert.equal(pounds.data.price, Math.round((300_000 / rate) * 100) / 100);
  assert.ok(pounds.data.price < 20, 'a cable, not a car');
  assert.match(pounds.notes.join(' '), /300,000 LL/, 'and the preview says what it did');

  assert.equal(dollars.data.price, 3.5, 'a dollar row is left exactly alone');
  assert.deepEqual(dollars.notes, []);

  assert.equal(preview.json.summary.converted, 1);
  assert.equal(preview.json.rate, rate);
});

test('with no currency column at all, everything is dollars', async () => {
  const csv = 'name,sku,price\nPlain cable,PLAIN-1,4.25';
  const res = await req('POST', '/imports/preview', { csv }, adminToken);

  assert.equal(res.json.rows[0].data.price, 4.25);
  assert.equal(res.json.summary.converted, 0);
});

/* -------------------------------------------------------------- categories */

/*
 * Categories could be made but never unmade, so a shop a year in has
 * "Accessories", "accessories" and "Acessories" and no way to tidy them.
 * Renaming is the fix for most of that and it is safe — a product points at the
 * row, not at the word.
 */

test('a category can be created, renamed, and its products follow', async () => {
  const made = (await req('POST', '/products/categories', { name: 'Chargrs' }, adminToken)).json.category;

  const product = (
    await req(
      'POST',
      '/products',
      { name: 'Fast charger', sku: 'CAT-1', price: 12, category_id: made.id },
      adminToken,
    )
  ).json.product;

  const renamed = await req('PATCH', `/products/categories/${made.id}`, { name: 'Chargers' }, adminToken);
  assert.equal(renamed.status, 200);

  const after = (await req('GET', '/products', null, adminToken)).json.products.find(
    (p) => p.id === product.id,
  );
  assert.equal(after.category_name, 'Chargers', 'the product followed without being touched');
});

test('the list says how many products are on each shelf', async () => {
  const categories = (await req('GET', '/products/categories', null, adminToken)).json.categories;
  const chargers = categories.find((c) => c.name === 'Chargers');
  assert.equal(chargers.product_count, 1);
});

test('renaming onto a name already taken is refused rather than merging', async () => {
  const other = (await req('POST', '/products/categories', { name: 'Cases' }, adminToken)).json.category;
  const res = await req('PATCH', `/products/categories/${other.id}`, { name: 'Chargers' }, adminToken);

  assert.equal(res.status, 409);
  assert.match(res.json.error, /already a category called/i);
});

test('deleting a category that still holds products asks first', async () => {
  const chargers = (await req('GET', '/products/categories', null, adminToken)).json.categories.find(
    (c) => c.name === 'Chargers',
  );

  const refused = await req('DELETE', `/products/categories/${chargers.id}`, null, adminToken);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.productCount, 1, 'and says how many, so the question can be answered');

  // Still there, and still holding what it held.
  assert.ok(
    (await req('GET', '/products/categories', null, adminToken)).json.categories.some(
      (c) => c.id === chargers.id,
    ),
  );
});

test('deleting it anyway leaves the products, uncategorised', async () => {
  const chargers = (await req('GET', '/products/categories', null, adminToken)).json.categories.find(
    (c) => c.name === 'Chargers',
  );

  const gone = await req('DELETE', `/products/categories/${chargers.id}?force=true`, null, adminToken);
  assert.equal(gone.status, 200);
  assert.equal(gone.json.uncategorised, 1);

  /*
   * The part that matters. A shop deleting a category must not lose the
   * products on it — they keep selling, they simply have no category.
   */
  const products = (await req('GET', '/products', null, adminToken)).json.products;
  const charger = products.find((p) => p.sku === 'CAT-1');
  assert.ok(charger, 'the product survived');
  assert.equal(charger.category_id, null);
});

test('an empty category goes without ceremony', async () => {
  const spare = (await req('POST', '/products/categories', { name: 'Spare' }, adminToken)).json.category;
  const res = await req('DELETE', `/products/categories/${spare.id}`, null, adminToken);

  assert.equal(res.status, 200);
  assert.equal(res.json.uncategorised, 0);
});

test('a cashier cannot reorganise the catalogue', async () => {
  const cashier = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' })).json
    .token;
  const cases = (await req('GET', '/products/categories', null, adminToken)).json.categories.find(
    (c) => c.name === 'Cases',
  );

  assert.equal((await req('POST', '/products/categories', { name: 'Nope' }, cashier)).status, 403);
  assert.equal(
    (await req('PATCH', `/products/categories/${cases.id}`, { name: 'Nope' }, cashier)).status,
    403,
  );
  assert.equal((await req('DELETE', `/products/categories/${cases.id}`, null, cashier)).status, 403);
});

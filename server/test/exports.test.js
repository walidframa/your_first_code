/**
 * A list, handed back as a file.
 *
 * The products page and the two contact pages can be taken away as Excel or
 * as a PDF, with the columns the owner ticked. The spreadsheet is read back
 * with the shop's own reader, which is the one check that matters: a file
 * that our importer can open is a file Excel can open.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook } from '../src/lib/xlsx.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4701;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;

async function post(route, body, auth = token) {
  return fetch(BASE + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-exports-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'shop.sqlite'),
    JWT_SECRET: 'exports-secret-long-enough-for-the-production-guard',
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
  const login = await post('/auth/login', { username: 'admin', password: 'admin123' }, null);
  token = (await login.json()).token;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const table = {
  name: 'Products',
  title: 'Products',
  subtitle: 'Bakery · in stock',
  columns: [
    { label: 'Name' },
    { label: 'Barcode' },
    { label: 'Stock', align: 'right' },
    { label: 'Price (USD)', align: 'right' },
  ],
  rows: [
    ['Bagel', '6291234567890', 45, 2.75],
    ['Croissant & tea', '0005', 0, 3],
    ['كعكة', '', 7, 1.5],
  ],
};

test('the spreadsheet is a real one, and our own reader can open it', async () => {
  const res = await post('/exports/xlsx', table);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  assert.match(res.headers.get('content-disposition'), /Products\.xlsx/);

  const file = Buffer.from(await res.arrayBuffer());
  assert.equal(file.subarray(0, 2).toString('latin1'), 'PK', 'a zip, as every .xlsx is');

  const book = readWorkbook(file);
  assert.equal(book.sheets[0].name, 'Products');
  const flat = book.sheets[0].rows;
  assert.deepEqual(flat[0].slice(0, 4).map(String), ['Name', 'Barcode', 'Stock', 'Price (USD)']);
  assert.equal(String(flat[1][0]), 'Bagel');
  // The barcode is text, not a number Excel would turn into 6.29123E+12.
  assert.equal(String(flat[1][1]), '6291234567890');
  assert.equal(Number(flat[1][2]), 45);
  assert.equal(String(flat[2][0]), 'Croissant & tea', 'the ampersand survives the XML');
  assert.equal(String(flat[3][0]), 'كعكة', 'Arabic survives too');
});

test('the PDF is a real one, and says when a name could not be drawn', async () => {
  const res = await post('/exports/pdf', table);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const file = Buffer.from(await res.arrayBuffer());
  assert.equal(file.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal(res.headers.get('x-unsupported-text'), '1', 'the Arabic row could not be drawn');

  const latin = await post('/exports/pdf', { ...table, rows: table.rows.slice(0, 2) });
  assert.equal(latin.headers.get('x-unsupported-text'), '0');
});

test('no columns, no login, or too much is refused', async () => {
  assert.equal((await post('/exports/xlsx', { ...table, columns: [] })).status, 400);
  assert.equal((await post('/exports/xlsx', table, null)).status, 401);
  const huge = { ...table, rows: Array.from({ length: 20001 }, () => ['x', '', 0, 0]) };
  assert.equal((await post('/exports/xlsx', huge)).status, 400);
});

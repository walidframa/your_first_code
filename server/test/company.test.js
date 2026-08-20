/**
 * The shop's own details.
 *
 * These end up on every piece of paper a customer keeps, which makes two things
 * worth testing: that they can be set and read back, and that the two ways this
 * could go wrong are refused — an empty name, which prints a receipt nobody can
 * bring back, and a logo big enough to make every page load slow.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4605;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let cashierToken;

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

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-company-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'company.sqlite'),
    JWT_SECRET: 'company-test-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  cashierToken = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' })).json
    .token;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('the shop’s details save and come back', async () => {
  const res = await req(
    'PUT',
    '/settings',
    {
      company_name: 'Rami Mobile',
      company_tagline: 'Phones, accessories and repairs',
      company_phone: '03 123 456',
      company_phone2: '01 987 654',
      company_address: 'Main Street, Achrafieh\nBeirut, Lebanon',
      company_email: 'shop@example.com',
      company_tax_number: '1234567',
      receipt_footer: 'Exchange within 7 days with this receipt.',
    },
    adminToken,
  );

  assert.equal(res.status, 200);
  assert.equal(res.json.settings.company_name, 'Rami Mobile');
  assert.equal(res.json.settings.company_phone2, '01 987 654');
  assert.match(res.json.settings.company_address, /\n/, 'line breaks print as typed');
  assert.equal(res.json.settings.company_tax_number, '1234567');
});

test('the register can read them, because that is where a receipt is printed', async () => {
  const res = await req('GET', '/settings', null, cashierToken);
  assert.equal(res.status, 200);
  assert.equal(res.json.settings.company_name, 'Rami Mobile');
  assert.equal(res.json.settings.receipt_footer, 'Exchange within 7 days with this receipt.');
});

test('but only somebody with the settings permission can change them', async () => {
  const res = await req('PUT', '/settings', { company_name: 'Not My Shop' }, cashierToken);
  assert.equal(res.status, 403);

  const after = await req('GET', '/settings', null, adminToken);
  assert.equal(after.json.settings.company_name, 'Rami Mobile');
});

test('an empty company name is refused — a nameless receipt cannot be brought back', async () => {
  const res = await req('PUT', '/settings', { company_name: '   ' }, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /cannot be empty/i);
});

test('a logo too big to print is refused rather than slowing every page load', async () => {
  const huge = `data:image/png;base64,${'A'.repeat(500 * 1024)}`;
  const res = await req('PUT', '/settings', { company_logo_url: huge }, adminToken);

  assert.equal(res.status, 400);
  assert.match(res.json.error, /too big/i);
});

test('a small logo is kept exactly as given, so it prints as chosen', async () => {
  // A real 1×1 PNG, which is what a data: URI from the file picker looks like.
  const tiny =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const res = await req('PUT', '/settings', { company_logo_url: tiny }, adminToken);

  assert.equal(res.status, 200);
  assert.equal(res.json.settings.company_logo_url, tiny);
});

test('setting the rate does not wipe the company details', async () => {
  const res = await req('PUT', '/settings', { exchange_rate: 90000 }, adminToken);
  assert.equal(res.json.settings.exchange_rate, 90000);
  assert.equal(res.json.settings.company_name, 'Rami Mobile', 'untouched fields stay untouched');
});

test('the cashbox report carries the shop’s name onto the page', async () => {
  await req('POST', '/cash/open', { openingUsd: 25 }, adminToken);
  const session = (await req('GET', '/cash/current', null, adminToken)).json.session;

  const report = await req('GET', `/cash/sessions/${session.id}/report`, null, adminToken);
  assert.equal(report.json.report.company.name, 'Rami Mobile');
  assert.equal(report.json.report.company.taxNumber, '1234567');

  const pdf = await fetch(`${BASE}/cash/sessions/${session.id}/report.pdf`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const text = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
  assert.match(text, /\(Rami Mobile\)/, 'a filed report with no name on it cannot be placed later');
  assert.match(text, /VAT \/ MOF: 1234567/);
});

/* ------------------------------------------------- the shop's own label */

test('a label design is saved, normalised, and read back whole', async () => {
  const res = await req(
    'PUT',
    '/settings',
    {
      label_style: { shop: true, lbp: false, priceScale: 1.6, width: 50, height: 30, mode: 'roll' },
    },
    adminToken,
  );
  assert.equal(res.status, 200);

  const style = JSON.parse(res.json.settings.label_style);
  assert.equal(style.shop, true, 'the shop wanted its name on the label');
  assert.equal(style.lbp, false);
  assert.equal(style.priceScale, 1.6);
  assert.equal(style.width, 50);
  assert.equal(style.mode, 'roll');
  // The fields it did not mention come back at their defaults rather than
  // undefined, or the label prints with three sizes missing.
  assert.equal(style.name, true);
  assert.equal(style.nameScale, 1);
});

test('a design that would print off the label is brought back into range', async () => {
  const res = await req(
    'PUT',
    '/settings',
    { label_style: { nameScale: 99, codeScale: -4, width: 9000, mode: 'telepathy', junk: 'x' } },
    adminToken,
  );

  const style = JSON.parse(res.json.settings.label_style);
  assert.equal(style.nameScale, 2, 'half to double, and no further');
  assert.equal(style.codeScale, 0.5);
  assert.equal(style.width, 210);
  assert.equal(style.mode, 'sheet', 'a mode nobody prints on is not a mode');
  assert.ok(!('junk' in style), 'anything sent is stored');
});

test('nonsense in the design is the built-in label rather than an error', async () => {
  // This row is read on every page load. A settings table somebody edited by
  // hand should give a plain label back, not a screen that will not open.
  const res = await req('PUT', '/settings', { label_style: 'not json at all' }, adminToken);
  assert.equal(res.status, 200);

  const style = JSON.parse(res.json.settings.label_style);
  assert.equal(style.shop, false);
  assert.equal(style.nameScale, 1);
});

test('the design goes back to the built-in one, and only the owner may set it', async () => {
  assert.equal((await req('PUT', '/settings', { label_style: { shop: true } }, cashierToken)).status, 403);

  const res = await req('PUT', '/settings', { label_style: null }, adminToken);
  assert.equal(res.json.settings.label_style, '', 'empty is the built-in design');
});

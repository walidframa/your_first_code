/**
 * The cashbox report.
 *
 * Two things matter here and neither is the layout. First, the report has to
 * agree with the sitting it describes — a report that rounds differently from
 * the close is worse than no report. Second, profit is behind a permission, and
 * a file that can be downloaded and forwarded is exactly where a permission
 * quietly stops applying if nobody checks.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4602;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let adminToken;
let cashierToken;
let sessionId;

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

async function raw(route, token) {
  const res = await fetch(BASE + route, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
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
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-report-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'report.sqlite'),
    JWT_SECRET: 'report-test-secret-long-enough-for-the-guard',
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

  // One whole sitting: opened with a float, a cash sale rung up, an expense out
  // of the till, then counted twenty dollars short.
  const opened = await req('POST', '/cash/open', { openingUsd: 100, openingLbp: 2_000_000 }, cashierToken);
  sessionId = opened.json.session.id;

  const item = (await req('GET', '/products/lookup?code=BEV-001', null, adminToken)).json.product;
  await req(
    'POST',
    '/orders',
    {
      items: [{ productId: item.id, quantity: 2 }],
      paymentMethod: 'cash',
      payments: [{ currency: 'USD', amount: 20 }],
    },
    cashierToken,
  );
  await req(
    'POST',
    '/cash/movements',
    { direction: 'out', amountUsd: 5, reason: 'expense', note: 'water' },
    cashierToken,
  );
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('an open sitting reports what is in the drawer now', async () => {
  const res = await req('GET', `/cash/sessions/${sessionId}/report`, null, adminToken);
  assert.equal(res.status, 200);

  const { report } = res.json;
  assert.equal(report.closed, false);
  assert.equal(report.counted, null, 'nothing has been counted yet');
  assert.equal(report.session.id, sessionId);
  assert.ok(report.movements.length >= 3, 'the float, the sale and the expense');
  assert.equal(report.movements[0].kind, 'opening_float');
  assert.equal(report.movements[0].amount_lbp, 2_000_000);
});

test('the drawer figure on the report is the sum of its own movements', async () => {
  const { report } = (await req('GET', `/cash/sessions/${sessionId}/report`, null, adminToken)).json;
  const summed = report.movements.reduce((total, m) => total + m.amount_usd, 0);
  assert.equal(Math.round(summed * 100) / 100, report.expected.usd);
});

test('profit is on the report for whoever may see profit', async () => {
  const { report } = (await req('GET', `/cash/sessions/${sessionId}/report`, null, adminToken)).json;
  assert.ok(report.profit, 'the owner opens this report for exactly this figure');
  assert.ok(report.profit.revenue > 0);
  assert.equal(
    report.profit.grossProfit,
    Math.round((report.profit.revenue - report.profit.cost) * 100) / 100,
  );
});

/*
 * Reported from a live shop: the register showed a profit while its own sales
 * list showed nothing but refunds. The figure was right — a sitting's profit is
 * the shop's whole trade over those hours, invoices included — but the panel
 * gave no way to see that, so it read as money appearing from nowhere.
 */
test('the profit figure says which counter it came from', async () => {
  const { report } = (await req('GET', `/cash/sessions/${sessionId}/report`, null, adminToken)).json;

  assert.equal(typeof report.profit.fromRegister, 'number', 'what was rung up here');
  assert.equal(typeof report.profit.fromInvoices, 'number', 'and what was invoiced elsewhere');
  assert.equal(typeof report.profit.refundedOrders, 'number', 'and what came back');

  assert.equal(
    Math.round((report.profit.fromRegister + report.profit.fromInvoices) * 100) / 100,
    report.profit.revenue,
    'the two halves account for the whole figure, or the panel explains nothing',
  );
});

test('and is absent for a cashier, on the same report of their own sitting', async () => {
  const res = await req('GET', `/cash/sessions/${sessionId}/report`, null, cashierToken);
  assert.equal(res.status, 200, 'they opened this till, so the report is theirs to read');
  assert.equal(res.json.report.profit, null, 'what the goods cost is not theirs to know');
});

test('a cashier cannot read a sitting that was never theirs', async () => {
  // A second till, opened by the owner, that the cashier never sat at.
  const account = await req(
    'POST',
    '/accounts/cash',
    { name: 'Back office safe', kind: 'safe' },
    adminToken,
  );
  const other = await req(
    'POST',
    '/cash/open',
    { accountId: account.json.account.id, openingUsd: 50 },
    adminToken,
  );

  const res = await req('GET', `/cash/sessions/${other.json.session.id}/report`, null, cashierToken);
  assert.equal(res.status, 403);
  assert.match(res.json.error, /permission/i);
});

test('the count on the report is the count that was recorded at close', async () => {
  const closed = await req(
    'POST',
    '/cash/close',
    { countedUsd: 95, countedLbp: 2_000_000, carriedUsd: 50, note: 'twenty short' },
    cashierToken,
  );
  assert.equal(closed.status, 200);

  const { report } = (await req('GET', `/cash/sessions/${sessionId}/report`, null, adminToken)).json;
  assert.equal(report.closed, true);
  assert.equal(report.counted.usd, 95);
  assert.equal(report.difference.usd, report.session.over_short_usd);
  assert.equal(report.difference.lbp, report.session.over_short_lbp);
  assert.equal(report.session.closing_note, 'twenty short');
});

test('the two currencies are added up through the sitting’s own rate', async () => {
  const { report } = (await req('GET', `/cash/sessions/${sessionId}/report`, null, adminToken)).json;

  const expected = report.expected.usd + report.expected.lbp / report.rate;
  assert.equal(report.combined.expected, Math.round(expected * 100) / 100);
  assert.equal(
    report.combined.difference,
    Math.round((report.difference.usd + report.difference.lbp / report.rate) * 100) / 100,
    'one figure for “am I short”, while each currency is still recorded on its own',
  );
});

test('the PDF is a real file with a name a folder can be sorted by', async () => {
  const res = await raw(`/cash/sessions/${sessionId}/report.pdf`, adminToken);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.body.subarray(0, 5).toString(), '%PDF-');
  assert.ok(res.body.toString('latin1').trimEnd().endsWith('%%EOF'), 'a truncated PDF will not open');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="cashbox-.*\.pdf"/);
  assert.equal(Number(res.headers.get('content-length')), res.body.length);
});

test('the figures on the page are the figures from the report', async () => {
  const res = await raw(`/cash/sessions/${sessionId}/report.pdf`, adminToken);
  const text = res.body.toString('latin1');

  assert.match(text, /\(\$95\.00\)/, 'what was counted');
  assert.match(text, /\(Cashbox report/);
  assert.match(text, /\(Note: twenty short\)/, 'the closing note travels with it');
});

test('the downloaded PDF does not leak profit past the permission', async () => {
  const owner = await raw(`/cash/sessions/${sessionId}/report.pdf`, adminToken);
  const staff = await raw(`/cash/sessions/${sessionId}/report.pdf`, cashierToken);

  assert.equal(staff.status, 200);
  assert.match(owner.body.toString('latin1'), /\(Gross profit\)/);
  assert.doesNotMatch(
    staff.body.toString('latin1'),
    /\(Gross profit\)/,
    'a permission a download walks around is not a permission',
  );
});

test('a sitting that does not exist is a 404, not an empty report', async () => {
  const res = await req('GET', '/cash/sessions/9999/report', null, adminToken);
  assert.equal(res.status, 404);
});

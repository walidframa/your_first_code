/**
 * The shop's day, and the reports that are cut by it.
 *
 * The bug behind this file, reported from the counter: "the profit report is
 * not accurate, and the date range is not accurate either." Every timestamp in
 * this database is UTC, and every report was cutting the day at UTC midnight —
 * which in Beirut is three in the morning. A sale rung up at half past midnight
 * was filed under the day before, and the owner reading the day's takings could
 * not find it.
 *
 * So what is checked here is not the arithmetic of profit — other files do that
 * — but *which sales land in which day*, which is the thing that was wrong.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_ZONE,
  dayEndUtc,
  dayStartUtc,
  knownZone,
  shopDay,
  sqlDayShift,
  zoneOffsetMinutes,
} from '../src/lib/shopTime.js';
import { presetRange } from '../src/lib/profit.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4677;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let dbPath;
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
    /* Some responses carry no body. */
  }
  return { status: res.status, json };
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return;
    } catch {
      /* Not listening yet. */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready in time');
}

/* ------------------------------------------------------- the clock itself */

test('a zone the machine does not know falls back rather than throwing', () => {
  assert.equal(knownZone('Asia/Beirut'), 'Asia/Beirut');
  assert.equal(knownZone('Asia/Beiruit'), DEFAULT_ZONE, 'a typo must not take a shop down');
  assert.equal(knownZone(''), DEFAULT_ZONE);
  assert.equal(knownZone(null), DEFAULT_ZONE);
});

test('the offset is measured, so summer time is right without a table of dates', () => {
  const summer = new Date('2026-07-15T12:00:00Z');
  const winter = new Date('2026-01-15T12:00:00Z');
  assert.equal(zoneOffsetMinutes('Asia/Beirut', summer), 180);
  assert.equal(zoneOffsetMinutes('Asia/Beirut', winter), 120);
  assert.equal(zoneOffsetMinutes('UTC', summer), 0);
  assert.equal(zoneOffsetMinutes('America/New_York', summer), -240);
});

test('a shop-local day is the stretch of UTC it actually covers', () => {
  // Beirut in July is UTC+3, so its day starts at nine the evening before.
  assert.equal(dayStartUtc('2026-07-15', 'Asia/Beirut'), '2026-07-14 21:00:00');
  assert.equal(dayEndUtc('2026-07-15', 'Asia/Beirut'), '2026-07-15 20:59:59');

  // And in January it is UTC+2, so the same date starts an hour later.
  assert.equal(dayStartUtc('2026-01-15', 'Asia/Beirut'), '2026-01-14 22:00:00');

  // A zone the other side of Greenwich runs the other way.
  assert.equal(dayStartUtc('2026-07-15', 'America/New_York'), '2026-07-15 04:00:00');

  // And UTC is itself.
  assert.equal(dayStartUtc('2026-07-15', 'UTC'), '2026-07-15 00:00:00');
  assert.equal(dayEndUtc('2026-07-15', 'UTC'), '2026-07-15 23:59:59');
});

test('what day it is depends on where the shop is', () => {
  // Half past midnight in Beirut on the 16th is still the 15th in London.
  const lateSale = new Date('2026-07-15T21:30:00Z');
  assert.equal(shopDay(lateSale, 'Asia/Beirut'), '2026-07-16');
  assert.equal(shopDay(lateSale, 'UTC'), '2026-07-15');
});

test('SQLite is told the same offset, for grouping by day', () => {
  assert.equal(sqlDayShift('Asia/Beirut', new Date('2026-07-15T12:00:00Z')), '+180 minutes');
  assert.equal(sqlDayShift('America/New_York', new Date('2026-07-15T12:00:00Z')), '-240 minutes');
  assert.equal(sqlDayShift('UTC', new Date('2026-07-15T12:00:00Z')), '+0 minutes');
});

test('named periods are the shop’s calendar, not the server’s', () => {
  // 22:30 UTC on a Wednesday is already Thursday in Beirut.
  const now = new Date('2026-09-02T22:30:00Z');

  assert.deepEqual(presetRange('today', now, 'UTC'), { from: '2026-09-02', to: '2026-09-02' });
  assert.deepEqual(presetRange('today', now, 'Asia/Beirut'), {
    from: '2026-09-03',
    to: '2026-09-03',
  });

  // The week runs from Monday, in whichever calendar the shop keeps.
  assert.deepEqual(presetRange('week', now, 'Asia/Beirut'), {
    from: '2026-08-31',
    to: '2026-09-03',
  });

  // A month that has only just turned over somewhere and not yet elsewhere.
  const turn = new Date('2026-08-31T22:30:00Z');
  assert.deepEqual(presetRange('month', turn, 'UTC'), { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(presetRange('month', turn, 'Asia/Beirut'), {
    from: '2026-09-01',
    to: '2026-09-01',
  });

  assert.deepEqual(presetRange('year', turn, 'Asia/Beirut'), {
    from: '2026-01-01',
    to: '2026-09-01',
  });
});

test('the week and the month before this one are whole ones', () => {
  // Thursday 3 September 2026, in the shop.
  const now = new Date('2026-09-03T09:00:00Z');

  assert.deepEqual(presetRange('yesterday', now, 'UTC'), {
    from: '2026-09-02',
    to: '2026-09-02',
  });

  // This week runs Monday to today; last week is the seven days before it.
  assert.deepEqual(presetRange('week', now, 'UTC'), { from: '2026-08-31', to: '2026-09-03' });
  assert.deepEqual(presetRange('lastweek', now, 'UTC'), { from: '2026-08-24', to: '2026-08-30' });

  assert.deepEqual(presetRange('month', now, 'UTC'), { from: '2026-09-01', to: '2026-09-03' });
  assert.deepEqual(presetRange('lastmonth', now, 'UTC'), { from: '2026-08-01', to: '2026-08-31' });

  // A January date has to look back into the year before.
  const january = new Date('2026-01-05T09:00:00Z');
  assert.deepEqual(presetRange('lastmonth', january, 'UTC'), {
    from: '2025-12-01',
    to: '2025-12-31',
  });
});

/* ------------------------------------------------- and the reports it cuts */

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-zone-'));
  dbPath = path.join(workDir, 'zone.sqlite');
  const env = {
    ...process.env,
    DB_PATH: dbPath,
    JWT_SECRET: 'zone-test-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json
    .token;

  /*
   * Two sales with timestamps chosen to sit either side of UTC midnight but
   * inside one Beirut day: 21:00 UTC on the 2nd is midnight on the 3rd there.
   * Written straight into the table because the point is the timestamp, and a
   * sale rung up through the API is always stamped "now".
   */
  const item = (await req('GET', '/products/lookup?code=BEV-001', null, adminToken)).json.product;
  await req(
    'POST',
    '/orders',
    { items: [{ productId: item.id, quantity: 1 }], paymentMethod: 'card' },
    adminToken,
  );
  await req(
    'POST',
    '/orders',
    { items: [{ productId: item.id, quantity: 1 }], paymentMethod: 'card' },
    adminToken,
  );

  const db = new DatabaseSync(dbPath);
  const ids = db.prepare('SELECT id FROM orders ORDER BY id').all();
  db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run('2026-09-02 21:30:00', ids[0].id);
  db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run('2026-09-03 08:00:00', ids[1].id);
  db.close();
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a sale rung up after midnight belongs to the night it was made', async () => {
  const day = () =>
    req('GET', '/expenses/profit?from=2026-09-03&to=2026-09-03&branch=all', null, adminToken).then(
      (r) => r.json,
    );

  // On UTC — the old behaviour — half past midnight is yesterday's takings.
  await req('PUT', '/settings', { time_zone: '' }, adminToken);
  const utc = await day();
  assert.equal(utc.register.orders, 1, 'UTC keeps the late sale out of the 3rd');

  // Told where it is, the shop gets its own night back.
  await req('PUT', '/settings', { time_zone: 'Asia/Beirut' }, adminToken);
  const beirut = await day();
  assert.equal(beirut.register.orders, 2, 'the 00:30 sale belongs to the 3rd in Beirut');
  assert.equal(beirut.period.zone, 'Asia/Beirut');
});

test('the day-by-day column adds up to the total above it', async () => {
  const res = await req(
    'GET',
    '/expenses/profit?from=2026-09-01&to=2026-09-30&branch=all',
    null,
    adminToken,
  );
  const report = res.json;

  const summed = report.byDay.reduce((n, d) => Math.round((n + d.revenue) * 100) / 100, 0);
  assert.equal(summed, report.revenue, 'the days have to add up to the revenue');

  const cost = report.byDay.reduce((n, d) => Math.round((n + d.cost) * 100) / 100, 0);
  assert.equal(cost, report.cost, 'and so does the cost');

  // Both sales are one Beirut day, and the day is the shop's.
  assert.deepEqual(
    report.byDay.map((d) => d.day),
    ['2026-09-03'],
  );
});

test('a time zone nobody can resolve is refused rather than quietly ignored', async () => {
  const bad = await req('PUT', '/settings', { time_zone: 'Asia/Beiruit' }, adminToken);
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /not a time zone/i);

  // And the good one is still in place.
  const { settings } = (await req('GET', '/settings', null, adminToken)).json;
  assert.equal(settings.time_zone, 'Asia/Beirut');
});

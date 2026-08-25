/**
 * Cost centres and areas — the question a chart of accounts cannot answer.
 *
 * An account says *what* the money was: rent, sales, wages. It cannot say
 * which part of the shop it belonged to, and that is what an owner actually
 * asks — is the repair bench making money, or is the phone counter carrying
 * it? Which of the two shops pays for itself?
 *
 * The usual attempt to answer it with accounts — "Rent, Saida", "Rent,
 * Beirut", "Wages, Saida" — doubles the chart every time a branch opens and
 * still cannot report on a centre across accounts. So this is a second axis,
 * hung on the line rather than the entry, which is what lets one invoice carry
 * rent for two shops.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4648;
const BASE = `http://127.0.0.1:${PORT}/api`;

let child;
let workDir;
let token;
let chart;

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

const at = (code) => chart.find((a) => a.code === code);
let counter;
let bench;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-dimensions-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'dim.sqlite'),
    JWT_SECRET: 'dimensions-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  token = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  chart = (await req('GET', '/ledger/accounts')).json.accounts;

  counter = (await req('POST', '/ledger/cost-centres', { code: 'CTR', name: 'Phone counter' })).json.item;
  bench = (await req('POST', '/ledger/cost-centres', { code: 'RPR', name: 'Repair bench' })).json.item;
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** Post an entry with a centre on each line. */
async function post({ memo, debit, credit, amount, centre = null }) {
  return req('POST', '/ledger/entries', {
    memo,
    lines: [
      { accountId: at(debit).id, debit: amount, costCentreId: centre },
      { accountId: at(credit).id, credit: amount, costCentreId: centre },
    ],
  });
}

test('a centre is kept by code, and two cannot share one', async () => {
  assert.equal(counter.name, 'Phone counter');
  const clash = await req('POST', '/ledger/cost-centres', { code: 'CTR', name: 'Something else' });
  assert.equal(clash.status, 400);
  assert.match(clash.json.error, /already Phone counter/);
});

test('a line carries the centre it belonged to', async () => {
  const made = await post({ memo: 'Repair job', debit: '1110', credit: '4200', amount: 80, centre: bench.id });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.entry.lines[0].cost_centre_id, bench.id);
  assert.equal(made.json.entry.lines[0].cost_centre_name, 'Repair bench');
});

test('one entry can be split between two parts of the shop', async () => {
  /*
   * The reason this hangs on the line rather than the entry. One rent invoice
   * covers a shop with a counter at the front and a bench at the back, and
   * making it two entries to say so would be inventing paperwork that never
   * existed.
   */
  const made = await req('POST', '/ledger/entries', {
    memo: 'Rent, split between the two',
    lines: [
      { accountId: at('5300').id, debit: 300, costCentreId: counter.id },
      { accountId: at('5300').id, debit: 100, costCentreId: bench.id },
      { accountId: at('1110').id, credit: 400 },
    ],
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.entry.lines[0].cost_centre_id, counter.id);
  assert.equal(made.json.entry.lines[1].cost_centre_id, bench.id);
});

test('the report answers the question the chart cannot', async () => {
  await post({ memo: 'Sold a charger', debit: '1110', credit: '4100', amount: 200, centre: counter.id });

  const report = (await req('GET', '/ledger/cost-centres/performance')).json;
  const front = report.lines.find((l) => l.code === 'CTR');
  const back = report.lines.find((l) => l.code === 'RPR');

  assert.equal(front.income, 200, 'the counter earned');
  assert.equal(front.expense, 300, 'and carried three quarters of the rent');
  assert.equal(front.profit, -100, 'so it is losing money');

  assert.equal(back.income, 80, 'the bench earned less');
  assert.equal(back.expense, 100);
  assert.equal(back.profit, -20, 'and is closer to washing its face');
});

test('what nobody assigned is shown, not quietly dropped', async () => {
  /*
   * A report that leaves out the unassigned is a report whose total does not
   * match the profit figure on the next screen, and the shop is left to work
   * out which of the two lied.
   */
  await post({ memo: 'Electricity, nobody said whose', debit: '5400', credit: '1110', amount: 60 });

  const report = (await req('GET', '/ledger/cost-centres/performance')).json;
  const loose = report.lines.find((l) => l.id === null);
  assert.ok(loose, 'the unassigned has a row of its own');
  assert.equal(loose.name, 'Not assigned');
  assert.equal(loose.expense, 60);
  assert.equal(report.lines.at(-1).id, null, 'and it sits at the bottom, being a question rather than an answer');

  // The totals cover everything, which is the point.
  assert.equal(report.totals.income, 280);
  assert.equal(report.totals.expense, 460);
});

test('a centre put away keeps its history and stops being offered', async () => {
  const gone = (await req('POST', '/ledger/cost-centres', { code: 'OLD', name: 'Old stall' })).json.item;
  await post({ memo: 'Last of the stall', debit: '1110', credit: '4100', amount: 25, centre: gone.id });
  await req('DELETE', `/ledger/cost-centres/${gone.id}`);

  const report = (await req('GET', '/ledger/cost-centres/performance')).json;
  assert.ok(report.lines.find((l) => l.code === 'OLD'), 'what it earned is still on the report');

  const offered = (await req('GET', '/ledger/cost-centres?activeOnly=true')).json.items;
  assert.ok(!offered.find((c) => c.code === 'OLD'), 'but it is not offered on new entries');

  const tried = await post({ memo: 'Too late', debit: '1110', credit: '4100', amount: 5, centre: gone.id });
  assert.equal(tried.status, 400);
  assert.match(tried.json.error, /put away/);
});

test('areas are the same idea pointed at a different question', async () => {
  const saida = (await req('POST', '/ledger/areas', { code: 'SAI', name: 'Saida' })).json.item;
  assert.equal(saida.name, 'Saida');

  const made = await req('POST', '/ledger/entries', {
    memo: 'A sale in Saida',
    lines: [
      { accountId: at('1110').id, debit: 30, areaId: saida.id },
      { accountId: at('4100').id, credit: 30, areaId: saida.id },
    ],
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.entry.lines[0].area_name, 'Saida');

  const report = (await req('GET', '/ledger/areas/performance')).json;
  assert.equal(report.lines.find((l) => l.code === 'SAI').income, 30);
});

test('the till fills the area in by itself, from the branch it happened at', async () => {
  /*
   * The property that makes this worth having. An axis that only fills in when
   * somebody remembers to tick a box is an axis whose report is wrong and
   * looks right — so a branch knows its own area and everything rung up there
   * carries it for free.
   */
  const beirut = (await req('POST', '/ledger/areas', { code: 'BEI', name: 'Beirut' })).json.item;
  const branch = (await req('GET', '/branches')).json.branches[0];
  await req('PUT', `/branches/${branch.id}`, { area_id: beirut.id });

  await req('POST', '/cash/open', { openingUsd: 50 });
  const sale = await req('POST', '/orders', {
    items: [{ productId: 1, quantity: 1 }],
    paymentMethod: 'cash',
    payments: [{ currency: 'USD', amount: 10 }],
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const report = (await req('GET', '/ledger/areas/performance')).json;
  const here = report.lines.find((l) => l.code === 'BEI');
  assert.ok(here, 'the sale was filed under the branch’s own area');
  assert.ok(here.income > 0, 'and it earned there without anybody saying so');
});

test('a reversal takes the cost back off the centre it was charged to', async () => {
  const wrong = (await post({
    memo: 'Charged to the wrong bench', debit: '5400', credit: '1110', amount: 40, centre: bench.id,
  })).json.entry;

  const before = (await req('GET', '/ledger/cost-centres/performance')).json
    .lines.find((l) => l.code === 'RPR').expense;

  await req('POST', `/ledger/entries/${wrong.id}/reverse`, {});

  const after = (await req('GET', '/ledger/cost-centres/performance')).json
    .lines.find((l) => l.code === 'RPR').expense;
  assert.equal(after, before - 40, 'or the centre keeps a cost that has been taken back');
});

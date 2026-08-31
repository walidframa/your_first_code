/**
 * Moving a shop's customers and suppliers in from the system it used before.
 *
 * The catalogue could be imported and the people could not, so a shop arriving
 * with a hundred and eighty-five customers typed them in one at a time before
 * the app was any use for the thing it does most: selling on credit to people
 * it knows.
 *
 * What arrives is not a list of people. It is a chart of accounts — headings
 * above members, a party split into one ledger per currency, and the odd row
 * carrying a figure nobody has looked at since the system it came from was
 * replaced. Every test here is a shape taken from a real export.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.dirname(here);
const FIXTURE = path.join(here, 'fixtures', 'accounts-export.xlsx');
const PORT = 4675;
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

const workbook = () => readFileSync(FIXTURE).toString('base64');

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-party-import-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'parties.sqlite'),
    JWT_SECRET: 'party-import-secret-long-enough-for-the-guard',
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

const preview = (extra = {}) =>
  req('POST', '/imports/parties/preview', { partyType: 'supplier', workbook: workbook(), ...extra });

async function suppliers() {
  return (await req('GET', '/suppliers')).json.parties;
}

test('a chart of accounts is read as people, not as rows', async () => {
  const res = await preview();
  assert.equal(res.status, 200, JSON.stringify(res.json));

  /*
   * Nine rows under the header. One is the heading "Suppliers", one is an
   * account with no name, and one party is two rows — so six people come out of
   * it, and the count the shop sees has to say both numbers or it reads as
   * lines lost.
   */
  assert.equal(res.json.summary.rows, 9);
  assert.equal(res.json.summary.parties, 6);
  assert.equal(res.json.summary.skipped, 1);

  const names = res.json.parties.map((p) => p.name);
  assert.ok(!names.includes('Suppliers'), 'the heading is not a supplier');
  assert.equal(names.filter((n) => n === 'I-PICK').length, 1, 'two currency ledgers, one person');
});

test('the columns are recognised without being told', async () => {
  const { mapping } = (await preview()).json;
  assert.equal(mapping.name, 'Name');
  assert.equal(mapping.code, 'Code');
  assert.equal(mapping.balance, 'Balance');
  assert.equal(mapping.currency, 'Currency');
  // "Phone" must not have been taken by the code's own list of hints.
  assert.equal(mapping.phone, 'Phone');
});

test('the two currencies are kept apart, and the party keeps both', async () => {
  const ipick = (await preview()).json.parties.find((p) => p.name === 'I-PICK');
  /*
   * Signed the way this app signs things, which is the other way round from a
   * trial balance. A supplier the shop owes $331.41 is shown in the export as
   * −331.41 and stored here as +331.41 outstanding; left alone the shop would
   * appear to be owed money by everybody it owes.
   */
  assert.equal(ipick.usd, 331.41, 'the sign is turned over on the way in');
  assert.equal(ipick.lbp, -4291601000, 'and the pounds keep their own column');
});

test('a customer file keeps its signs, because it already agrees', async () => {
  /*
   * The flip is a supplier rule, not a currency rule. Read as customers, the
   * same figures must come through untouched — otherwise every debt would be
   * inverted by whichever screen the shop happened to import from.
   */
  const res = await req('POST', '/imports/parties/preview', {
    partyType: 'customer',
    workbook: workbook(),
  });
  const ipick = res.json.parties.find((p) => p.name === 'I-PICK');
  assert.equal(ipick.usd, -331.41);
});

test('a balance too large to be real is refused and named', async () => {
  const omt = (await preview()).json.parties.find((p) => p.name === 'OMT Lira');
  assert.equal(omt.lbp, 0, 'five point eight trillion pounds does not go into the books');
  assert.equal(omt.usd, 0);
  assert.equal(omt.problems.length, 1);
  assert.match(omt.problems[0], /too large/);
  // Imported all the same. The figure is doubted; the supplier is not.
  assert.ok(omt.name);
});

test('a currency this app does not keep is left out, and said so', async () => {
  const yuan = (await preview()).json.parties.filter((p) => p.problems.some((m) => m.includes('¥')));
  assert.equal(yuan.length, 1);
  assert.equal(yuan[0].usd, 0, 'nothing was invented at a rate nobody has');
  assert.match(yuan[0].problems[0], /dollars and pounds/);
});

test('an account with a balance and no name is not imported, and not lost either', async () => {
  const { skipped } = (await preview()).json;
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].code, '4010010001');
  assert.equal(skipped[0].usd, -129.97, 'the figure is carried into the message');
  assert.match(skipped[0].reason, /No name/);
});

test('committing creates them, with their balances on their statements', async () => {
  const res = await req('POST', '/imports/parties/commit', {
    partyType: 'supplier',
    workbook: workbook(),
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.created, 6);
  assert.equal(res.json.updated, 0);

  const all = await suppliers();
  const ipick = all.find((s) => s.name === 'I-PICK');
  assert.ok(ipick, 'the supplier is there');
  assert.equal(ipick.phone, '70001988', 'and the phone from its dollar ledger came with it');

  /*
   * Written as a line on the statement rather than a figure with nothing behind
   * it, so the shop can see where its opening position came from.
   */
  const statement = (await req('GET', `/suppliers/${ipick.id}/statement`)).json;
  const openings = statement.lines.filter((l) => l.kind === 'opening');
  assert.equal(openings.length, 1, 'one opening line');

  /*
   * And it is the two currencies added at the rate of the day, not one of them.
   * I-PICK is owed $331.41 and has been prepaid 4,291,601,000 LL, which nets
   * out the other way — an odd position, and exactly the one in the file. A
   * balance that quietly kept only the dollars would read $331 and be wrong by
   * forty-eight thousand.
   */
  const rate = (await req('GET', '/settings')).json.settings.exchange_rate;
  const expected = Math.round((331.41 + -4291601000 / rate) * 100) / 100;
  assert.equal(ipick.balance, expected);
});

test('two suppliers with the same name stay two suppliers', async () => {
  const chinas = (await suppliers()).filter((s) => s.name === 'CHINA');
  assert.equal(chinas.length, 2, 'different account codes are different accounts');
});

test('running it again updates rather than doubling', async () => {
  const before = (await suppliers()).length;

  const res = await req('POST', '/imports/parties/commit', {
    partyType: 'supplier',
    workbook: workbook(),
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.created, 0, 'everybody was found again by their old code');
  assert.equal(res.json.updated, 6);

  assert.equal((await suppliers()).length, before, 'and nobody was added twice');
});

test('and does not write the opening balance a second time', async () => {
  /*
   * The one figure in the file that is a statement about history rather than a
   * fact about the party. Adding it again on every re-run would double a
   * supplier's balance quietly, and the shop would find out from a statement
   * that no longer agreed with the supplier's own.
   */
  const ipick = (await suppliers()).find((s) => s.name === 'I-PICK');
  const statement = (await req('GET', `/suppliers/${ipick.id}/statement`)).json;
  const openings = statement.lines.filter((l) => l.kind === 'opening');
  assert.equal(openings.length, 1);
});

test('names only is a real answer', async () => {
  const res = await req('POST', '/imports/parties/commit', {
    partyType: 'customer',
    workbook: workbook(),
    withBalances: false,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.balances, 0, 'nobody was given an opening balance');
  assert.equal(res.json.created, 6, 'and everybody came in');

  const customers = (await req('GET', '/customers')).json.parties;
  const ipick = customers.find((c) => c.name === 'I-PICK');
  assert.equal(ipick.balance, 0);
});

test('a file with no name column is refused rather than half-imported', async () => {
  const res = await req('POST', '/imports/parties/commit', {
    partyType: 'supplier',
    workbook: workbook(),
    mapping: { code: 'Code', balance: 'Balance' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /name/i);
});

test('importing is not something a cashier can do', async () => {
  const cashier = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' })).json
    .token;
  const res = await req(
    'POST',
    '/imports/parties/commit',
    { partyType: 'supplier', workbook: workbook() },
    cashier,
  );
  assert.equal(res.status, 403);
});

/**
 * The people who work here, and the one balance between each of them and the shop.
 *
 * What is being checked is mostly that nothing new was invented: an employee's
 * wage, their advances and the charger they took off the shelf all land on one
 * ordinary customer account, and the answers come out of the ledger's existing
 * sign convention rather than out of a second set of rules.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4635;
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
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-employees-'));
  const env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'employees.sqlite'),
    JWT_SECRET: 'employees-test-secret-long-enough-guard',
    ACCOUNT_SECRET: 'employees-account-secret-long-enough-32',
    PORT: String(PORT),
    NODE_ENV: 'test',
    REQUIRE_CASH_SESSION: 'false',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();

  adminToken = (await req('POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  cashierToken = (await req('POST', '/auth/login', { username: 'cashier', password: 'cashier123' })).json
    .token;

  // Wages come out of a drawer, and a voucher will not move a closed one.
  await req('POST', '/cash/open', { openingUsd: 2000 }, adminToken);
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const hire = (body) => req('POST', '/employees', body, adminToken);

test('hiring somebody opens the account their pay will run through', async () => {
  const res = await hire({ name: 'Ali Haddad', jobTitle: 'Technician', monthlySalary: 600, phone: '03 55 44 33' });
  assert.equal(res.status, 201, JSON.stringify(res.json));

  const employee = res.json.employee;
  assert.ok(employee.customer_id, 'they have a customer account');
  assert.equal(employee.balance, 0);

  // And it really is in the customer list, because that is how they buy things.
  const customers = (await req('GET', '/customers', null, adminToken)).json.parties;
  const account = customers.find((c) => c.id === employee.customer_id);
  assert.equal(account.name, 'Ali Haddad');
  // The limit starts at a month's pay: what the shop can actually take back out
  // of the next payslip.
  assert.equal(account.credit_limit, 600);
});

test('wages are the owner’s business', async () => {
  const res = await req('GET', '/employees', null, cashierToken);
  assert.equal(res.status, 403);
});

test('a month’s salary is owed to them, and costs the shop', async () => {
  const employee = (await req('GET', '/employees', null, adminToken)).json.employees[0];

  const profit = () =>
    req('GET', '/expenses/profit?from=2026-01-01&to=2026-12-31', null, adminToken).then(
      (r) => r.json.expenses.total,
    );

  const before = await profit();
  const run = await req('POST', `/employees/${employee.id}/salary`, { period: '2026-03' }, adminToken);
  assert.equal(run.status, 201, JSON.stringify(run.json));

  // Negative: the shop owes them. Same sign convention as any other account.
  assert.equal(run.json.employee.balance, -600);
  assert.equal(run.json.employee.owedToThem, 600);
  assert.equal(run.json.employee.owedToShop, 0);

  /*
   * And it reaches the profit report, which a balance alone cannot do — what
   * the shop owes somebody is not a cost until it is earned.
   */
  const after = await profit();
  assert.equal(
    Math.round((after - before) * 100) / 100,
    600,
    'the wage is an expense in the month it was earned',
  );
});

test('running the same month twice does not pay anybody twice', async () => {
  const employee = (await req('GET', '/employees', null, adminToken)).json.employees[0];
  const again = await req('POST', `/employees/${employee.id}/salary`, { period: '2026-03' }, adminToken);
  assert.equal(again.status, 400);
  assert.match(again.json.error, /already been run/i);

  const now = (await req('GET', `/employees/${employee.id}`, null, adminToken)).json.employee;
  assert.equal(now.balance, -600, 'still one month, not two');
});

test('paying them moves the drawer and the balance the same way', async () => {
  const employee = (await req('GET', '/employees', null, adminToken)).json.employees[0];
  const before = (await req('GET', '/cash/current', null, adminToken)).json.expected;

  const paid = await req('POST', `/employees/${employee.id}/payments`, { amountUsd: 400 }, adminToken);
  assert.equal(paid.status, 201, JSON.stringify(paid.json));

  // A numbered slip, in the same book as every other payment out.
  assert.match(paid.json.voucher.voucher_number, /^PV-/);
  assert.equal(paid.json.voucher.reason, 'wages');
  assert.equal(paid.json.employee.owedToThem, 200, '600 earned, 400 handed over');

  const after = (await req('GET', '/cash/current', null, adminToken)).json.expected;
  assert.equal(Math.round((before.usd - after.usd) * 100) / 100, 400);
});

test('an advance before payday puts them in debt, and the wage clears it', async () => {
  const hired = (await hire({ name: 'Rana Aoun', monthlySalary: 500 })).json.employee;

  // Paid before anything is earned: they now owe the shop.
  const advance = await req('POST', `/employees/${hired.id}/payments`, { amountUsd: 150 }, adminToken);
  assert.equal(advance.status, 201, JSON.stringify(advance.json));
  assert.equal(advance.json.employee.balance, 150);
  assert.equal(advance.json.employee.owedToShop, 150);

  const run = await req('POST', `/employees/${hired.id}/salary`, { period: '2026-04' }, adminToken);
  assert.equal(run.status, 201);
  // 500 earned against 150 already taken — the advance is worked off by the
  // wage without anybody deducting anything by hand.
  assert.equal(run.json.employee.owedToThem, 350);
});

test('what they buy on account lands on the same balance', async () => {
  const hired = (await hire({ name: 'Samir Nassar', monthlySalary: 400 })).json.employee;

  const product = (
    await req('POST', '/products', { name: 'Cable', sku: 'EMP-CBL', price: 12, cost: 5 }, adminToken)
  ).json.product;
  await req('POST', '/inventory/adjust', { productId: product.id, delta: 10, reason: 'received' }, adminToken);

  const sale = await req(
    'POST',
    '/orders',
    {
      items: [{ productId: product.id, quantity: 1 }],
      paymentMethod: 'account',
      customerId: hired.customer_id,
    },
    cashierToken,
  );
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const now = (await req('GET', `/employees/${hired.id}`, null, adminToken)).json;
  assert.equal(now.employee.balance, 12, 'the cable is on their account');
  // And it shows up as an ordinary sale on their statement, not as a special
  // kind of staff purchase.
  assert.ok(now.dealings.some((d) => d.kind === 'order'));
});

test('the whole month runs at once, and skips whoever is already paid', async () => {
  const res = await req('POST', '/employees/payroll', { period: '2026-05' }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.ok(res.json.paid >= 3, 'everybody with a salary');

  const twice = await req('POST', '/employees/payroll', { period: '2026-05' }, adminToken);
  assert.equal(twice.status, 201);
  assert.equal(twice.json.paid, 0, 'nobody is paid a second time');
  assert.ok(twice.json.results.every((r) => /already been run/i.test(r.skipped)));
});

test('a month run against the wrong period can be taken back', async () => {
  const hired = (await hire({ name: 'Wrong Month', monthlySalary: 300 })).json.employee;
  await req('POST', `/employees/${hired.id}/salary`, { period: '2026-06' }, adminToken);

  const undone = await req('DELETE', `/employees/${hired.id}/salary/2026-06`, null, adminToken);
  assert.equal(undone.status, 200, JSON.stringify(undone.json));
  assert.equal(undone.json.employee.balance, 0);

  // Reversed, not erased: the account still shows it was run and taken back.
  const detail = (await req('GET', `/employees/${hired.id}`, null, adminToken)).json;
  assert.ok(detail.entries.some((e) => /reversed/i.test(e.note || '')));
  assert.equal(detail.salaries.length, 0, 'and the month is free to run again');
});

test('a month must be a month', async () => {
  const employee = (await req('GET', '/employees', null, adminToken)).json.employees[0];
  const res = await req('POST', `/employees/${employee.id}/salary`, { period: 'August' }, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.json.error, /YYYY-MM/);
});

test('somebody still owed money cannot simply be deleted', async () => {
  const hired = (await hire({ name: 'Owed Money', monthlySalary: 200 })).json.employee;
  await req('POST', `/employees/${hired.id}/salary`, { period: '2026-07' }, adminToken);

  const refused = await req('DELETE', `/employees/${hired.id}`, null, adminToken);
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /still owed/i);

  await req('POST', `/employees/${hired.id}/payments`, { amountUsd: 200 }, adminToken);
  const archived = await req('DELETE', `/employees/${hired.id}`, null, adminToken);
  assert.equal(archived.status, 200, JSON.stringify(archived.json));

  // Archived, so the ledger stays readable, and off the list by default.
  const list = (await req('GET', '/employees', null, adminToken)).json.employees;
  assert.ok(!list.some((e) => e.id === hired.id));
  const all = (await req('GET', '/employees?includeArchived=true', null, adminToken)).json.employees;
  assert.ok(all.some((e) => e.id === hired.id));
});

test('an existing customer can be hired without splitting their history', async () => {
  const customer = (
    await req('POST', '/customers', { name: 'Long Standing', creditLimit: 100 }, adminToken)
  ).json.party;
  await req('POST', `/customers/${customer.id}/charges`, { amount: 40, note: 'Old bill' }, adminToken);

  const hired = await hire({ name: 'Long Standing', customerId: customer.id, monthlySalary: 250 });
  assert.equal(hired.status, 201, JSON.stringify(hired.json));
  assert.equal(hired.json.employee.customer_id, customer.id);
  assert.equal(hired.json.employee.balance, 40, 'the old bill came with them');

  // And one account cannot belong to two people on the payroll.
  const twice = await hire({ name: 'Impostor', customerId: customer.id, monthlySalary: 100 });
  assert.equal(twice.status, 400);
  assert.match(twice.json.error, /already belongs to/i);
});

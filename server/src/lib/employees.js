/**
 * The people who work here, and the one balance between each of them and the shop.
 *
 * A shop's relationship with somebody it employs is not a special kind of thing.
 * Money goes back and forth: a wage is earned, an advance is handed over in the
 * middle of the month, a charger is taken off the shelf and put "on my account",
 * and at some point the two sides settle. That is a running balance with a
 * contact, which this app already knows how to keep — so every employee gets a
 * customer account and everything runs through it.
 *
 * The sign convention is the ledger's, unchanged:
 *
 *   balance > 0   they owe the shop   — advances taken, things bought on account
 *   balance < 0   the shop owes them  — salary earned and not yet paid
 *
 * Which means the answers fall out rather than being computed. Salary earned is
 * a negative entry, an advance is a positive one, and "what do I owe Ali on
 * payday?" is the balance with the sign turned round. Nothing needs a second
 * table of who is up and who is down, and a purchase on account lands in exactly
 * the same column as it would for any other customer — because it is the same
 * thing.
 *
 * Wages also have to reach the profit report, and a balance cannot do that: what
 * the shop owes somebody is not a cost until it is earned. So accruing a month's
 * salary writes an ordinary `wages` expense as well, which is what profit
 * already subtracts. Paying it later moves cash and the balance, and writes no
 * second expense — a wage counted when earned and again when paid would halve
 * the shop's profit on paper.
 */
import { db, transaction } from '../db.js';
import { round2 } from './currency.js';
import { addEntry, balanceOf, balanceMap } from './accounts.js';
import { addExpense, deleteExpense } from './expenses.js';
import { mainBranchId } from './stock.js';

/** `YYYY-MM`, the granularity a salary is actually agreed at. */
export function isPeriod(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
}

/** The month a date falls in, or this month. */
export function periodOf(date = new Date()) {
  return new Date(date).toISOString().slice(0, 7);
}

/** How a period reads to a person: `2026-08` → `August 2026`. */
export function periodName(period) {
  const [year, month] = String(period).split('-');
  const name = new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return name;
}

const withBalance = (row, balance) => ({
  ...row,
  active: !!row.active,
  balance,
  /*
   * The same number twice, from the two directions people ask it in. An owner
   * asks "what do I owe them?"; the ledger answers "what do they owe me?", with
   * a minus sign. Doing the flip here means no screen has to remember to.
   */
  owedToThem: round2(Math.max(0, -balance)),
  owedToShop: round2(Math.max(0, balance)),
});

export function listEmployees({ includeArchived = false } = {}) {
  const rows = db
    .prepare(
      `SELECT e.*, c.credit_limit, b.name AS branch_name, u.username
         FROM employees e
         JOIN customers c ON c.id = e.customer_id
         LEFT JOIN branches b ON b.id = e.branch_id
         LEFT JOIN users u ON u.id = e.user_id
        ${includeArchived ? '' : 'WHERE e.active = 1'}
        ORDER BY e.active DESC, e.name`,
    )
    .all();

  const balances = balanceMap('customer');
  return rows.map((r) => withBalance(r, balances.get(r.customer_id) ?? 0));
}

export function getEmployee(id) {
  const row = db
    .prepare(
      `SELECT e.*, c.credit_limit, c.phone AS account_phone, b.name AS branch_name, u.username
         FROM employees e
         JOIN customers c ON c.id = e.customer_id
         LEFT JOIN branches b ON b.id = e.branch_id
         LEFT JOIN users u ON u.id = e.user_id
        WHERE e.id = ?`,
    )
    .get(id);
  return row ? withBalance(row, balanceOf('customer', row.customer_id)) : null;
}

/** Every month already run for somebody, newest first. */
export function salariesFor(employeeId) {
  return db
    .prepare(
      `SELECT s.*, u.name AS user_name FROM employee_salaries s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.employee_id = ? ORDER BY s.period DESC`,
    )
    .all(employeeId);
}

function validate({ name, monthlySalary }) {
  if (!String(name || '').trim()) throw new Error('An employee needs a name');
  const salary = round2(Number(monthlySalary) || 0);
  if (salary < 0) throw new Error('A salary cannot be less than nothing');
  return { name: String(name).trim(), salary };
}

/**
 * Hire somebody.
 *
 * The customer account is made here rather than asked for, because an employee
 * without one is an employee whose advances have nowhere to go — and a shop
 * would have to know to create it first, which nobody would.
 *
 * An existing contact can be adopted instead (`customerId`), for the very common
 * case of somebody who has been buying here for years and has now been hired:
 * their history should not be split across two accounts.
 */
export function createEmployee(input, userId = null) {
  const { name, salary } = validate(input);

  return transaction(() => {
    let customerId = input.customerId ? Number(input.customerId) : null;

    if (customerId) {
      const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
      if (!existing) throw new Error('That customer does not exist');
      const taken = db.prepare('SELECT name FROM employees WHERE customer_id = ?').get(customerId);
      if (taken) throw new Error(`That account already belongs to ${taken.name}`);
    } else {
      const info = db
        .prepare(
          `INSERT INTO customers (name, phone, notes, credit_limit)
           VALUES (?, ?, 'Staff account', ?)`,
        )
        .run(
          name,
          input.phone?.trim() || null,
          /*
           * A month's pay, as the starting limit. It is the figure the shop can
           * actually take back out of the next payslip, so it is the honest
           * answer to "how much may they put on account?" — and it can be
           * changed on the customers screen like anybody else's.
           */
          salary,
        );
      customerId = Number(info.lastInsertRowid);
    }

    const info = db
      .prepare(
        `INSERT INTO employees
           (customer_id, user_id, name, phone, job_title, monthly_salary, started_on, branch_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        customerId,
        input.userId ? Number(input.userId) : null,
        name,
        input.phone?.trim() || null,
        input.jobTitle?.trim() || null,
        salary,
        input.startedOn || null,
        input.branchId ?? null,
        input.note?.trim() || null,
      );

    const employeeId = Number(info.lastInsertRowid);

    // What they were already owed, or already owed the shop, on the day the
    // shop started keeping this book. Same idea as a customer's opening balance.
    const opening = round2(Number(input.openingBalance) || 0);
    if (opening !== 0) {
      addEntry({
        partyType: 'customer',
        partyId: customerId,
        kind: 'opening',
        amountUsd: opening,
        note: `Opening balance — ${name}`,
        userId,
      });
    }

    return getEmployee(employeeId);
  })();
}

export function updateEmployee(id, input) {
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (!employee) throw new Error('That employee does not exist');

  const merged = { ...employee };
  const map = {
    name: 'name',
    phone: 'phone',
    jobTitle: 'job_title',
    monthlySalary: 'monthly_salary',
    startedOn: 'started_on',
    branchId: 'branch_id',
    note: 'note',
    active: 'active',
    userId: 'user_id',
  };
  for (const [from, column] of Object.entries(map)) {
    if (input[from] !== undefined) merged[column] = input[from];
  }

  const { name, salary } = validate({ name: merged.name, monthlySalary: merged.monthly_salary });

  return transaction(() => {
    db.prepare(
      `UPDATE employees
         SET name = ?, phone = ?, job_title = ?, monthly_salary = ?, started_on = ?,
             branch_id = ?, note = ?, active = ?, user_id = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      name,
      merged.phone?.trim?.() || merged.phone || null,
      merged.job_title || null,
      salary,
      merged.started_on || null,
      merged.branch_id ?? null,
      merged.note || null,
      merged.active ? 1 : 0,
      merged.user_id ?? null,
      id,
    );

    // The account carries the same name, so a voucher or a sale made out to
    // them reads the way the payroll does.
    db.prepare('UPDATE customers SET name = ? WHERE id = ?').run(name, employee.customer_id);

    return getEmployee(id);
  })();
}

/**
 * They have left.
 *
 * Archived, never deleted, and refused while anything is outstanding in either
 * direction — a leaver who is still owed half a month is exactly the record
 * somebody will need in three weeks, and losing the row would lose the reason
 * the ledger does not balance.
 */
export function archiveEmployee(id) {
  const employee = getEmployee(id);
  if (!employee) throw new Error('That employee does not exist');

  if (Math.abs(employee.balance) > 0.004) {
    throw new Error(
      employee.balance > 0
        ? `${employee.name} still owes ${employee.balance.toFixed(2)} USD — settle it first`
        : `${employee.name} is still owed ${Math.abs(employee.balance).toFixed(2)} USD — pay it first`,
    );
  }

  db.prepare(`UPDATE employees SET active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
  db.prepare('UPDATE customers SET active = 0 WHERE id = ?').run(employee.customer_id);
  return { ok: true };
}

/**
 * Put a month's salary on somebody's account.
 *
 * Two writes, and both are needed for different reasons. The ledger entry is
 * what the shop owes them; the `wages` expense is what the month cost to run,
 * which is what the profit report subtracts. Neither one alone answers both
 * questions.
 *
 * `UNIQUE (employee_id, period)` in the schema does the real work: somebody will
 * press this twice, and paying August twice is not a mistake anybody notices
 * until the balances are wrong.
 *
 * The entry is written as an `adjustment` rather than as a kind of its own. The
 * ledger's kinds are fixed by a CHECK constraint and widening one means
 * rebuilding the table under a live shop's data — a real cost, for a label. What
 * the entry is for is on its face, in the note.
 */
export function accrueSalary(employeeId, { period, amountUsd = null, note = null }, userId = null) {
  if (!isPeriod(period)) throw new Error('The month must be written as YYYY-MM, e.g. 2026-08');

  const employee = getEmployee(employeeId);
  if (!employee) throw new Error('That employee does not exist');

  const amount = round2(amountUsd === null || amountUsd === undefined ? employee.monthly_salary : Number(amountUsd));
  if (!(amount > 0)) throw new Error(`${employee.name} has no salary set — set one, or enter an amount`);

  const already = db
    .prepare('SELECT * FROM employee_salaries WHERE employee_id = ? AND period = ?')
    .get(employeeId, period);
  if (already) throw new Error(`${periodName(period)} has already been run for ${employee.name}`);

  return transaction(() => {
    const label = `Salary — ${periodName(period)}`;

    const entryId = addEntry({
      partyType: 'customer',
      partyId: employee.customer_id,
      kind: 'adjustment',
      // Negative: the shop now owes them, which is the opposite direction from
      // everything else on a customer account.
      amountUsd: -amount,
      note: note ? `${label} · ${note}` : label,
      userId,
    });

    /*
     * Recorded as paid with "other", not with cash: earning a wage does not
     * empty the drawer. The drawer moves when they are actually paid, through a
     * voucher, and letting this touch it would make the till short by every
     * salary the shop has not handed over yet.
     */
    const expense = addExpense({
      /*
       * Whichever branch they work at, and the main one when nobody has said.
       * An expense with no branch belongs to no branch's profit report, so a
       * wage left null would be a cost the shop paid and no screen subtracted.
       */
      branchId: employee.branch_id ?? mainBranchId(),
      spentOn: `${period}-01`,
      category: 'wages',
      amountUsd: amount,
      paidWith: 'other',
      note: `${employee.name} — ${periodName(period)}`,
      userId,
    });

    db.prepare(
      `INSERT INTO employee_salaries (employee_id, period, amount_usd, entry_id, expense_id, note, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(employeeId, period, amount, entryId, expense.id, note?.trim() || null, userId);

    return getEmployee(employeeId);
  })();
}

/**
 * Run the month for everybody at once.
 *
 * Reports per person rather than failing on the first one: an employee already
 * paid, or one with no salary set, must not stop the other eleven being paid.
 */
export function runPayroll(period, userId = null) {
  if (!isPeriod(period)) throw new Error('The month must be written as YYYY-MM, e.g. 2026-08');

  const results = [];
  for (const employee of listEmployees()) {
    if (!(employee.monthly_salary > 0)) {
      results.push({ id: employee.id, name: employee.name, skipped: 'no salary set' });
      continue;
    }
    try {
      const updated = accrueSalary(employee.id, { period }, userId);
      results.push({ id: employee.id, name: employee.name, amount: employee.monthly_salary, balance: updated.balance });
    } catch (err) {
      results.push({ id: employee.id, name: employee.name, skipped: err.message });
    }
  }

  return {
    period,
    accrued: round2(results.reduce((sum, r) => sum + (r.amount || 0), 0)),
    paid: results.filter((r) => !r.skipped).length,
    results,
  };
}

/** Undo a month, for when it was run against the wrong period or the wrong figure. */
export function reverseSalary(employeeId, period, userId = null) {
  const employee = getEmployee(employeeId);
  if (!employee) throw new Error('That employee does not exist');

  const row = db
    .prepare('SELECT * FROM employee_salaries WHERE employee_id = ? AND period = ?')
    .get(employeeId, period);
  if (!row) throw new Error(`${periodName(period)} has not been run for ${employee.name}`);

  return transaction(() => {
    // An opposite entry rather than a deletion, so the account still shows that
    // the month was run and then taken back.
    addEntry({
      partyType: 'customer',
      partyId: employee.customer_id,
      kind: 'adjustment',
      amountUsd: row.amount_usd,
      note: `Salary reversed — ${periodName(period)}`,
      userId,
    });
    // The salary row first: it points at the expense, and a foreign key does
    // not care which order somebody meant them in.
    db.prepare('DELETE FROM employee_salaries WHERE id = ?').run(row.id);
    if (row.expense_id) deleteExpense(row.expense_id, userId);

    return getEmployee(employeeId);
  })();
}

/** What the payroll costs a month, and where every account stands today. */
export function payrollSummary() {
  const staff = listEmployees();
  return {
    people: staff.length,
    monthly: round2(staff.reduce((sum, e) => sum + Number(e.monthly_salary || 0), 0)),
    // Wages earned and not yet handed over, and advances not yet worked off.
    owedToStaff: round2(staff.reduce((sum, e) => sum + e.owedToThem, 0)),
    owedToShop: round2(staff.reduce((sum, e) => sum + e.owedToShop, 0)),
  };
}

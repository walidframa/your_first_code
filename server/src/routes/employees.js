import { Router } from 'express';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth.js';
import { db } from '../db.js';
import { dealingsWith, listEntries } from '../lib/accounts.js';
import { defaultAccount } from '../lib/cashAccounts.js';
import { recordVoucher } from '../lib/vouchers.js';
import { statementFor } from '../lib/statements.js';
import {
  accrueSalary,
  archiveEmployee,
  createEmployee,
  getEmployee,
  listEmployees,
  payrollSummary,
  periodOf,
  reverseSalary,
  runPayroll,
  salariesFor,
  updateEmployee,
} from '../lib/employees.js';

const router = Router();

/*
 * Wages are the owner's business.
 *
 * Not a permission of its own, deliberately: a shop that hands out a "payroll"
 * checkbox has handed out every salary in the building, and the person most
 * likely to be given it by accident is the person who most wants to read it.
 * An admin is the owner; nobody else sees this screen.
 */
const owner = [requireAuth, requireRole('admin')];

router.get('/', ...owner, (req, res) => {
  res.json({
    employees: listEmployees({ includeArchived: req.query.includeArchived === 'true' }),
    summary: payrollSummary(),
    // Today's month, so the screen never has to guess and never disagrees with
    // a server in another timezone about which month it is.
    period: periodOf(),
  });
});

router.get('/:id', ...owner, (req, res) => {
  const employee = getEmployee(req.params.id);
  if (!employee) return res.status(404).json({ error: 'That employee does not exist' });

  res.json({
    employee,
    salaries: salariesFor(employee.id),
    // The same two halves any other account has: what moved the balance, and
    // what was actually done with them. An employee who buys a charger on
    // account shows up here exactly as a customer would, because they are one.
    entries: listEntries('customer', employee.customer_id, req.query.limit),
    dealings: dealingsWith('customer', employee.customer_id, req.query.limit),
  });
});

/**
 * The same statement a customer or a supplier gets.
 *
 * Which is the point of running staff through a customer account rather than
 * inventing a payroll ledger: the printed page that settles an argument with a
 * supplier settles one with an employee too, and there is only one of it to
 * keep right.
 */
router.get('/:id/statement', ...owner, (req, res) => {
  const employee = getEmployee(req.params.id);
  if (!employee) return res.status(404).json({ error: 'That employee does not exist' });

  res.json({
    ...statementFor('customer', employee.customer_id, { from: req.query.from, to: req.query.to }),
    employee,
  });
});

router.post('/', ...owner, (req, res) => {
  try {
    res.status(201).json({ employee: createEmployee(req.body || {}, req.user.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', ...owner, (req, res) => {
  try {
    res.json({ employee: updateEmployee(req.params.id, req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', ...owner, (req, res) => {
  try {
    res.json(archiveEmployee(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Put one month on one person's account. */
router.post('/:id/salary', ...owner, (req, res) => {
  try {
    const { period = periodOf(), amountUsd = null, note = null } = req.body || {};
    res.status(201).json({ employee: accrueSalary(req.params.id, { period, amountUsd, note }, req.user.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/salary/:period', ...owner, (req, res) => {
  try {
    res.json({ employee: reverseSalary(req.params.id, req.params.period, req.user.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Run the whole month. */
router.post('/payroll', ...owner, (req, res) => {
  try {
    res.status(201).json(runPayroll(req.body?.period || periodOf(), req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Hand somebody money — a wage, or an advance against one.
 *
 * The same act either way, and the app should not ask which. Money leaves the
 * till and lands on their account; whether that clears a wage the shop owed or
 * puts them in debt until the end of the month is answered by the balance
 * afterwards, not by a radio button at the time.
 *
 * Written as an ordinary voucher, so it gets a PV number, prints like every
 * other payment, and appears in the vouchers list where somebody looking for
 * "where did the money go today" will actually look.
 */
router.post('/:id/payments', ...owner, (req, res) => {
  const employee = getEmployee(req.params.id);
  if (!employee) return res.status(404).json({ error: 'That employee does not exist' });

  const till = req.body?.accountId ?? defaultAccount()?.id ?? null;
  if (!till) return res.status(400).json({ error: 'There is no till to pay it out of' });

  try {
    const voucher = recordVoucher({
      fromType: 'cash',
      fromId: till,
      toType: 'customer',
      toId: employee.customer_id,
      amountUsd: req.body?.amountUsd ?? 0,
      amountLbp: req.body?.amountLbp ?? 0,
      reason: 'wages',
      note: req.body?.note?.trim() || `Paid to ${employee.name}`,
      userId: req.user.id,
    });

    res.status(201).json({ voucher, employee: getEmployee(employee.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Money back off an employee, in cash.
 *
 * The other direction, and rarer: somebody who took a large advance hands some
 * of it back rather than working it off. A receipt voucher, for the same
 * reasons the payment is a payment voucher.
 */
router.post('/:id/receipts', ...owner, (req, res) => {
  const employee = getEmployee(req.params.id);
  if (!employee) return res.status(404).json({ error: 'That employee does not exist' });

  const till = req.body?.accountId ?? defaultAccount()?.id ?? null;
  if (!till) return res.status(400).json({ error: 'There is no till to put it in' });

  try {
    const voucher = recordVoucher({
      fromType: 'customer',
      fromId: employee.customer_id,
      toType: 'cash',
      toId: till,
      amountUsd: req.body?.amountUsd ?? 0,
      amountLbp: req.body?.amountLbp ?? 0,
      reason: 'wages',
      note: req.body?.note?.trim() || `Received from ${employee.name}`,
      userId: req.user.id,
    });

    res.status(201).json({ voucher, employee: getEmployee(employee.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Which customer accounts are staff.
 *
 * Behind the customers permission rather than behind admin, because this is not
 * anybody's salary — it is a flag on a contact, and the customers screen uses it
 * to say "staff account" next to a name so nobody wonders why an employee is in
 * the customer list.
 */
router.get('/accounts/flags', requireAuth, requirePermission('parties'), (req, res) => {
  const rows = db
    .prepare('SELECT customer_id, id, name, job_title FROM employees WHERE active = 1')
    .all();
  res.json({ staff: rows });
});

export default router;

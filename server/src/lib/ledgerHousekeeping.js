/**
 * Two things a bookkeeper does to a ledger that is already written.
 *
 * Both edit books that have been posted, which this app otherwise refuses to
 * do — a mistake is undone by its opposite, never by rewriting what happened.
 * These two are the exceptions, and they earn it for the same reason: neither
 * changes a single figure. Renumbering changes what an entry is *called*;
 * moving an account's postings changes which shelf they are filed on. The
 * debits and credits, the dates and the totals come out identical, and the
 * trial balance is the proof.
 *
 * Because they are exceptions, both refuse to touch a closed period and both
 * can be previewed before anything moves. A shop should be able to read what
 * an operation will do, in its own numbers, and then decide.
 */
import { db, transaction } from '../db.js';
import { round2 } from './currency.js';
import { accountById, signedBalance } from './ledger.js';
import { closedThrough, isClosed } from './periodLock.js';

/** The entries a range covers, oldest first — the order they will be numbered in. */
function entriesIn({ from = null, to = null }) {
  return db
    .prepare(
      `SELECT id, entry_number, entry_date, memo, status
       FROM journal_entries
       WHERE (? IS NULL OR entry_date >= ?) AND (? IS NULL OR entry_date <= ?)
       ORDER BY entry_date, id`,
    )
    .all(from, from, to, to);
}

/** Refuse the whole operation if any of it reaches into a closed period. */
function refuseIfClosed(rows) {
  const shut = rows.find((r) => isClosed(r.entry_date));
  if (shut) {
    throw new Error(
      `${shut.entry_number} is dated ${shut.entry_date}, inside the books closed through ${closedThrough()}`,
    );
  }
}

const numbered = (n) => `JV-${String(n).padStart(4, '0')}`;

/**
 * What renumbering would call each entry, before anything is called it.
 *
 * Vouchers get numbered as they are written, which is not the order they
 * happened in: an invoice typed on Friday for Tuesday's delivery lands after
 * Thursday's. Gaps appear too, from drafts that were never posted. Neither is
 * wrong, and plenty of shops live with both — but an accountant handing a
 * numbered book to somebody else generally wants the numbers to run with the
 * dates and to have nothing missing between them.
 */
export function renumberPreview({ from = null, to = null, startAt = 1 } = {}) {
  const rows = entriesIn({ from, to });
  const start = Math.max(1, Math.round(Number(startAt) || 1));

  const changes = rows.map((r, i) => ({
    id: r.id,
    entry_date: r.entry_date,
    memo: r.memo,
    from: r.entry_number,
    to: numbered(start + i),
  }));

  /*
   * A number this would hand out that already belongs to an entry outside the
   * range. Renumbering March into a series that runs over April's numbers
   * would fail halfway through on a unique index; better to say so first, with
   * the number that clashes.
   */
  const inRange = new Set(rows.map((r) => r.id));
  const clash = changes.find((c) => {
    const holder = db.prepare('SELECT id FROM journal_entries WHERE entry_number = ?').get(c.to);
    return holder && !inRange.has(holder.id);
  });

  return {
    from,
    to,
    startAt: start,
    entries: changes,
    moved: changes.filter((c) => c.from !== c.to).length,
    /* Said rather than thrown, so the screen can show the plan and the problem
       together instead of an error where the plan should be. */
    problem: clash ? `${clash.to} already belongs to an entry outside these dates` : null,
    closedThrough: closedThrough(),
  };
}

/**
 * Give the vouchers their numbers.
 *
 * In two passes, because `entry_number` is unique: renumbering 3→2 while 2 is
 * still held by another row fails on the index, and the failure would land
 * halfway through a sequence. Every affected row is parked on a temporary
 * number first, so the second pass can never collide with anything.
 */
export function renumber({ from = null, to = null, startAt = 1 } = {}) {
  const rows = entriesIn({ from, to });
  if (rows.length === 0) throw new Error('There are no entries in those dates');

  /*
   * The closed period first, deliberately. A clash of numbers is a refusal
   * somebody can work around by starting the series somewhere else; a closed
   * period is not, and being told the smaller of the two problems first sends
   * a shop off to fix something that was never going to help.
   */
  refuseIfClosed(rows);

  const plan = renumberPreview({ from, to, startAt });
  if (plan.problem) throw new Error(plan.problem);

  return transaction(() => {
    const park = db.prepare('UPDATE journal_entries SET entry_number = ? WHERE id = ?');
    for (const c of plan.entries) park.run(`RENUM-${c.id}`, c.id);
    for (const c of plan.entries) park.run(c.to, c.id);
    return { renumbered: plan.entries.length, moved: plan.moved, entries: plan.entries };
  })();
}

/* ------------------------------------------------- moving an account's work */

function transferable(fromAccountId, toAccountId) {
  const source = accountById(fromAccountId);
  const target = accountById(toAccountId);
  if (!source) throw new Error('That account does not exist');
  if (!target) throw new Error('There is no account to move it to');
  if (source.id === target.id) throw new Error('That is the same account');
  if (target.is_group) {
    throw new Error(`${target.name} is a heading — pick an account under it`);
  }
  if (!target.active) throw new Error(`${target.name} has been put away`);
  /*
   * Types have to match, and this is the check that keeps the statements
   * honest rather than tidy. An expense moved onto an asset account leaves the
   * trial balance still balancing — the debits and credits are untouched — and
   * quietly moves money from the profit to the balance sheet. That is a
   * misstatement produced by a filing operation, and it is exactly the kind of
   * thing nobody notices until an accountant asks.
   */
  if (source.type !== target.type) {
    throw new Error(
      `${source.name} is ${source.type} and ${target.name} is ${target.type} — moving postings between them would change what the books say`,
    );
  }
  return { source, target };
}

/** The postings a move would take, and what they come to. */
export function transferPreview({ fromAccountId, toAccountId, from = null, to = null } = {}) {
  const { source, target } = transferable(fromAccountId, toAccountId);

  const lines = db
    .prepare(
      `SELECT l.id, l.debit_usd, l.credit_usd, e.entry_number, e.entry_date, e.memo
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ?
         AND (? IS NULL OR e.entry_date >= ?) AND (? IS NULL OR e.entry_date <= ?)
       ORDER BY e.entry_date, e.id`,
    )
    .all(source.id, from, from, to, to);

  const debit = round2(lines.reduce((s, l) => s + l.debit_usd, 0));
  const credit = round2(lines.reduce((s, l) => s + l.credit_usd, 0));

  return {
    source: { id: source.id, code: source.code, name: source.name, type: source.type },
    target: { id: target.id, code: target.code, name: target.name, type: target.type },
    from,
    to,
    lines,
    totals: { count: lines.length, debit, credit, balance: signedBalance(source.type, debit, credit) },
    closedThrough: closedThrough(),
  };
}

/**
 * File an account's postings under a different account.
 *
 * For the mistake that is only visible months later: everything a supplier
 * charged went to Other expenses, and the shop wants it under Rent. Posting a
 * correcting journal would move the *balance* and leave every movement sitting
 * in the wrong account's ledger, which is the page somebody actually reads.
 * So the lines move.
 *
 * Nothing about the money changes — same entries, same dates, same debits and
 * credits, same totals. Only the account they hang from. A closed period is
 * refused outright: numbers an accountant has signed off do not move.
 */
export function transferAccount({ fromAccountId, toAccountId, from = null, to = null } = {}) {
  const plan = transferPreview({ fromAccountId, toAccountId, from, to });
  if (plan.lines.length === 0) throw new Error(`${plan.source.name} has nothing posted in those dates`);
  refuseIfClosed(plan.lines.map((l) => ({ entry_number: l.entry_number, entry_date: l.entry_date })));

  return transaction(() => {
    const move = db.prepare('UPDATE journal_lines SET account_id = ? WHERE id = ?');
    for (const line of plan.lines) move.run(plan.target.id, line.id);
    return { moved: plan.lines.length, totals: plan.totals, source: plan.source, target: plan.target };
  })();
}

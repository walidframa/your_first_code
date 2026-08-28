/**
 * Cost centres and areas — the second axis on the books.
 *
 * An account says *what* the money was. It cannot say which part of the shop
 * it belonged to, and that is the question an owner actually asks: is the
 * repair bench making money, or is it being carried by the phone counter?
 *
 * Two of them because they answer different questions and a shop wants to
 * cross them. A **cost centre** is a part of the business; an **area** is
 * where. "Repairs in Saida" needs both.
 *
 * The two are deliberately the same shape and share this file. They are the
 * same idea pointed at two different questions, and writing them twice would
 * be two sets of rules to keep in step for no gain.
 */
import { db } from '../db.js';
import { round2 } from './currency.js';
import { NORMAL_SIDE } from './ledger.js';

/** The two axes, and the table behind each. */
export const DIMENSIONS = {
  centre: { table: 'cost_centres', column: 'cost_centre_id', label: 'Cost centre' },
  area: { table: 'areas', column: 'area_id', label: 'Area' },
};

function must(kind) {
  const dimension = DIMENSIONS[kind];
  if (!dimension) throw new Error(`Not an axis this app keeps: ${kind}`);
  return dimension;
}

export function list(kind, { activeOnly = false } = {}) {
  const { table } = must(kind);
  return db
    .prepare(`SELECT * FROM ${table} ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY code`)
    .all()
    .map((r) => ({ ...r, active: !!r.active }));
}

export function byId(kind, id) {
  const { table } = must(kind);
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  return row ? { ...row, active: !!row.active } : null;
}

export function create(kind, { code, name, note = null }) {
  const { table, label } = must(kind);
  const cleanCode = String(code ?? '').trim();
  const cleanName = String(name ?? '').trim();
  if (!cleanCode) throw new Error(`A ${label.toLowerCase()} needs a code`);
  if (!cleanName) throw new Error(`A ${label.toLowerCase()} needs a name`);

  const clash = db.prepare(`SELECT name FROM ${table} WHERE code = ?`).get(cleanCode);
  if (clash) throw new Error(`${cleanCode} is already ${clash.name}`);

  const info = db
    .prepare(`INSERT INTO ${table} (code, name, note) VALUES (?, ?, ?)`)
    .run(cleanCode, cleanName, note || null);
  return byId(kind, info.lastInsertRowid);
}

export function update(kind, id, { code, name, note, active }) {
  const { table, label } = must(kind);
  const existing = byId(kind, id);
  if (!existing) throw new Error(`That ${label.toLowerCase()} does not exist`);

  const merged = {
    code: code === undefined ? existing.code : String(code).trim(),
    name: name === undefined ? existing.name : String(name).trim(),
    note: note === undefined ? existing.note : note || null,
    active: active === undefined ? existing.active : Boolean(active),
  };
  if (!merged.code || !merged.name) throw new Error(`A ${label.toLowerCase()} needs a code and a name`);

  const clash = db
    .prepare(`SELECT name FROM ${table} WHERE code = ? AND id IS NOT ?`)
    .get(merged.code, id);
  if (clash) throw new Error(`${merged.code} is already ${clash.name}`);

  db.prepare(`UPDATE ${table} SET code = ?, name = ?, note = ?, active = ? WHERE id = ?`)
    .run(merged.code, merged.name, merged.note, merged.active ? 1 : 0, id);
  return byId(kind, id);
}

/**
 * Put one away rather than delete it.
 *
 * Deleting would orphan every line already filed under it, and those lines are
 * the only record of which part of the shop the money belonged to. An archived
 * centre keeps its history and stops being offered on new entries.
 */
export function archive(kind, id) {
  const { table, label } = must(kind);
  const existing = byId(kind, id);
  if (!existing) throw new Error(`That ${label.toLowerCase()} does not exist`);
  db.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`).run(id);
  return byId(kind, id);
}

/**
 * What each centre — or area — earned and spent.
 *
 * Only income and expense accounts, because that is the question being asked.
 * A cost centre's share of the cash in the drawer is not a thing: the money is
 * in one drawer whoever earned it, and reporting a balance sheet per centre
 * would be inventing a figure nobody can check.
 *
 * Lines with no centre on them are gathered under one heading rather than
 * dropped. A report that quietly leaves out the unassigned is a report whose
 * total does not match the profit figure on the next screen, and the shop is
 * left to work out which one lied.
 */
export function performance(kind, { from = null, to = null } = {}) {
  const { table, column } = must(kind);

  const rows = db
    .prepare(
      `SELECT d.id, d.code, d.name, a.type,
              COALESCE(SUM(l.debit_usd), 0) AS debit,
              COALESCE(SUM(l.credit_usd), 0) AS credit
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
       JOIN gl_accounts a ON a.id = l.account_id
       LEFT JOIN ${table} d ON d.id = l.${column}
       WHERE a.type IN ('income', 'expense')
         AND (? IS NULL OR e.entry_date >= ?) AND (? IS NULL OR e.entry_date <= ?)
       GROUP BY d.id, a.type`,
    )
    .all(from, from, to, to);

  const byKey = new Map();
  for (const r of rows) {
    const key = r.id ?? 0;
    const entry = byKey.get(key) ?? {
      id: r.id ?? null,
      code: r.code ?? '—',
      name: r.name ?? 'Not assigned',
      income: 0,
      expense: 0,
    };
    const amount = NORMAL_SIDE[r.type] === 'credit'
      ? round2(r.credit - r.debit)
      : round2(r.debit - r.credit);
    if (r.type === 'income') entry.income = round2(entry.income + amount);
    else entry.expense = round2(entry.expense + amount);
    byKey.set(key, entry);
  }

  const lines = [...byKey.values()]
    .map((e) => ({ ...e, profit: round2(e.income - e.expense) }))
    // Whatever has not been assigned last: it is the one row that is a question
    // rather than an answer, and it belongs at the bottom of the list.
    .sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : String(a.code).localeCompare(String(b.code))));

  const totals = lines.reduce(
    (acc, l) => ({
      income: round2(acc.income + l.income),
      expense: round2(acc.expense + l.expense),
      profit: round2(acc.profit + l.profit),
    }),
    { income: 0, expense: 0, profit: 0 },
  );

  return { lines, totals };
}

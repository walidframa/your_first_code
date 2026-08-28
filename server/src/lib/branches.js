/**
 * The shops.
 *
 * One company, more than one counter, and a hard line between what they share
 * and what they do not. Shared: the catalogue, prices, barcodes, customers,
 * suppliers, staff accounts, the exchange rate — everything that *describes*
 * something. Not shared: the shelf, the drawer, the day's takings, the profit —
 * everything that *is* something, in one place, belonging to one till.
 *
 * A second branch that meant a second catalogue would be two shops rather than
 * one company: the same phone entered twice, at two prices, with a stock figure
 * that adds up to nothing.
 */
import { db, transaction } from '../db.js';
import { mainBranchId } from './stock.js';

export function listBranches({ activeOnly = false } = {}) {
  return db
    .prepare(
      `SELECT b.*,
              (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id) AS staff_count,
              (SELECT COALESCE(SUM(s.stock), 0) FROM branch_stock s WHERE s.branch_id = b.id) AS units_on_hand
       FROM branches b
       WHERE (? = 0 OR b.active = 1)
       ORDER BY b.is_main DESC, b.name`,
    )
    .all(activeOnly ? 1 : 0)
    .map((b) => ({ ...b, is_main: !!b.is_main, active: !!b.active }));
}

export function branchById(id) {
  const row = db.prepare('SELECT * FROM branches WHERE id = ?').get(id);
  return row ? { ...row, is_main: !!row.is_main, active: !!row.active } : null;
}

export function createBranch({ name, code = null, phone = null, address = null }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('A branch needs a name');

  try {
    const info = db
      .prepare('INSERT INTO branches (name, code, phone, address) VALUES (?, ?, ?, ?)')
      .run(trimmed, code?.trim() || null, phone?.trim() || null, address?.trim() || null);
    return branchById(info.lastInsertRowid);
  } catch {
    throw new Error(`There is already a branch called ${trimmed}`);
  }
}

export function updateBranch(id, changes) {
  const branch = branchById(id);
  if (!branch) throw new Error('That branch does not exist');

  const merged = { ...branch, ...changes };
  const name = String(merged.name || '').trim();
  if (!name) throw new Error('A branch needs a name');

  try {
    db.prepare(
      'UPDATE branches SET name = ?, code = ?, phone = ?, address = ?, area_id = ? WHERE id = ?',
    ).run(
      name,
      merged.code?.trim() || null,
      merged.phone?.trim() || null,
      merged.address?.trim() || null,
      /*
       * Which area this shop is in, so that everything the till writes here can
       * carry it without anybody ticking a box. An axis that only fills in when
       * somebody remembers is an axis whose report is wrong and looks right.
       */
      merged.area_id ? Number(merged.area_id) : null,
      id,
    );
  } catch {
    throw new Error(`There is already a branch called ${name}`);
  }
  return branchById(id);
}

/**
 * Close a branch.
 *
 * Refused while it still holds stock or has an open till — a branch closed with
 * things on its shelf makes those things vanish from every count, and they are
 * still physically somewhere. Move them out first, which is what a real closure
 * involves anyway.
 *
 * Never deleted: its sales are the company's history.
 */
export function archiveBranch(id) {
  const branch = branchById(id);
  if (!branch) throw new Error('That branch does not exist');
  if (branch.is_main) throw new Error('The main branch cannot be closed');

  const onHand =
    db.prepare('SELECT COALESCE(SUM(stock), 0) AS n FROM branch_stock WHERE branch_id = ?').get(id)?.n ?? 0;
  if (onHand > 0) {
    throw new Error(`${branch.name} still holds ${onHand} item${onHand === 1 ? '' : 's'} — transfer them out first`);
  }

  const openTill = db
    .prepare(
      `SELECT 1 FROM cash_sessions s
       JOIN cash_accounts a ON a.id = s.account_id
       WHERE a.branch_id = ? AND s.status = 'open'`,
    )
    .get(id);
  if (openTill) throw new Error(`${branch.name} has a cashbox still open — close it first`);

  const inTransit = db
    .prepare("SELECT 1 FROM stock_transfers WHERE status = 'sent' AND (from_branch_id = ? OR to_branch_id = ?)")
    .get(id, id);
  if (inTransit) throw new Error(`${branch.name} has stock still on its way — receive or cancel it first`);

  db.prepare('UPDATE branches SET active = 0 WHERE id = ?').run(id);
  return branchById(id);
}

export function reopenBranch(id) {
  db.prepare('UPDATE branches SET active = 1 WHERE id = ?').run(id);
  return branchById(id);
}

/**
 * Which branch somebody is working in.
 *
 * Their own, unless they asked for another and are allowed to. A cashier is
 * pinned to their counter: letting them sell from the other shop's shelf by
 * changing a dropdown is how stock goes missing from a branch nobody was
 * standing in. Whoever holds `branches` — in practice the owner — may look at
 * any of them, because somebody has to be able to.
 */
export function branchFor(user, requested = null, { canSwitch = false } = {}) {
  const home = user?.branch_id ?? null;
  const wanted = Number(requested) || null;

  if (!wanted) return home ?? mainBranchId();
  if (wanted === home) return wanted;
  if (!canSwitch) return home ?? mainBranchId();

  const branch = branchById(wanted);
  return branch && branch.active ? wanted : home ?? mainBranchId();
}

/** Put somebody at a branch. Null means the main one. */
export function setUserBranch(userId, branchId) {
  if (branchId !== null && branchId !== undefined && !branchById(branchId)) {
    throw new Error('That branch does not exist');
  }
  db.prepare('UPDATE users SET branch_id = ? WHERE id = ?').run(branchId ?? null, userId);
}

/**
 * Give a new branch its own till.
 *
 * A branch without one cannot take a cash sale at all, and discovering that at
 * the counter on opening morning is the worst possible time. Named after the
 * branch so a list of tills reads as a list of places.
 */
export function ensureBranchTill(branchId) {
  const branch = branchById(branchId);
  if (!branch) return null;

  const existing = db.prepare('SELECT * FROM cash_accounts WHERE branch_id = ?').get(branchId);
  if (existing) return existing;

  return transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO cash_accounts (name, kind, is_default, active, branch_id)
         VALUES (?, 'drawer', 0, 1, ?)`,
      )
      .run(`${branch.name} drawer`, branchId);
    return db.prepare('SELECT * FROM cash_accounts WHERE id = ?').get(info.lastInsertRowid);
  })();
}

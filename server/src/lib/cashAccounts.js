/**
 * The shop's own tills.
 *
 * A drawer at the register, a float at the transfer desk, a safe in the back.
 * They hold the shop's own money, which is what separates them from a customer
 * or a supplier account: those are records of what is owed, these are records
 * of what is actually there.
 *
 * A till's balance is the sum of its movements, in both currencies kept apart.
 * Money physically is dollars or pounds; folding the two into one figure makes
 * a count that is right in each look wrong the moment the rate moves.
 */
import { db } from '../db.js';
import { round2 } from './currency.js';

export const CASH_ACCOUNT_KINDS = ['drawer', 'desk', 'safe', 'bank', 'other'];

export function defaultAccount() {
  return db.prepare('SELECT * FROM cash_accounts WHERE is_default = 1').get() ?? null;
}

/** What is in one till: every movement it has ever had, added up. */
export function balanceOf(accountId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) AS usd, COALESCE(SUM(amount_lbp), 0) AS lbp
       FROM cash_movements WHERE account_id = ?`,
    )
    .get(accountId);
  return { usd: round2(row.usd), lbp: Math.round(row.lbp) };
}

/** Balances for every till at once — one query rather than one each. */
export function balanceMap() {
  const rows = db
    .prepare(
      `SELECT account_id, COALESCE(SUM(amount_usd), 0) AS usd, COALESCE(SUM(amount_lbp), 0) AS lbp
       FROM cash_movements GROUP BY account_id`,
    )
    .all();
  return new Map(rows.map((r) => [r.account_id, { usd: round2(r.usd), lbp: Math.round(r.lbp) }]));
}

export function accountById(id) {
  const account = db.prepare('SELECT * FROM cash_accounts WHERE id = ?').get(id);
  if (!account) return null;
  return {
    ...account,
    active: !!account.active,
    is_default: !!account.is_default,
    balance: balanceOf(account.id),
    open_session: db
      .prepare("SELECT id, opened_at FROM cash_sessions WHERE account_id = ? AND status = 'open'")
      .get(account.id),
  };
}

/**
 * The tills, of one branch or of all of them.
 *
 * A drawer is a physical thing standing in one shop. Offering the other
 * branch's safe in a picker at this counter is how money gets recorded as
 * moving somewhere it cannot have moved — so `branchId` is the normal case and
 * null, meaning every branch, is the owner asking about the whole company.
 */
export function listAccounts({ activeOnly = false, branchId = null } = {}) {
  const where = [];
  if (activeOnly) where.push('active = 1');
  if (branchId !== null) where.push('branch_id = ?');

  const rows = db
    .prepare(
      `SELECT * FROM cash_accounts
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY is_default DESC, name`,
    )
    .all(...(branchId !== null ? [branchId] : []));
  const balances = balanceMap();
  const open = new Map(
    db
      .prepare("SELECT account_id, id, opened_at FROM cash_sessions WHERE status = 'open'")
      .all()
      .map((s) => [s.account_id, s]),
  );

  return rows.map((a) => ({
    ...a,
    active: !!a.active,
    is_default: !!a.is_default,
    balance: balances.get(a.id) ?? { usd: 0, lbp: 0 },
    open_session: open.get(a.id) ?? null,
  }));
}

export function createAccount({ name, kind = 'drawer', note = null, branchId = null }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('A till needs a name');
  if (!CASH_ACCOUNT_KINDS.includes(kind)) {
    throw new Error(`kind must be one of: ${CASH_ACCOUNT_KINDS.join(', ')}`);
  }

  /*
   * Which shop it belongs to, written now rather than on the next restart.
   *
   * The branch backfill runs at boot and fills in anything left null, so a till
   * made this afternoon did get a branch — tomorrow. In between, every screen
   * that asks for "this branch's account" skipped it, which meant a shop that
   * had just made a safe its default account went on paying its suppliers out
   * of the counter drawer until somebody happened to restart the server.
   */
  const branch =
    branchId ?? db.prepare('SELECT id FROM branches WHERE is_main = 1').get()?.id ?? null;

  const info = db
    .prepare('INSERT INTO cash_accounts (name, kind, note, branch_id) VALUES (?, ?, ?, ?)')
    .run(trimmed, kind, note || null, branch);
  return accountById(info.lastInsertRowid);
}

export function updateAccount(id, { name, kind, note, active, isDefault }) {
  const account = db.prepare('SELECT * FROM cash_accounts WHERE id = ?').get(id);
  if (!account) throw new Error('That till does not exist');
  if (kind !== undefined && !CASH_ACCOUNT_KINDS.includes(kind)) {
    throw new Error(`kind must be one of: ${CASH_ACCOUNT_KINDS.join(', ')}`);
  }

  const merged = {
    name: name === undefined ? account.name : String(name).trim(),
    kind: kind === undefined ? account.kind : kind,
    note: note === undefined ? account.note : note || null,
    active: active === undefined ? account.active : active ? 1 : 0,
  };
  if (!merged.name) throw new Error('A till needs a name');

  /*
   * Exactly one default, always. Without the clear-then-set, two tills could
   * both claim it and every screen that falls back would pick whichever the
   * database happened to return first.
   */
  if (isDefault) {
    db.prepare('UPDATE cash_accounts SET is_default = 0').run();
    db.prepare('UPDATE cash_accounts SET is_default = 1 WHERE id = ?').run(account.id);
  }

  db.prepare('UPDATE cash_accounts SET name = ?, kind = ?, note = ?, active = ? WHERE id = ?').run(
    merged.name,
    merged.kind,
    merged.note,
    merged.active,
    account.id,
  );
  return accountById(account.id);
}

/**
 * Close a till for good.
 *
 * Refused while it is the fallback, while a sitting is open, or while there is
 * money in it: each of those would leave something with nowhere to go — the
 * next sale, the count somebody is part-way through, or the cash itself.
 */
export function archiveAccount(id) {
  const account = accountById(id);
  if (!account) throw new Error('That till does not exist');
  if (account.is_default) throw new Error('Make another till the default one first');
  if (account.open_session) throw new Error('Close its cashbox before putting the till away');
  if (account.balance.usd !== 0 || account.balance.lbp !== 0) {
    throw new Error('There is still money in that till — move it out first');
  }

  db.prepare('UPDATE cash_accounts SET active = 0 WHERE id = ?').run(account.id);
  return accountById(account.id);
}

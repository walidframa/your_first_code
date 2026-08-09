/**
 * What each member of staff is allowed to do.
 *
 * Two roles were enough while the shop was one counter: whoever was not the
 * owner sold things. It stops being enough the moment somebody is hired to run
 * one part of it — the transfer desk, the repair bench — because "cashier" then
 * means either too little to do the job or the run of the whole back office.
 *
 * So the role stays as the coarse answer and permissions are the fine one. An
 * admin is the owner and passes every check by definition; everyone else holds
 * exactly what they have been given, and the same list drives the navigation
 * they see and the routes the server will answer.
 *
 * Permissions are read from the database on each request rather than carried in
 * the token: a permission taken away has to take effect now, not in twelve
 * hours when the session happens to expire.
 */
import { db } from '../db.js';

/**
 * Grouped the way the work is, because a flat list of seventeen checkboxes is
 * something to be read one by one rather than a job description to recognise.
 */
export const PERMISSION_GROUPS = [
  {
    group: 'Selling',
    items: [
      ['register', 'Use the register', 'Ring up sales and take payment'],
      ['refunds', 'Refund a sale', 'Undo a completed sale and put the money back'],
      ['repairs', 'Repairs', 'Take phones in, quote, fit parts and hand them back'],
      ['documents', 'Documents', 'Quotations, sales orders and invoices'],
      ['parties', 'Customers and suppliers', 'Accounts, credit limits and what is owed'],
      ['secrets', 'Reveal saved passwords', 'iCloud and email accounts held for customers, repair passcodes'],
    ],
  },
  {
    group: 'Money',
    items: [
      ['transfers', 'Money transfer counter', 'Send and pay out transfers, and keep that drawer straight'],
      ['vouchers', 'Payment and receipt vouchers', 'Pay money out to any account, or take money in from one'],
      ['cashbox', 'Cashbox history', 'Past sittings, counts and what was over or short'],
      ['expenses', 'Record expenses', 'Money spent running the shop'],
      ['reports', 'Takings and profit', 'The dashboard, profit and what the shop is owed'],
    ],
  },
  {
    group: 'Stock',
    items: [
      ['catalogue', 'Products', 'Add, price and archive what the shop sells'],
      ['inventory', 'Stock', 'Counts, adjustments and booking handsets in by IMEI'],
      ['cards', 'Cards and wallets', 'Recharge and gift cards, and the credit behind them'],
      ['imports', 'Import and Shopify', 'Bring a catalogue in, and the Shopify connection'],
    ],
  },
  {
    group: 'Setup',
    items: [
      ['users', 'Staff', 'Add people and decide what they can do'],
      ['settings', 'Store settings', 'The exchange rate, rounding and the rest'],
    ],
  },
];

export const PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.items.map(([key]) => key));

/**
 * What a new account starts with.
 *
 * A cashier gets the register and nothing else: it is easier to hand someone
 * the transfer desk on their first morning than to discover a month later that
 * everyone hired since could edit prices.
 */
export const DEFAULT_PERMISSIONS = { admin: PERMISSIONS, cashier: ['register'] };

export function permissionsOf(userId) {
  return db
    .prepare('SELECT permission FROM user_permissions WHERE user_id = ? ORDER BY permission')
    .all(userId)
    .map((r) => r.permission);
}

/** Everyone's permissions at once, keyed by user id — one query for a list. */
export function permissionMap() {
  const rows = db.prepare('SELECT user_id, permission FROM user_permissions').all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id).push(r.permission);
  }
  for (const list of map.values()) list.sort();
  return map;
}

/**
 * An admin is the owner of the shop. Ticking every box to give them what
 * the role already means would be a way to accidentally lock them out of their
 * own back office.
 */
export function effectivePermissions(user) {
  if (!user) return [];
  return user.role === 'admin' ? [...PERMISSIONS] : permissionsOf(user.id);
}

export function can(user, permission) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return db
    .prepare('SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ?')
    .get(user.id, permission) !== undefined;
}

/** Replace someone's permissions wholesale. Unknown keys are refused. */
export function setPermissions(userId, permissions) {
  const wanted = [...new Set(permissions || [])];
  const unknown = wanted.filter((p) => !PERMISSIONS.includes(p));
  if (unknown.length > 0) throw new Error(`Unknown permission: ${unknown.join(', ')}`);

  db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO user_permissions (user_id, permission) VALUES (?, ?)');
  for (const p of wanted) insert.run(userId, p);
  return wanted.sort();
}

/**
 * Give a role's defaults to everyone who has no permissions at all.
 *
 * Runs once at startup for accounts that existed before permissions did. Only
 * touches users with an empty set, so a deliberately stripped-back account is
 * not quietly handed the register back on the next restart.
 */
export function seedMissingPermissions() {
  const users = db
    .prepare(
      `SELECT u.id, u.role FROM users u
       WHERE NOT EXISTS (SELECT 1 FROM user_permissions p WHERE p.user_id = u.id)`,
    )
    .all();

  let seeded = 0;
  for (const user of users) {
    // An admin needs no rows at all: the role answers every check, and storing
    // a full set of grants would be left behind if the account were ever demoted.
    if (user.role === 'admin') continue;
    setPermissions(user.id, DEFAULT_PERMISSIONS[user.role] || []);
    seeded += 1;
  }
  return seeded;
}

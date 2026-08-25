/**
 * Emptying a shop, on the shop's own request.
 *
 * A client trials the app for a fortnight — rings up imaginary sales, imports a
 * supplier's spreadsheet twice, opens a cashbox and never closes it — and then
 * asks to start for real on Monday with none of it. Doing that by hand is forty
 * DELETE statements typed into a live database at nine in the evening, which is
 * how the wrong shop gets emptied.
 *
 * Two scopes, and the difference matters:
 *
 *   trading      the day-to-day goes: sales, invoices, repairs, transfers,
 *                vouchers, cash sittings, what customers and suppliers owe,
 *                and the stock on the shelves. The catalogue, the people and
 *                the settings stay, so the shop opens on Monday with its
 *                products priced and its staff able to sign in.
 *
 *   everything   the above plus the catalogue and the contacts — back to the
 *                shop as it was handed over. The logins and the shop's own
 *                settings survive, because a shop nobody can sign into is not
 *                a reset, it is a locked door.
 *
 * Every table is named in one of the three lists below. `TABLES` in the test
 * beside this file is read out of the live schema, so a table added later and
 * forgotten here fails the build rather than quietly surviving a reset a client
 * was told was total.
 */
import { db, transaction } from '../db.js';

/** What is emptied whatever the scope: the shop's trading, and its stock. */
export const TRADING_TABLES = [
  'orders',
  'order_items',
  'order_payments',
  'order_accounts',
  'order_item_components',
  'held_sales',
  'account_entries',
  /*
   * The books go with the trading, and only the entries in them. What a shop
   * posted last year is as much a record of last year's trading as its orders
   * are, so a reset that clears one and leaves the other would produce a
   * trial balance for a shop with no sales in it.
   */
  'journal_entries',
  'journal_lines',
  'vouchers',
  'cash_sessions',
  'cash_movements',
  'transfers',
  'documents',
  'document_items',
  'repair_tickets',
  'repair_events',
  'repair_parts',
  'trade_ins',
  'trade_in_ids',
  'id_photos',
  'installment_plans',
  'installment_dues',
  'employee_salaries',
  'expenses',
  'stock_adjustments',
  'stock_transfers',
  'stock_transfer_items',
  'branch_stock',
  'product_units',
  'product_cost_history',
  'wallet_movements',
  'credit_sends',
  'shopify_sync_log',
  'shopify_sync_queue',
];

/** What a total reset takes as well: the catalogue and the people in it. */
export const CATALOGUE_TABLES = [
  'products',
  'product_barcodes',
  'product_bundles',
  'categories',
  'customers',
  'suppliers',
  'employees',
  'wallets',
  'transfer_companies',
  'shopify_links',
  'exchange_rate_history',
];

/**
 * What survives either way.
 *
 * The staff and what they may do, the shop's own settings, its branches and its
 * tills. A till is where money is counted, not money itself — emptying its
 * sittings leaves it at zero, and deleting the till would take the register's
 * drawer with it.
 */
export const KEPT_TABLES = [
  'users',
  'user_permissions',
  'settings',
  'branches',
  'cash_accounts',
  /*
   * The chart of accounts is setup, not trading. A shop that has spent an
   * afternoon naming its accounts and filing them under the right headings
   * must not lose that by clearing last year's entries — the chart is the
   * shape of its books, and the entries are what happened inside it.
   */
  'gl_accounts',
  /*
   * And the record of every visit the vendor has paid this shop.
   *
   * Kept deliberately, and kept even by the total reset: it is the shop's
   * evidence of who came in and why, and a reset run from the vendor's own
   * console must not be a way to tidy that away.
   */
  'support_sessions',
  'support_actions',
  // SQLite's own counter table, handled below rather than emptied wholesale.
  'sqlite_sequence',
];

export const RESET_SCOPES = ['trading', 'everything'];

/**
 * Empty it, and say what was in it.
 *
 * Counted before it is deleted so the answer is what actually went, not what
 * the caller hoped: "1,204 sales, 87 customers" is what somebody checks a
 * reset against when they ring back the next morning.
 */
export function resetShop(scope = 'trading') {
  if (!RESET_SCOPES.includes(scope)) {
    throw new Error(`A reset is one of: ${RESET_SCOPES.join(', ')}`);
  }

  const tables =
    scope === 'everything' ? [...TRADING_TABLES, ...CATALOGUE_TABLES] : [...TRADING_TABLES];

  return transaction(() => {
    const cleared = {};

    /*
     * References off for the duration. The order these are emptied in would
     * otherwise have to be a topological sort of the whole schema kept in step
     * by hand, and a reset that fails half way through is worse than one that
     * never started.
     */
    db.exec('PRAGMA defer_foreign_keys = ON');

    for (const table of tables) {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
      if (n > 0) cleared[table] = n;
      db.prepare(`DELETE FROM ${table}`).run();
      /*
       * And its numbering, so the first sale after a reset is ORD-0001 rather
       * than carrying on from a fortnight of test data nobody can see any more.
       */
      db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(table);
    }

    return { scope, cleared, tables: tables.length };
  })();
}

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/**
 * Run `fn` inside a transaction, rolling back if it throws.
 *
 * Mirrors the shape of better-sqlite3's `db.transaction()` — it returns a
 * wrapped function rather than running immediately — so call sites read the
 * same. node:sqlite has no built-in equivalent.
 *
 * Not reentrant: SQLite has no nested BEGIN, and nothing here nests.
 */
export function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'cashier')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sku TEXT UNIQUE NOT NULL,
    price REAL NOT NULL,
    cost REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0,
    category_id INTEGER REFERENCES categories(id),
    image_emoji TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE NOT NULL,
    cashier_id INTEGER NOT NULL REFERENCES users(id),
    subtotal REAL NOT NULL,
    discount REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'card')),
    amount_tendered REAL,
    change_due REAL,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'refunded')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER REFERENCES products(id),
    name TEXT NOT NULL,
    price REAL NOT NULL,
    quantity INTEGER NOT NULL,
    line_total REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stock_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    user_id INTEGER REFERENCES users(id),
    delta INTEGER NOT NULL,
    resulting_stock INTEGER NOT NULL,
    reason TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    credit_limit REAL NOT NULL DEFAULT 0,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  /*
   * One ledger for both sides of the book.
   *
   * amount_usd is signed and always means "outstanding": positive increases
   * what is owed (a credit sale to a customer, a bill from a supplier),
   * negative reduces it (a payment, a refund). A party's balance is therefore
   * just SUM(amount_usd), and the same query serves receivables and payables.
   */
  CREATE TABLE IF NOT EXISTS account_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_type TEXT NOT NULL CHECK (party_type IN ('customer', 'supplier')),
    party_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('sale', 'payment', 'refund', 'bill', 'adjustment', 'opening')),
    amount_usd REAL NOT NULL,
    paid_usd REAL NOT NULL DEFAULT 0,
    paid_lbp REAL NOT NULL DEFAULT 0,
    exchange_rate REAL,
    order_id INTEGER REFERENCES orders(id),
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_account_entries_party
    ON account_entries(party_type, party_id, created_at);

  /*
   * Quotations, sales orders, sales invoices and purchase invoices are the same
   * document with different consequences, so they share one table.
   *
   * A document is inert while it is a draft. Confirming it is what moves stock
   * and posts to the ledger; cancelling a confirmed document reverses both.
   */
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_type TEXT NOT NULL
      CHECK (doc_type IN ('quotation', 'sales_order', 'sales_invoice', 'purchase_invoice')),
    doc_number TEXT UNIQUE NOT NULL,
    party_type TEXT CHECK (party_type IN ('customer', 'supplier')),
    party_id INTEGER,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft', 'confirmed', 'cancelled')),
    issue_date TEXT NOT NULL DEFAULT (date('now')),
    valid_until TEXT,
    subtotal REAL NOT NULL DEFAULT 0,
    discount_percent REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    exchange_rate REAL,
    on_account INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    converted_from_id INTEGER REFERENCES documents(id),
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    confirmed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS document_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id),
    product_id INTEGER REFERENCES products(id),
    name TEXT NOT NULL,
    sku TEXT,
    price REAL NOT NULL,
    quantity REAL NOT NULL,
    line_total REAL NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type, created_at);
  CREATE INDEX IF NOT EXISTS idx_document_items_doc ON document_items(document_id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS exchange_rate_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rate REAL NOT NULL,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_adjustments_product ON stock_adjustments(product_id, created_at);
`);

// Additive migrations for databases created by earlier versions. SQLite has no
// "ADD COLUMN IF NOT EXISTS", so check the table shape first.
function addColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumn('products', 'barcode', 'TEXT');
addColumn('products', 'image_url', 'TEXT');
addColumn('products', 'supplier', 'TEXT');
addColumn('products', 'reorder_point', 'INTEGER NOT NULL DEFAULT 5');

// Dual-currency tender. Prices are held in USD; these record what was actually
// handed over, plus the rate in force at the time so historical orders stay
// convertible after the rate moves.
addColumn('orders', 'exchange_rate', 'REAL');
addColumn('orders', 'paid_usd', 'REAL NOT NULL DEFAULT 0');
addColumn('orders', 'paid_lbp', 'REAL NOT NULL DEFAULT 0');
addColumn('orders', 'change_usd', 'REAL NOT NULL DEFAULT 0');
addColumn('orders', 'change_lbp', 'REAL NOT NULL DEFAULT 0');
addColumn('orders', 'change_currency', 'TEXT');

addColumn('orders', 'customer_id', 'INTEGER REFERENCES customers(id)');

/*
 * Credit sales need payment_method = 'account', but SQLite cannot alter a CHECK
 * constraint — the table has to be rebuilt. Detect the old constraint from the
 * stored DDL so this runs exactly once, and copy by column name so the columns
 * added by addColumn() above come across intact.
 */
function migrateOrdersPaymentMethods() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get();
  if (!row?.sql || row.sql.includes("'account'")) return;

  const columns = db
    .prepare('PRAGMA table_info(orders)')
    .all()
    .map((c) => c.name);
  const columnList = columns.join(', ');

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE orders_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number TEXT UNIQUE NOT NULL,
        cashier_id INTEGER NOT NULL REFERENCES users(id),
        customer_id INTEGER REFERENCES customers(id),
        subtotal REAL NOT NULL,
        discount REAL NOT NULL DEFAULT 0,
        tax REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL,
        payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'card', 'account')),
        amount_tendered REAL,
        change_due REAL,
        status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'refunded')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        exchange_rate REAL,
        paid_usd REAL NOT NULL DEFAULT 0,
        paid_lbp REAL NOT NULL DEFAULT 0,
        change_usd REAL NOT NULL DEFAULT 0,
        change_lbp REAL NOT NULL DEFAULT 0,
        change_currency TEXT
      )
    `);
    db.exec(`INSERT INTO orders_migrated (${columnList}) SELECT ${columnList} FROM orders`);
    db.exec('DROP TABLE orders');
    db.exec('ALTER TABLE orders_migrated RENAME TO orders');
    db.exec('CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

migrateOrdersPaymentMethods();

export const ADJUSTMENT_REASONS = [
  'received',
  'damaged',
  'theft',
  'count_correction',
  'return',
  'transfer',
  'other',
];

export default db;

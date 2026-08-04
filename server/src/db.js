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

/*
 * Paying a document at the counter.
 *
 * A purchase settled in cash on delivery is not a payable, and a sales invoice
 * paid on the spot is not a receivable — but both still happened, and the cash
 * that moved is what the shop needs to see. These record what was handed over,
 * in either currency, so `on_account` becomes a consequence of the figures
 * rather than a separate switch: whatever is not paid goes on the account.
 */
addColumn('documents', 'paid_usd', 'REAL NOT NULL DEFAULT 0');
addColumn('documents', 'paid_lbp', 'REAL NOT NULL DEFAULT 0');
addColumn('documents', 'payment_method', 'TEXT');

/*
 * Documents created before those columns used `on_account = 0` to mean "settled
 * immediately, post nothing". That is now expressed as being paid in full, so
 * the payment appears on the party's statement like any other.
 */
function backfillDocumentPayments() {
  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM documents WHERE on_account = 0 AND paid_usd = 0 AND total > 0")
    .get();
  if (pending.n === 0) return;

  db.prepare(
    "UPDATE documents SET paid_usd = total, payment_method = 'cash' WHERE on_account = 0 AND paid_usd = 0 AND total > 0",
  ).run();
}

backfillDocumentPayments();

/*
 * Cost at the moment of sale.
 *
 * Profit is revenue less what the goods cost, and what they cost is whatever
 * was paid for *those* goods — not what the same product costs today. Reading
 * the current cost would rewrite last month's profit every time a supplier put
 * a price up, so each line keeps the figure that was true when it sold.
 */
addColumn('order_items', 'cost', 'REAL');
addColumn('document_items', 'cost', 'REAL');

/*
 * Individually identified stock.
 *
 * A phone shop does not sell seven interchangeable iPhone 13s. It sells *this*
 * handset — bought at its own price, in its own condition, carrying its own
 * warranty, and traceable to the customer who walked out with it. A quantity
 * cannot answer "who has IMEI 35…?" or "what did that one actually cost me?".
 *
 * Accessories and parts stay quantity-tracked: nobody serialises a screen
 * protector. So `tracks_units` is per product, and the two kinds of stock live
 * side by side in the same catalogue.
 */
addColumn('products', 'tracks_units', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
  CREATE TABLE IF NOT EXISTS product_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    -- The identifier stamped on the device. IMEI for phones, serial for
    -- everything else; one column, because a unit only ever has one of them.
    imei TEXT NOT NULL UNIQUE,
    condition TEXT NOT NULL DEFAULT 'new' CHECK (condition IN ('new', 'used', 'refurbished')),
    cost REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'in_stock'
      CHECK (status IN ('in_stock', 'sold', 'returned', 'scrapped')),
    note TEXT,
    -- Where it came in and where it went out, so a unit reads as a history.
    received_document_id INTEGER REFERENCES documents(id),
    sold_order_id INTEGER REFERENCES orders(id),
    sold_document_id INTEGER REFERENCES documents(id),
    sold_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_units_product ON product_units(product_id, status);
  CREATE INDEX IF NOT EXISTS idx_units_imei ON product_units(imei);
`);

/*
 * The second IMEI of a dual-SIM handset.
 *
 * Two SIM slots means two numbers, both printed on the box and both valid ways
 * to identify the phone. The customer at the counter reads whichever one they
 * can see, so a lookup has to match either — and neither may belong to another
 * handset.
 *
 * Nullable, because single-SIM phones and non-phone serials have only one.
 */
addColumn('product_units', 'imei2', 'TEXT');
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_units_imei2 ON product_units(imei2)
    WHERE imei2 IS NOT NULL;
`);

/*
 * Which unit left on which sale line.
 *
 * The line already keeps the cost that was true when it sold; for a serialised
 * product that cost belongs to one handset, so the link makes per-device margin
 * exact rather than averaged.
 */
addColumn('order_items', 'unit_id', 'INTEGER REFERENCES product_units(id)');

/*
 * What a product has cost over time.
 *
 * A shopkeeper wanting to know why the margin moved needs to see the cost
 * change and when. Written whenever the cost is edited or a purchase invoice
 * comes in at a different price.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS product_cost_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    cost REAL NOT NULL,
    previous_cost REAL,
    source TEXT NOT NULL,
    note TEXT,
    document_id INTEGER REFERENCES documents(id),
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_cost_history_product ON product_cost_history(product_id, created_at);

  /*
   * Running the shop costs money that never appears on an invoice: rent,
   * electricity, wages, the van's fuel. Without them a "profit" figure is only
   * gross margin wearing a better name.
   */
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spent_on TEXT NOT NULL DEFAULT (date('now')),
    category TEXT NOT NULL,
    amount_usd REAL NOT NULL DEFAULT 0,
    amount_lbp REAL NOT NULL DEFAULT 0,
    exchange_rate REAL,
    /* Where the money came from, so cash expenses can reach the drawer. */
    paid_with TEXT NOT NULL DEFAULT 'cash' CHECK (paid_with IN ('cash', 'bank', 'card', 'other')),
    supplier_id INTEGER REFERENCES suppliers(id),
    note TEXT,
    cash_movement_id INTEGER REFERENCES cash_movements(id),
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(spent_on);
`);

/*
 * The cash drawer.
 *
 * A session is one sitting of the till: opened with a float, closed with a
 * count. Every movement of physical money belongs to one, so "what should be in
 * the drawer" is a sum rather than a guess, and the difference against what was
 * actually counted is the number that tells a shopkeeper something is wrong.
 *
 * Both currencies are held separately rather than converted. The drawer
 * contains dollar notes and pound notes; converting them to a single figure
 * would make a count that is right in each currency look wrong the moment the
 * rate moves.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS cash_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    opened_by INTEGER NOT NULL REFERENCES users(id),
    opened_at TEXT NOT NULL DEFAULT (datetime('now')),
    opening_usd REAL NOT NULL DEFAULT 0,
    opening_lbp REAL NOT NULL DEFAULT 0,
    opening_note TEXT,
    closed_by INTEGER REFERENCES users(id),
    closed_at TEXT,
    counted_usd REAL,
    counted_lbp REAL,
    expected_usd REAL,
    expected_lbp REAL,
    /* Counted less expected: negative is short, positive is over. */
    over_short_usd REAL,
    over_short_lbp REAL,
    /* What was left in the drawer for the next sitting; the rest was banked. */
    carried_usd REAL,
    carried_lbp REAL,
    closing_note TEXT,
    exchange_rate REAL
  );

  CREATE INDEX IF NOT EXISTS idx_cash_sessions_status ON cash_sessions(status, opened_at);

  /*
   * The cash account itself. Every row is money physically entering or leaving
   * the drawer, whatever caused it — a sale, a supplier paid from the till, the
   * owner topping it up, a run to the bank.
   */
  CREATE TABLE IF NOT EXISTS cash_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES cash_sessions(id),
    kind TEXT NOT NULL CHECK (kind IN (
      'opening_float', 'sale', 'refund', 'customer_payment', 'supplier_payment',
      'document', 'cash_in', 'cash_out', 'bank_drop', 'correction'
    )),
    /* Signed: positive is money in, negative is money out. */
    amount_usd REAL NOT NULL DEFAULT 0,
    amount_lbp REAL NOT NULL DEFAULT 0,
    reason TEXT,
    note TEXT,
    order_id INTEGER REFERENCES orders(id),
    document_id INTEGER REFERENCES documents(id),
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(session_id, created_at);
`);

/*
 * Shopify inventory sync.
 *
 * `shopify_links` ties a local product to one Shopify variant, and remembers
 * the quantity Shopify last agreed on. That remembered figure is what makes
 * two-way sync possible without either side clobbering the other: a difference
 * against it is a change made *on Shopify* since we last looked, and is applied
 * locally, while a difference between local stock and it is a change made here,
 * and is pushed out.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS shopify_links (
    product_id INTEGER PRIMARY KEY REFERENCES products(id),
    variant_id TEXT NOT NULL,
    inventory_item_id TEXT NOT NULL,
    shopify_product_id TEXT,
    shopify_title TEXT,
    shopify_sku TEXT,
    shopify_qty INTEGER,
    last_synced_at TEXT,
    last_error TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_shopify_links_variant ON shopify_links(variant_id);

  /*
   * Outbound work. Rows are queued inside the same transaction as the stock
   * change that caused them, so a sale is never recorded without its push being
   * recorded too — but the push itself happens later, outside the transaction,
   * because a slow or unreachable Shopify must never hold up the register.
   */
  CREATE TABLE IF NOT EXISTS shopify_sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    reason TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_shopify_queue_product ON shopify_sync_queue(product_id);

  /* A log the shopkeeper can read when the numbers look wrong. */
  CREATE TABLE IF NOT EXISTS shopify_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER REFERENCES products(id),
    direction TEXT NOT NULL CHECK (direction IN ('push', 'pull', 'link', 'error')),
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_shopify_log_created ON shopify_sync_log(created_at);
`);

/*
 * Every stock change queues a push, wherever it came from — a sale, a refund, a
 * manual adjustment, a purchase invoice being confirmed. A trigger rather than a
 * call at each site, so a stock change added later cannot forget to sync.
 *
 * Applying an inbound change fires this too. That is harmless: the worker skips
 * a product whose stock already matches what Shopify last reported.
 */
db.exec(`
  CREATE TRIGGER IF NOT EXISTS products_stock_queues_shopify_push
  AFTER UPDATE OF stock ON products
  WHEN OLD.stock <> NEW.stock
  BEGIN
    INSERT INTO shopify_sync_queue (product_id, reason) VALUES (NEW.id, 'stock changed');
  END;
`);

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

import { DatabaseSync } from 'node:sqlite';
import { existsSync, renameSync, rmSync } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');

/** Where the shop's books actually are, for anything that has to copy them. */
export const databasePath = dbPath;

/** A backup waiting to be put back, staged by the process that then stood down. */
export const stagedRestorePath = `${dbPath}.restore`;

/**
 * Put back a backup, if one was left here for us.
 *
 * Restoring means replacing the file the server is holding open, which cannot
 * be done safely by the server that is holding it. So it is done in two halves:
 * the running process takes a fresh copy of the current books, writes the
 * chosen backup down beside the database, and exits. systemd starts it again a
 * second later, and *this* runs — before anything opens anything.
 *
 * Two seconds of downtime, no root, and no window in which the file is being
 * rewritten under a live reader. The alternative designs all involve the
 * console being able to run `systemctl` as root, which is the one thing the
 * console is deliberately not allowed to do.
 *
 * The stale `-wal` and `-shm` belong to the *old* file. Leaving them beside the
 * new one hands SQLite a journal describing a database that is no longer there,
 * which is a corrupt shop rather than a restored one.
 */
function applyStagedRestore() {
  if (!existsSync(stagedRestorePath)) return null;

  try {
    // Prove it is a database before standing on it. A truncated or half-copied
    // file that replaces a working shop is worse than a failed restore, and the
    // only moment this is cheap to check is before anything depends on it.
    const candidate = new DatabaseSync(stagedRestorePath, { readOnly: true });
    candidate.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    candidate.close();
  } catch (err) {
    // Leave the file alone and carry on with the shop we have. A restore that
    // cannot be trusted is not a reason to refuse to open the till.
    console.error(`Ignoring a staged restore that will not open: ${err.message}`);
    rmSync(stagedRestorePath, { force: true });
    return null;
  }

  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  renameSync(stagedRestorePath, dbPath);

  console.log('Restored the database from a staged backup.');
  return dbPath;
}

/** Set when this boot put a backup back, so the server can say so out loud. */
export const restoredOnBoot = Boolean(applyStagedRestore());

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
/*
 * How deep we are. SQLite has one transaction, not a stack of them, so a
 * second BEGIN inside the first is an error rather than a nested transaction.
 */
let depth = 0;

export function transaction(fn) {
  return (...args) => {
    /*
     * Nested calls use a savepoint instead of a second BEGIN.
     *
     * Two things that are each properly atomic on their own turn out to belong
     * together — accruing a month's salary writes a ledger entry *and* an
     * expense, and each of those already knew how to look after itself. Before
     * this, composing them threw "cannot start a transaction within a
     * transaction", which pushed the caller towards either giving up atomicity
     * or copying the inner function's SQL out into itself.
     *
     * Nothing that worked before behaves differently: a call that was not
     * nested still opens and commits a real transaction, and a call that *was*
     * nested used to throw, so no existing path depended on the old answer.
     */
    if (depth > 0) {
      const name = `sp_${depth}`;
      db.exec(`SAVEPOINT ${name}`);
      depth += 1;
      try {
        const result = fn(...args);
        // Releasing a savepoint does not commit — the outermost BEGIN still
        // decides whether any of this is kept.
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw err;
      } finally {
        depth -= 1;
      }
    }

    db.exec('BEGIN');
    depth = 1;
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      depth = 0;
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
    /* Effectively "no limit". A shop that wants a real ceiling on somebody
       types one; a shop that has never thought about it should not have every
       on-account sale refused, which is what a default of zero did. */
    credit_limit REAL NOT NULL DEFAULT 100000,
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

/*
 * The two piles an entry actually moved.
 *
 * `amount_usd` is the combined figure — dollars plus pounds at the rate of the
 * day — and every balance in the shop is built from it. That is the right
 * answer to "what is this account worth", and the wrong answer to the question
 * a transfer counter asks every evening: the agency wants its dollars *and* its
 * pounds, and one converted total tells the operator neither.
 *
 * Added rather than substituted, and nullable on purpose: a row written before
 * this existed says nothing about its split, and pretending otherwise would
 * invent a pound figure nobody recorded. Read with COALESCE — old rows count as
 * dollars, which is how they were entered.
 */
addColumn('account_entries', 'native_usd', 'REAL');
addColumn('account_entries', 'native_lbp', 'REAL');

addColumn('products', 'barcode', 'TEXT');
addColumn('products', 'image_url', 'TEXT');

/*
 * Every barcode a product answers to.
 *
 * One product is routinely one number and then some. A phone case comes in a
 * box with the maker's EAN and the distributor's own label stuck over it; a
 * shop prints its own for loose stock; the same charger arrives from two
 * suppliers with two numbers on it. Whichever one is facing up when the scanner
 * goes off has to find the product, and the alternative — a duplicate product
 * per barcode — splits the stock of one thing across two rows.
 *
 * `position` 0 is the primary: the one printed on a label and sent to Shopify.
 * `products.barcode` is kept as a copy of it so everything that reads that
 * column carries on working, and both are only ever written through
 * lib/barcodes.js, so the two cannot drift apart.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS product_barcodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    /* One number belongs to one product. A scan that could mean two things is
       not a scan, and the counter is the worst place to discover that. */
    barcode TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_product_barcodes_product
    ON product_barcodes(product_id, position);
`);

/*
 * Bring barcodes that only exist in the old column into the table.
 *
 * Runs for any product that has a barcode and no rows at all — which covers the
 * upgrade, the seed, and anything that still writes the column directly. It
 * cannot resurrect a barcode somebody removed: taking the last one off a
 * product clears `products.barcode` in the same write, so "column set, no rows"
 * only ever means "has not been through the new code yet".
 */
{
  const orphaned = db
    .prepare(
      `SELECT p.id, p.barcode FROM products p
       WHERE p.barcode IS NOT NULL AND trim(p.barcode) <> ''
         AND NOT EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id)`,
    )
    .all();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO product_barcodes (product_id, barcode, position) VALUES (?, ?, 0)',
  );
  for (const row of orphaned) insert.run(row.id, row.barcode.replace(/\s+/g, ''));
}
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

/**
 * How a sale was actually paid for, when it took more than one thing.
 *
 * "Half cash, half Whish" is an ordinary Lebanese counter transaction and the
 * app could not write it down: a sale carried one method, so the cashier had to
 * pick whichever half was bigger and the other half vanished. The same hole
 * swallowed the common case of a customer who is short — part now, the rest on
 * their account — which had to be done as two sales or not at all.
 *
 * `orders.payment_method` stays, holding the main way it was paid, so every
 * report and receipt written before this still reads correctly. These lines are
 * the detail underneath it, and they are what the drawer and the ledger are
 * driven from when they exist.
 *
 * `label` is what the customer would call it — Whish, OMT, Visa. From the
 * shop's books they are all "not cash, arrived electronically", but a shop that
 * wants to know how much came through which app should not have to guess.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS order_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'account')),
    amount_usd REAL NOT NULL DEFAULT 0,
    amount_lbp REAL NOT NULL DEFAULT 0,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id);
`);

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
  /*
   * A product made of other products.
   *
   * A "starter pack" is a phone, a case and a screen protector sold as one line
   * at one price. The pack is not stock in its own right — nothing sits on a
   * shelf called "starter pack" — so selling one has to take a phone, a case
   * and a protector off the shelves they really are on.
   *
   * Rows here rather than a flag on the product, because "is a bundle" and
   * "has parts" would be two answers to one question and would eventually
   * disagree. A product with rows in this table is a bundle; a product with
   * none is not.
   */
  CREATE TABLE IF NOT EXISTS product_bundles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The thing that is sold.
    bundle_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    -- One of the things that comes off the shelf when it is.
    component_id INTEGER NOT NULL REFERENCES products(id),
    -- How many of that component are in one bundle. Two cables in a pack is 2.
    quantity     REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
    -- The same component twice in one bundle is a quantity, not a second row.
    UNIQUE (bundle_id, component_id)
  );

  CREATE INDEX IF NOT EXISTS idx_bundles_bundle ON product_bundles(bundle_id);
  CREATE INDEX IF NOT EXISTS idx_bundles_component ON product_bundles(component_id);

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

/*
 * Warranty.
 *
 * The shop's own promise, not the manufacturer's: how many months it will fix
 * this handset for free. The default lives on the product because it is a
 * policy ("all our phones, six months"), and the figure is copied onto the unit
 * when it sells so changing the policy tomorrow cannot quietly shorten a
 * warranty somebody is already holding.
 */
addColumn('products', 'warranty_months', 'INTEGER NOT NULL DEFAULT 0');
addColumn('product_units', 'warranty_months', 'INTEGER');
addColumn('product_units', 'warranty_starts', 'TEXT');

/*
 * Repair jobs.
 *
 * A phone comes in broken and leaves fixed, and in between it is the shop's
 * responsibility. The ticket is the record of that: what came in, in what
 * state, what was wrong, what was done, what it cost — and the number the
 * customer holds when they come back for it.
 *
 * `unit_id` is set only when the handset is one the shop sold. Most repairs are
 * somebody else's phone, so the device is described in words and the IMEI kept
 * as typed.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS repair_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_number TEXT UNIQUE NOT NULL,
    unit_id INTEGER REFERENCES product_units(id),
    customer_id INTEGER REFERENCES customers(id),
    customer_name TEXT NOT NULL,
    customer_phone TEXT,
    device TEXT NOT NULL,
    imei TEXT,
    fault TEXT NOT NULL,
    condition_note TEXT,
    -- Often handed over so the phone can be tested. Encrypted like any other
    -- credential the shop is trusted with.
    passcode_enc TEXT,
    status TEXT NOT NULL DEFAULT 'received'
      CHECK (status IN ('received', 'diagnosed', 'awaiting_parts', 'repairing', 'ready', 'collected', 'cancelled')),
    under_warranty INTEGER NOT NULL DEFAULT 0,
    quoted REAL,
    charged REAL,
    order_id INTEGER REFERENCES orders(id),
    taken_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    collected_at TEXT
  );

  CREATE TABLE IF NOT EXISTS repair_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES repair_tickets(id),
    product_id INTEGER REFERENCES products(id),
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    cost REAL NOT NULL DEFAULT 0,
    price REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Every status change, so "when did you say it was ready?" has an answer.
  CREATE TABLE IF NOT EXISTS repair_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES repair_tickets(id),
    status TEXT NOT NULL,
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_repairs_status ON repair_tickets(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_repairs_imei ON repair_tickets(imei);
  CREATE INDEX IF NOT EXISTS idx_repair_parts_ticket ON repair_parts(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_repair_events_ticket ON repair_events(ticket_id);
`);

/*
 * Handsets bought back from a customer.
 *
 * The mirror of a sale: money leaves the drawer and a phone joins the shelf, at
 * whatever grade and price were agreed across the counter. It becomes an
 * ordinary unit from that moment, so it sells and reports like any other — the
 * trade-in row is only the record of where it came from.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS trade_ins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id INTEGER NOT NULL REFERENCES product_units(id),
    customer_id INTEGER REFERENCES customers(id),
    seller_name TEXT,
    seller_phone TEXT,
    paid_usd REAL NOT NULL DEFAULT 0,
    paid_lbp REAL NOT NULL DEFAULT 0,
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_trade_ins_unit ON trade_ins(unit_id);

  /*
   * The seller's identity document, photographed at the counter.
   *
   * A shop that buys a used phone without recording who sold it to them is a
   * shop that cannot prove it was not handling stolen goods — so this is the
   * evidence, and it is kept as it was on the day rather than attached to a
   * person who might come back and be someone else.
   *
   * A table of its own, not a column on trade_ins, for one practical reason:
   * the list query selects ti.* and would otherwise drag every photo in the
   * shop's history across the wire to draw a table of names and prices.
   */
  CREATE TABLE IF NOT EXISTS trade_in_ids (
    trade_in_id INTEGER PRIMARY KEY REFERENCES trade_ins(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    uploaded_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  /*
   * The same photograph, for anything that needs one.
   *
   * It started against trade-ins, and then selling a SIM turned out to need
   * exactly the same thing — a picture of whoever the shop is dealing with,
   * kept as it was on the day. Rather than a second table with the same five
   * columns, the subject is named: 'trade_in' for a handset bought in,
   * 'sim_sale' for a line on an order.
   */
  CREATE TABLE IF NOT EXISTS id_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('trade_in', 'sim_sale')),
    subject_id INTEGER NOT NULL,
    mime TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    uploaded_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (subject_type, subject_id)
  );
`);

/*
 * The IMEIs typed against a purchase invoice line.
 *
 * A delivery of handsets is booked in where it actually arrives — on the
 * supplier's invoice — not afterwards from a separate screen. Keeping the raw
 * lines on the line item means undoing or editing the invoice can find exactly
 * the units it created.
 */
addColumn('document_items', 'imeis', 'TEXT');

/*
 * Who bought the phone.
 *
 * Not every buyer is a customer account. Most walk in, buy a handset and leave;
 * what the shop needs later is a name and a number to call about a warranty, so
 * they sit on the order rather than forcing a customer record for a one-off.
 */
addColumn('orders', 'buyer_name', 'TEXT');
addColumn('orders', 'buyer_phone', 'TEXT');

/*
 * A line given away with the sale.
 *
 * A case thrown in with a phone still leaves the shop, so stock must move — but
 * it is not revenue, and counting it as such would flatter the margin on every
 * handset sold with something in the box.
 */
addColumn('order_items', 'is_gift', 'INTEGER NOT NULL DEFAULT 0');

/*
 * Accounts the shop set up for the customer.
 *
 * The passwords are encrypted (see lib/secrets.js) because a copy of this file
 * would otherwise be a list of live logins. The username is not: it is what the
 * counter searches by when someone comes back having forgotten everything else.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS order_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    unit_id INTEGER REFERENCES product_units(id),
    kind TEXT NOT NULL DEFAULT 'icloud' CHECK (kind IN ('icloud', 'gmail', 'other')),
    username TEXT NOT NULL,
    password_enc TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_order_accounts_order ON order_accounts(order_id);
  CREATE INDEX IF NOT EXISTS idx_order_accounts_unit ON order_accounts(unit_id);
  CREATE INDEX IF NOT EXISTS idx_order_accounts_user ON order_accounts(username);
`);
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
      'document', 'transfer', 'voucher', 'cash_in', 'cash_out', 'bank_drop', 'sweep', 'correction'
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
 * What each member of staff may do.
 *
 * A row is a grant; no row is no. An admin has none of these and can do
 * everything, because the role is what makes someone the owner — see
 * lib/permissions.js.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS user_permissions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, permission)
  );
`);

/*
 * The money transfer counter.
 *
 * A phone shop in Lebanon is usually an OMT or Whish agent as well, and that is
 * a different trade running out of the same drawer: somebody hands over cash to
 * send, somebody else collects cash that was sent to them, and the shop keeps a
 * fee. None of it is stock and none of it is a sale — but every one of them
 * moves money in or out of the till, which is why the drawer stops adding up
 * the moment they are kept on paper instead.
 *
 * Both currencies are held separately, like the drawer itself: a transfer is
 * sent in dollars or in pounds, not in a converted figure.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The number the company gives the customer, and the only thing either side
    -- can search by when something goes wrong.
    reference TEXT,
    company TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('send', 'payout')),
    customer_name TEXT,
    customer_phone TEXT,
    customer_id_no TEXT,
    -- Who it is going to, or who sent it.
    counterparty TEXT,
    destination TEXT,
    amount_usd REAL NOT NULL DEFAULT 0,
    amount_lbp REAL NOT NULL DEFAULT 0,
    /* The shop's cut, charged on top of a send or taken off a payout. */
    fee_usd REAL NOT NULL DEFAULT 0,
    fee_lbp REAL NOT NULL DEFAULT 0,
    exchange_rate REAL,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'cancelled')),
    cash_movement_id INTEGER REFERENCES cash_movements(id),
    operator_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    cancelled_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_transfers_created ON transfers(created_at);
  CREATE INDEX IF NOT EXISTS idx_transfers_reference ON transfers(reference);
`);

/*
 * Transfers move real money through the drawer, so they need their own kind on
 * the cash ledger — lumped in with petty cash they would make the end-of-day
 * report unreadable, which is the one thing it exists to be.
 *
 * `sweep` is the same argument for the money that leaves a drawer when it is
 * closed and lands in the shop's standing cash account. It used to be recorded
 * as a `bank_drop`, which said the money had gone to the bank when in fact it
 * had gone to the safe in the back — and the safe never heard about it.
 *
 * SQLite cannot alter a CHECK constraint, so the table is rebuilt. Detected
 * from the stored DDL so it runs exactly once, and copied by column name so
 * anything added since comes across intact.
 */
const CASH_MOVEMENT_KINDS = [
  'opening_float', 'sale', 'refund', 'customer_payment', 'supplier_payment',
  'document', 'transfer', 'voucher', 'cash_in', 'cash_out', 'bank_drop', 'sweep', 'correction',
];

function migrateCashMovementKinds() {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cash_movements'")
    .get();
  // Checked against the whole list rather than the newest name, so adding a
  // kind later is one edit here and the rebuild happens once.
  if (!row?.sql || CASH_MOVEMENT_KINDS.every((k) => row.sql.includes(`'${k}'`))) return;

  const present = db.prepare('PRAGMA table_info(cash_movements)').all();
  const columns = present.map((c) => c.name).join(', ');

  /*
   * The columns this table has grown since the shape below was written.
   *
   * `account_id` is one of them, and it is added further down this file — after
   * this migration runs. So the copy, which is by column name deliberately, was
   * naming a column the rebuilt table did not have, and the whole thing failed
   * on the first shop that had ever recorded a movement. The next kind added
   * would have taken the server down on boot with the database half rebuilt.
   *
   * Re-added rather than hard-coded, so the same thing does not happen again
   * the next time a column is added: whatever the live table carries, the
   * rebuilt one carries too.
   */
  const base = new Set([
    'id', 'session_id', 'kind', 'amount_usd', 'amount_lbp',
    'reason', 'note', 'order_id', 'document_id', 'user_id', 'created_at',
  ]);
  const grown = present.filter((c) => !base.has(c.name));

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE cash_movements_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES cash_sessions(id),
        kind TEXT NOT NULL CHECK (kind IN (${CASH_MOVEMENT_KINDS.map((k) => `'${k}'`).join(', ')})),
        amount_usd REAL NOT NULL DEFAULT 0,
        amount_lbp REAL NOT NULL DEFAULT 0,
        reason TEXT,
        note TEXT,
        order_id INTEGER REFERENCES orders(id),
        document_id INTEGER REFERENCES documents(id),
        user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Nullable and without their foreign key: every column added by `addColumn`
    // is nullable anyway, and the reference is not what the copy needs.
    for (const column of grown) {
      db.exec(`ALTER TABLE cash_movements_migrated ADD COLUMN ${column.name} ${column.type || 'TEXT'}`);
    }
    db.exec(`INSERT INTO cash_movements_migrated (${columns}) SELECT ${columns} FROM cash_movements`);
    db.exec('DROP TABLE cash_movements');
    db.exec('ALTER TABLE cash_movements_migrated RENAME TO cash_movements');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(session_id, created_at)',
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

migrateCashMovementKinds();

/*
 * The shop's own cash accounts.
 *
 * One drawer was enough while there was one counter. It stops being enough the
 * moment a transfer desk runs out of its own float and a safe sits in the back:
 * three piles of money, counted by different people at different times, and a
 * single figure covering all of them is a figure nobody can check.
 *
 * So a till is a named account. Sessions and movements belong to one, which is
 * what lets the transfer desk close and count at six while the register is
 * still trading.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS cash_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'drawer' CHECK (kind IN ('drawer', 'desk', 'safe', 'bank', 'other')),
    /* The one every screen falls back to, and the one an upgrade puts the
       existing drawer's history into. Exactly one row carries it. */
    is_default INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/*
 * Which till a sitting and a movement belong to.
 *
 * Nullable on the way in and then backfilled: everything recorded before there
 * were several tills happened at the one there was.
 */
addColumn('cash_sessions', 'account_id', 'INTEGER REFERENCES cash_accounts(id)');

/*
 * What the till already held when the sitting started.
 *
 * Not the same as the opening float, which is money *put in* now. A drawer
 * that was closed last night with $20 left in it for change starts today
 * holding $20 that nobody is adding and nobody declared — and until this
 * column existed, the sitting did not know about it. Its expected contents was
 * its own movements alone, so the count at close came out $20 over, and the
 * $20 stayed behind when the takings were carried to the safe.
 *
 * Stored rather than worked out later: a sitting closed six months ago has to
 * go on reporting the figure it was actually closed against, and the account
 * has moved on since.
 *
 * Defaults to zero, which is exactly how every sitting recorded before this
 * behaved, so nothing already in the books reads differently.
 */
addColumn('cash_sessions', 'opening_balance_usd', 'REAL NOT NULL DEFAULT 0');
addColumn('cash_sessions', 'opening_balance_lbp', 'REAL NOT NULL DEFAULT 0');
addColumn('cash_movements', 'account_id', 'INTEGER REFERENCES cash_accounts(id)');

function seedDefaultCashAccount() {
  const existing = db.prepare('SELECT id FROM cash_accounts WHERE is_default = 1').get();
  const id =
    existing?.id ??
    db
      .prepare("INSERT INTO cash_accounts (name, kind, is_default) VALUES ('Main drawer', 'drawer', 1)")
      .run().lastInsertRowid;

  // Everything that happened before tills were named happened at this one.
  db.prepare('UPDATE cash_sessions SET account_id = ? WHERE account_id IS NULL').run(id);
  db.prepare('UPDATE cash_movements SET account_id = ? WHERE account_id IS NULL').run(id);
  return id;
}

seedDefaultCashAccount();

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_cash_sessions_account ON cash_sessions(account_id, status);
  CREATE INDEX IF NOT EXISTS idx_cash_movements_account ON cash_movements(account_id, created_at);
`);

/*
 * Vouchers written before both ends were named.
 *
 * They recorded one account and a direction, which is the same fact expressed
 * with the shop's own till left implicit. Rebuilt with both sides spelled out,
 * putting the till on whichever end the money came from or went to.
 */
function migrateVouchersToTwoSides() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vouchers'").get();
  if (!row?.sql || row.sql.includes('from_type')) return;

  const till = db.prepare('SELECT id, name FROM cash_accounts WHERE is_default = 1').get();

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE vouchers RENAME TO vouchers_old');
    db.exec(`
      CREATE TABLE vouchers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        voucher_number TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('payment', 'receipt', 'transfer')),
        from_type TEXT NOT NULL CHECK (from_type IN ('cash', 'wallet', 'customer', 'supplier', 'other')),
        from_id INTEGER,
        from_name TEXT NOT NULL,
        to_type TEXT NOT NULL CHECK (to_type IN ('cash', 'wallet', 'customer', 'supplier', 'other')),
        to_id INTEGER,
        to_name TEXT NOT NULL,
        amount_usd REAL NOT NULL DEFAULT 0,
        amount_lbp REAL NOT NULL DEFAULT 0,
        exchange_rate REAL,
        reason TEXT,
        note TEXT,
        reference TEXT,
        status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
        cash_movement_id INTEGER REFERENCES cash_movements(id),
        entry_id INTEGER REFERENCES account_entries(id),
        user_id INTEGER REFERENCES users(id),
        issued_on TEXT NOT NULL DEFAULT (date('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        cancelled_at TEXT
      )
    `);

    /*
     * A payment left the till and went to the account named; a receipt came
     * from it. A voucher settled by bank had no till behind it, and is
     * recorded as coming from or going to a named "Bank" instead of pretending
     * the drawer moved.
     */
    db.prepare(
      `INSERT INTO vouchers (
         id, voucher_number, kind, from_type, from_id, from_name, to_type, to_id, to_name,
         amount_usd, amount_lbp, exchange_rate, reason, note, reference, status,
         cash_movement_id, entry_id, user_id, issued_on, created_at, cancelled_at
       )
       SELECT
         id, voucher_number, kind,
         CASE WHEN kind = 'payment' THEN (CASE WHEN method = 'cash' THEN 'cash' ELSE 'other' END)
              ELSE account_type END,
         CASE WHEN kind = 'payment' THEN (CASE WHEN method = 'cash' THEN ? ELSE NULL END)
              ELSE account_id END,
         CASE WHEN kind = 'payment' THEN (CASE WHEN method = 'cash' THEN ? ELSE method END)
              ELSE account_name END,
         CASE WHEN kind = 'payment' THEN account_type
              ELSE (CASE WHEN method = 'cash' THEN 'cash' ELSE 'other' END) END,
         CASE WHEN kind = 'payment' THEN account_id
              ELSE (CASE WHEN method = 'cash' THEN ? ELSE NULL END) END,
         CASE WHEN kind = 'payment' THEN account_name
              ELSE (CASE WHEN method = 'cash' THEN ? ELSE method END) END,
         amount_usd, amount_lbp, exchange_rate, reason, note, reference, status,
         cash_movement_id, entry_id, user_id, issued_on, created_at, cancelled_at
       FROM vouchers_old`,
    ).run(till.id, till.name, till.id, till.name);

    db.exec('DROP TABLE vouchers_old');
    db.exec('CREATE INDEX IF NOT EXISTS idx_vouchers_created ON vouchers(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_vouchers_from ON vouchers(from_type, from_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_vouchers_to ON vouchers(to_type, to_id)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

migrateVouchersToTwoSides();

/**
 * The agencies the shop runs a transfer counter for.
 *
 * OMT, Whish, Western Union. The shop is their counter, not their customer, and
 * the money crossing it is never the shop's: on a send it takes the customer's
 * cash and owes the agency the amount; on a payout it hands over its own cash
 * and the agency owes it back. What the shop keeps either way is the fee.
 *
 * So each agency carries a running balance, exactly like a supplier does, and
 * the point of it is the comparison an operator makes at the end of a day:
 * this is what the drawer says I am holding for OMT, and this is what OMT says.
 * Until it was written down, that comparison was somebody's memory.
 *
 * `opening_usd` / `opening_lbp` are where a shop that has been trading for
 * years starts from. Nobody is going to key in four hundred past transfers, so
 * the balance on the day they start using this is typed in once.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS transfer_companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    phone TEXT,
    note TEXT,
    /* Where the running balance starts, in the sign the ledger uses:
       positive means the shop owes the agency. */
    opening_usd REAL NOT NULL DEFAULT 0,
    opening_lbp REAL NOT NULL DEFAULT 0,
    opening_set_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/**
 * Let the ledger hold a transfer agency as well as a customer or a supplier.
 *
 * The three are the same fact — somebody the shop is square with or is not —
 * and one ledger means one balance query, one statement, and one way to settle
 * up. SQLite cannot widen a CHECK in place, so the table is rebuilt with every
 * row copied across; the ids are carried so nothing that points at an entry is
 * left pointing at a different one.
 */
function migrateEntriesToThreeParties() {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'account_entries'")
    .get();
  if (!row?.sql || row.sql.includes('transfer_company')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE account_entries RENAME TO account_entries_old');
    db.exec(`
      CREATE TABLE account_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        party_type TEXT NOT NULL
          CHECK (party_type IN ('customer', 'supplier', 'transfer_company')),
        party_id INTEGER NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('sale', 'payment', 'refund', 'bill', 'adjustment', 'opening')),
        amount_usd REAL NOT NULL,
        paid_usd REAL NOT NULL DEFAULT 0,
        paid_lbp REAL NOT NULL DEFAULT 0,
        exchange_rate REAL,
        order_id INTEGER REFERENCES orders(id),
        note TEXT,
        user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`
      INSERT INTO account_entries
        (id, party_type, party_id, kind, amount_usd, paid_usd, paid_lbp,
         exchange_rate, order_id, note, user_id, created_at)
      SELECT id, party_type, party_id, kind, amount_usd, paid_usd, paid_lbp,
             exchange_rate, order_id, note, user_id, created_at
      FROM account_entries_old
    `);
    db.exec('DROP TABLE account_entries_old');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_account_entries_party
        ON account_entries(party_type, party_id, created_at)
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

migrateEntriesToThreeParties();

/* Which agency a transfer was with, once they are accounts rather than words. */
addColumn('transfers', 'company_id', 'INTEGER REFERENCES transfer_companies(id)');

/*
 * Payment and receipt vouchers.
 *
 * The two movements of money that are not a sale and not a purchase: the shop
 * paying somebody, and the shop being paid. Wages, rent, an owner putting money
 * in, a supplier settled in cash, a customer paying off what they owe, credit
 * bought for a wallet — all of it is one of these two, and all of it moves the
 * drawer.
 *
 * A voucher is a piece of paper before it is a row: it is numbered, it names
 * who the money went to or came from, it says what for, and somebody signs it.
 * The table keeps the same shape so the printed slip and the record cannot
 * disagree.
 *
 * `account_type` is what the other side of the money is. Customers and
 * suppliers post to their ledger, a wallet moves its credit, and 'other' is the
 * landlord, the electrician, the owner's pocket — named in words because
 * creating a contact record for the man who fixes the generator is not worth
 * anybody's time.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_number TEXT UNIQUE NOT NULL,
    /* Derived from the two sides rather than chosen: money leaving one of the
       shop's own accounts for somebody else is a payment, the reverse is a
       receipt, and between two of its own it is neither. */
    kind TEXT NOT NULL CHECK (kind IN ('payment', 'receipt', 'transfer')),
    /* Where the money came from and where it went. Either side may be one of
       the shop's own accounts (a till, a wallet) or somebody else's (a
       customer, a supplier, a name typed in words). */
    from_type TEXT NOT NULL
      CHECK (from_type IN ('cash', 'wallet', 'customer', 'supplier', 'transfer_company', 'other')),
    from_id INTEGER,
    from_name TEXT NOT NULL,
    to_type TEXT NOT NULL
      CHECK (to_type IN ('cash', 'wallet', 'customer', 'supplier', 'transfer_company', 'other')),
    to_id INTEGER,
    to_name TEXT NOT NULL,
    amount_usd REAL NOT NULL DEFAULT 0,
    amount_lbp REAL NOT NULL DEFAULT 0,
    exchange_rate REAL,
    reason TEXT,
    note TEXT,
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
    cash_movement_id INTEGER REFERENCES cash_movements(id),
    entry_id INTEGER REFERENCES account_entries(id),
    user_id INTEGER REFERENCES users(id),
    issued_on TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    cancelled_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_vouchers_created ON vouchers(created_at);
  CREATE INDEX IF NOT EXISTS idx_vouchers_from ON vouchers(from_type, from_id);
  CREATE INDEX IF NOT EXISTS idx_vouchers_to ON vouchers(to_type, to_id);
`);

/*
 * The invoice a voucher was written for.
 *
 * Money taken across the counter against an invoice is a receipt like any
 * other, and the owner looking through the vouchers for "what came in today"
 * should find it there. It is written from the invoice rather than by hand, so
 * it carries the document it belongs to — which is also how it is kept honest:
 * a voucher with a document behind it has already moved the drawer and the
 * ledger through that document, so it must not be cancelled on its own.
 */
addColumn('vouchers', 'document_id', 'INTEGER REFERENCES documents(id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_vouchers_document ON vouchers(document_id)');

/**
 * And let a voucher settle with a transfer agency, which is how the balance an
 * agency runs up actually gets cleared.
 *
 * Written out in full rather than derived from the table as it stands: a
 * migration that rewrites its own source with a regular expression is one
 * upstream edit away from producing a table nobody meant. Every column is
 * copied by name, ids included.
 */
function migrateVouchersToTransferCompanies() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vouchers'").get();
  if (!row?.sql || row.sql.includes('transfer_company')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE vouchers RENAME TO vouchers_narrow');
    db.exec(`
      CREATE TABLE vouchers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        voucher_number TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('payment', 'receipt', 'transfer')),
        from_type TEXT NOT NULL
          CHECK (from_type IN ('cash', 'wallet', 'customer', 'supplier', 'transfer_company', 'other')),
        from_id INTEGER,
        from_name TEXT NOT NULL,
        to_type TEXT NOT NULL
          CHECK (to_type IN ('cash', 'wallet', 'customer', 'supplier', 'transfer_company', 'other')),
        to_id INTEGER,
        to_name TEXT NOT NULL,
        amount_usd REAL NOT NULL DEFAULT 0,
        amount_lbp REAL NOT NULL DEFAULT 0,
        exchange_rate REAL,
        reason TEXT,
        note TEXT,
        reference TEXT,
        status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
        cash_movement_id INTEGER REFERENCES cash_movements(id),
        entry_id INTEGER REFERENCES account_entries(id),
        user_id INTEGER REFERENCES users(id),
        issued_on TEXT NOT NULL DEFAULT (date('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        cancelled_at TEXT,
        document_id INTEGER REFERENCES documents(id)
      );
    `);

    const columns = db
      .prepare('PRAGMA table_info(vouchers_narrow)')
      .all()
      .map((c) => c.name)
      .join(', ');
    db.exec(`INSERT INTO vouchers (${columns}) SELECT ${columns} FROM vouchers_narrow`);

    db.exec('DROP TABLE vouchers_narrow');
    db.exec('CREATE INDEX IF NOT EXISTS idx_vouchers_created ON vouchers(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_vouchers_from ON vouchers(from_type, from_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_vouchers_to ON vouchers(to_type, to_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_vouchers_document ON vouchers(document_id)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

migrateVouchersToTransferCompanies();

/* Which till a transfer's money passed through. */
addColumn('transfers', 'account_id', 'INTEGER REFERENCES cash_accounts(id)');
db.prepare(
  'UPDATE transfers SET account_id = (SELECT id FROM cash_accounts WHERE is_default = 1) WHERE account_id IS NULL',
).run();

/*
 * Float accounts, for the things the shop sells that were never on a shelf.
 *
 * A recharge card is not stock. Nothing is counted out of a box when one is
 * sold — the shop holds credit with Alfa, with touch, with whoever supplies its
 * iTunes codes, and every sale spends a little of it. So the balance *is* the
 * stock, and it falls by what the card cost rather than by one.
 *
 * One currency per wallet, unlike the drawer: a drawer physically holds dollar
 * notes and pound notes side by side, while a credit account is a single figure
 * denominated in whatever the supplier bills in.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'other'
      CHECK (kind IN ('recharge', 'gift_card', 'app', 'other')),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'LBP')),
    /* Warn at the counter before the shop finds out by failing to sell. */
    low_balance REAL NOT NULL DEFAULT 0,
    note TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  /*
   * Every movement of that credit: topped up when the shop pays its supplier,
   * spent a card at a time. The balance is the sum, so it can be reconciled
   * against the supplier's own statement rather than trusted.
   */
  CREATE TABLE IF NOT EXISTS wallet_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id INTEGER NOT NULL REFERENCES wallets(id),
    kind TEXT NOT NULL CHECK (kind IN ('top_up', 'withdrawal', 'sale', 'refund', 'adjustment')),
    /* Signed, in the wallet's own currency: positive in, negative out. */
    amount REAL NOT NULL,
    /* The same movement in USD, so margin reports never depend on the rate
       that happens to be set today. */
    amount_usd REAL NOT NULL DEFAULT 0,
    exchange_rate REAL,
    order_id INTEGER REFERENCES orders(id),
    document_id INTEGER REFERENCES documents(id),
    product_id INTEGER REFERENCES products(id),
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_wallet_movements_wallet
    ON wallet_movements(wallet_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_wallet_movements_order ON wallet_movements(order_id);
`);

/*
 * What funds this product, and by implication what kind of thing it is.
 *
 * A product pointing at a wallet is sold from credit rather than from a shelf:
 * there is no quantity to run out of, and its cost comes off the wallet when it
 * sells. One column rather than a separate "is digital" flag, because the two
 * always travel together — an unlimited product whose cost came from nowhere
 * would report infinite profit.
 */
addColumn('products', 'wallet_id', 'INTEGER REFERENCES wallets(id)');

/*
 * A sale put to one side.
 *
 * Somebody is choosing a case while three people wait behind them; a phone is
 * being unboxed and checked. The cashier needs the counter back without losing
 * what has been rung up, and the alternative shops actually use — a scrap of
 * paper, or serving the queue on a second screen — is how a line goes missing.
 *
 * Held on the server rather than in the browser: the till gets refreshed, the
 * laptop goes to sleep, and the person who comes back for their bag is often
 * served by whoever is on shift rather than whoever started it.
 *
 * It is a draft, not an order. Nothing is reserved — stock still belongs to
 * whoever pays for it first — and the lines are kept as they were typed,
 * negotiated prices and all, so resuming puts the cashier back exactly where
 * they stood. What has changed in the meantime is worked out on the way back
 * in, and said out loud.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS held_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    /* What to call it on the shelf of held sales: a name, a phone, "blue case". */
    label TEXT,
    customer_id INTEGER REFERENCES customers(id),
    customer_name TEXT,
    /* The cart lines, and everything else the register had on screen. */
    cart TEXT NOT NULL,
    context TEXT,
    item_count INTEGER NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'resumed', 'voided')),
    held_by INTEGER REFERENCES users(id),
    held_at TEXT NOT NULL DEFAULT (datetime('now')),
    resumed_by INTEGER REFERENCES users(id),
    resumed_at TEXT,
    note TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_held_sales_status ON held_sales(status, held_at DESC);
`);

/*
 * The shops.
 *
 * One company, more than one counter. What they share is everything that
 * describes a thing — the product, its price, its barcodes, the customer, the
 * supplier — and what they do not share is anything physical or financial: the
 * stock on the shelf, the drawer, the day's takings, the profit.
 *
 * That split is the whole design. A second branch must not mean a second
 * catalogue: entering the same phone twice is how two shops end up with two
 * different prices for it and a stock figure that means nothing.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    /* Short, for a document number or a column heading: MAIN, SAIDA. */
    code TEXT,
    phone TEXT,
    address TEXT,
    /* Where anything that does not name a branch belongs. Exactly one. */
    is_main INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  /*
   * What is on the shelf, per shop.
   *
   * The truth about quantity. products.stock is kept as the total across every
   * branch — see lib/stock.js, which is the only thing that writes either — so
   * anything asking "how many do we own" carries on working while the register
   * asks the question that actually matters: how many are here.
   */
  CREATE TABLE IF NOT EXISTS branch_stock (
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    stock INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (branch_id, product_id)
  );

  CREATE INDEX IF NOT EXISTS idx_branch_stock_product ON branch_stock(product_id);

  /*
   * Stock moving from one shop to the other.
   *
   * Sent and received are two steps, deliberately. Between the two the goods
   * are in a car, and they have left one branch without arriving at the other —
   * stock that counts in both places at once is worse than stock that counts in
   * neither, because it can be sold twice.
   */
  CREATE TABLE IF NOT EXISTS stock_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    from_branch_id INTEGER NOT NULL REFERENCES branches(id),
    to_branch_id INTEGER NOT NULL REFERENCES branches(id),
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft', 'sent', 'received', 'cancelled')),
    note TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_by INTEGER REFERENCES users(id),
    sent_at TEXT,
    received_by INTEGER REFERENCES users(id),
    received_at TEXT
  );

  CREATE TABLE IF NOT EXISTS stock_transfer_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    /* A serialised line moves one named handset, not a quantity. */
    unit_id INTEGER REFERENCES product_units(id),
    quantity INTEGER NOT NULL DEFAULT 1,
    /* What was actually unpacked at the other end, which is not always what left. */
    received_quantity INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_stock_transfers_from ON stock_transfers(from_branch_id, status);
  CREATE INDEX IF NOT EXISTS idx_stock_transfers_to ON stock_transfers(to_branch_id, status);
  CREATE INDEX IF NOT EXISTS idx_stock_transfer_items ON stock_transfer_items(transfer_id);
`);

/*
 * Which branch a thing happened at.
 *
 * Every one of these is additive and backfilled to the main branch below, so a
 * shop that has always had one counter reads exactly as it did.
 */
addColumn('orders', 'branch_id', 'INTEGER REFERENCES branches(id)');
addColumn('stock_adjustments', 'branch_id', 'INTEGER REFERENCES branches(id)');
addColumn('product_units', 'branch_id', 'INTEGER REFERENCES branches(id)');
addColumn('cash_accounts', 'branch_id', 'INTEGER REFERENCES branches(id)');
addColumn('documents', 'branch_id', 'INTEGER REFERENCES branches(id)');
addColumn('expenses', 'branch_id', 'INTEGER REFERENCES branches(id)');
addColumn('held_sales', 'branch_id', 'INTEGER REFERENCES branches(id)');
addColumn('repair_tickets', 'branch_id', 'INTEGER REFERENCES branches(id)');
/* Where somebody works. Null means the main branch. */
addColumn('users', 'branch_id', 'INTEGER REFERENCES branches(id)');

/**
 * Give the shop its first branch, and put everything that already happened in it.
 *
 * Runs once. Until this, every sale, every count and every drawer belonged to a
 * shop with no name; afterwards they all belong to the main branch, which is
 * the same shop with a name — so nothing reads differently and a second branch
 * can be added without touching any of it.
 */
function seedMainBranch() {
  let main = db.prepare('SELECT * FROM branches WHERE is_main = 1').get();
  if (!main) {
    // Named from the shop's own name if it has set one; "Main branch" otherwise.
    const shopName = db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get()?.value;
    const info = db
      .prepare("INSERT INTO branches (name, code, is_main, active) VALUES (?, 'MAIN', 1, 1)")
      .run(shopName?.trim() || 'Main branch');
    main = db.prepare('SELECT * FROM branches WHERE id = ?').get(info.lastInsertRowid);
  }

  for (const table of [
    'orders',
    'stock_adjustments',
    'product_units',
    'cash_accounts',
    'documents',
    'expenses',
    'held_sales',
    'repair_tickets',
  ]) {
    db.prepare(`UPDATE ${table} SET branch_id = ? WHERE branch_id IS NULL`).run(main.id);
  }

  /*
   * The shelf, moved into the branch that has been holding it all along.
   *
   * Only for products with no row yet: once lib/stock.js owns the figure, a
   * product deliberately taken down to zero here must not be refilled from the
   * total on the next restart.
   */
  db.prepare(
    `INSERT INTO branch_stock (branch_id, product_id, stock)
     SELECT ?, p.id, p.stock FROM products p
     WHERE NOT EXISTS (SELECT 1 FROM branch_stock b WHERE b.product_id = p.id)`,
  ).run(main.id);

  return main;
}

seedMainBranch();

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

db.exec(`
  /*
   * Calling credit sent to a customer's phone.
   *
   * Recorded per send rather than derived from the order line, because what
   * the shop needs months later is "did the $10 reach 03 123 456" — and the
   * number it went to is not on the order at all. The message split and the
   * fee are kept as they were, so a change of carrier deal does not rewrite
   * what last month cost.
   */
  CREATE TABLE IF NOT EXISTS credit_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER REFERENCES orders(id),
    wallet_id INTEGER NOT NULL REFERENCES wallets(id),
    msisdn TEXT NOT NULL,
    amount REAL NOT NULL,
    sms_count INTEGER NOT NULL,
    fee_each REAL NOT NULL,
    fees REAL NOT NULL,
    cost REAL NOT NULL,
    charged REAL NOT NULL,
    breakdown TEXT NOT NULL,
    branch_id INTEGER REFERENCES branches(id),
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_credit_sends_order ON credit_sends(order_id);
  CREATE INDEX IF NOT EXISTS idx_credit_sends_msisdn ON credit_sends(msisdn);
`);

/*
 * A carrier the shop can send credit from, and what each message costs it.
 *
 * On the wallet because that is already what the shop's balance with Alfa or
 * Touch is. `sends_credit` is what separates a carrier you can top a customer
 * up from — where the 3/2/1 split applies — from a wallet that merely funds
 * fixed-price cards.
 */
addColumn('wallets', 'sends_credit', 'INTEGER NOT NULL DEFAULT 0');
addColumn('wallets', 'sms_fee', 'REAL NOT NULL DEFAULT 0.15');
/*
 * What the shop sells a dollar of credit for, in pounds.
 *
 * Credit is priced in pounds and nothing else — "110,000 a dollar" is the
 * number the counter quotes — so it is kept in pounds rather than derived from
 * a USD price and the rate. Derived, it would drift every time the rate moved
 * and the shop would be quoting a figure it never chose.
 */
addColumn('wallets', 'credit_price_lbp', 'REAL NOT NULL DEFAULT 110000');

/*
 * What a top-up actually cost the shop.
 *
 * Not the same as how much credit it added, and that is the whole point. A
 * shop that gets its credit by selling a 30-day validity card and taking the
 * customer's $6 back onto its own line did not pay $6 for it — the card had
 * already been paid for and sold. Left null, the credit is assumed bought at
 * face value, which is what a wallet topped up by handing a distributor cash
 * means.
 */
addColumn('wallet_movements', 'cost_usd', 'REAL');

/*
 * The two Lebanese carriers, as balances the shop can send credit out of.
 *
 * Created rather than left to be set up, because there are exactly two and
 * every shop in the country deals with both — an empty carrier list would just
 * be a form to fill in with the only two answers there are. Guarded by name, so
 * a shop that renames or closes one is left alone, and running this twice does
 * nothing.
 */
{
  const carrier = db.prepare('SELECT id FROM wallets WHERE name = ?');
  const addCarrier = db.prepare(
    `INSERT INTO wallets (name, kind, currency, sends_credit, sms_fee, note)
     VALUES (?, 'recharge', 'USD', 1, 0.15, ?)`,
  );
  for (const name of ['Alfa', 'Touch']) {
    if (!carrier.get(name)) {
      addCarrier.run(name, 'Credit sent to customers by SMS. Top this up when you buy balance.');
    }
  }
}

/*
 * A SIM is a serialised unit like a handset, but the number it carries is what
 * the shop and the customer both know it by — nobody reads an ICCID off a card
 * to find out whose line it is.
 */
addColumn('products', 'is_sim', 'INTEGER NOT NULL DEFAULT 0');

/*
 * A validity card, and what selling one actually does.
 *
 * It is not one sale but three things at once. The customer pays for days of
 * validity; a whole recharge card comes off the shop's stock to deliver them;
 * and the credit that card carries lands on the shop's own line, to be resold
 * by the dollar. Doing the second and third by hand is how a shop ends up with
 * a credit balance nobody trusts.
 *
 *   validity_days     — how long it buys, and what marks it a validity card
 *   linked_card_id    — the full card consumed to deliver it
 *   credit_recovered  — the dollars that come back onto the shop's line
 *   credit_wallet_id  — which carrier balance they land on
 *
 * The link is set by hand rather than guessed: only the shop knows which card
 * it actually scratches for a 30-day top-up, and guessing would silently spend
 * the wrong stock.
 */
addColumn('products', 'validity_days', 'INTEGER');
addColumn('products', 'linked_card_id', 'INTEGER REFERENCES products(id)');
addColumn('products', 'credit_recovered', 'REAL NOT NULL DEFAULT 0');
addColumn('products', 'credit_wallet_id', 'INTEGER REFERENCES wallets(id)');
/*
 * How much calling credit a card actually carries.
 *
 * Not its price and not its cost. A Lebanese recharge card is named by the
 * credit inside it — "$7.58" is 7.58 of credit, whatever the shop paid for the
 * card and whatever it charges for it. Keeping the three apart is the only way
 * the validity loop can say how much credit a scratched card put into play.
 */
addColumn('products', 'credits_included', 'REAL');

/*
 * The trade price, for the shops that buy from this one.
 *
 * A phone shop here sells to the public over the counter and to the repair shop
 * down the road by the box, and the second price is not a discount somebody
 * remembers — it is the price of the thing when the buyer is in the trade.
 * Kept beside the retail price rather than derived from a percentage, because
 * a fixed markup is exactly what it is not: some lines carry the shop and some
 * go out at barely over cost to keep a customer.
 *
 * Null rather than zero for "there isn't one", which is most of the catalogue.
 * Zero would mean the shop gives it away.
 */
addColumn('products', 'wholesale_price', 'REAL');

/*
 * How much of a line has come back.
 *
 * A customer returns one thing off a sale of six far more often than they hand
 * the whole sale back, and until now the only answer was to refund all of it
 * and ring the rest up again — which loses the original sale's prices, its
 * time, and its place in the day's takings.
 *
 * Counted rather than flagged, because two of five can come back today and
 * another one next week. The order's own status stays 'completed' until every
 * line is fully back, which is also the only way to say this without rebuilding
 * the table: its status column is a CHECK of exactly two values.
 */
addColumn('order_items', 'returned_qty', 'INTEGER NOT NULL DEFAULT 0');

/*
 * Which sitting of the drawer a sale belongs to.
 *
 * "What has this register sold" is really "what has been rung up since the
 * drawer was counted", because that is the span the count has to reconcile
 * against. Comparing timestamps almost works and then does not: SQLite keeps
 * these to the second, so a sale rung up in the same second the drawer opened
 * is on the wrong side of the comparison, and there is no arithmetic that fixes
 * that. Recording which sitting it was settles it exactly.
 *
 * Null for card and account sales taken with the drawer shut, and for every
 * sale made before this column existed.
 */
addColumn('orders', 'cash_session_id', 'INTEGER REFERENCES cash_sessions(id)');

/*
 * Paying for a phone over months — تقسيط.
 *
 * A plan is a **schedule over a debt the customer already owes**, not a second
 * set of books. The sale went on their account the ordinary way and the ledger
 * in account_entries is still the one true answer to what is owed; this says
 * when the shop expects it, so "who is late" is a question with an answer
 * instead of a notebook behind the counter.
 *
 * Keeping it that way is the whole design. A plan that carried its own balance
 * would disagree with the ledger the first time somebody paid off the counter
 * without mentioning the plan — and the ledger would be right.
 */
/*
 * The till's own name for a sale, so replaying one cannot ring it up twice.
 *
 * A sale made while the server was unreachable waits on the till and is sent
 * when it comes back. The dangerous case is not the send that fails — it is the
 * one that succeeds and looks like it failed: the connection drops after the
 * server has written the order but before the answer arrives, the till tries
 * again, and the shop has sold the same phone twice.
 *
 * So the till names each sale before sending it, and that name is unique here.
 * A second attempt collides, and the server hands back the sale it already has
 * instead of making another.
 */
addColumn('orders', 'client_ref', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_ref ON orders(client_ref)');

db.exec(`
  CREATE TABLE IF NOT EXISTS installment_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    order_id INTEGER REFERENCES orders(id),
    total_usd REAL NOT NULL,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled', 'cancelled')),
    branch_id INTEGER REFERENCES branches(id),
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS installment_dues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES installment_plans(id) ON DELETE CASCADE,
    due_date TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    paid_usd REAL NOT NULL DEFAULT 0,
    paid_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_dues_date ON installment_dues(due_date, paid_usd);
  CREATE INDEX IF NOT EXISTS idx_plans_customer ON installment_plans(customer_id, status);
`);
addColumn('product_units', 'msisdn', 'TEXT');
CREATE_MSISDN_INDEX: {
  db.exec('CREATE INDEX IF NOT EXISTS idx_units_msisdn ON product_units(msisdn)');
}

/*
 * One-time move of the ID photos taken against trade-ins into the general
 * table. Guarded on the destination being empty rather than on a version
 * number: run twice it does nothing, and a shop that has since added photos
 * is left alone.
 */
if (db.prepare('SELECT COUNT(*) AS n FROM id_photos').get().n === 0) {
  db.exec(`
    INSERT INTO id_photos (subject_type, subject_id, mime, byte_size, bytes, uploaded_by, created_at)
    SELECT 'trade_in', trade_in_id, mime, byte_size, bytes, uploaded_by, created_at FROM trade_in_ids
  `);
}

/*
 * Retire the invented whole-recharge denominations, once.
 *
 * The starter set used to offer round $5 / $10 / $20 / $50 recharge cards.
 * No Lebanese carrier sells those — Alfa and Touch both sell a fixed ladder
 * (3.79, 4.50, 7.58, 15.15, 22.73, 77.28), which is what the seeder offers
 * now. A card nobody can buy is worse than no card: it is a tile a cashier
 * presses and a wallet figure that never reconciles.
 *
 * Retired rather than deleted, so anything already sold against one keeps its
 * history, and guarded on a marker rather than on the rows themselves so a
 * shop that deliberately brings one back is not overruled every restart.
 */
if (!db.prepare(`SELECT value FROM settings WHERE key = 'retired_round_recharge'`).get()) {
  db.prepare(`
    UPDATE products SET active = 0
    WHERE active = 1 AND sku IN ('CARD-ALFA-WHOLE-5', 'CARD-ALFA-WHOLE-10', 'CARD-ALFA-WHOLE-20',
                                 'CARD-ALFA-WHOLE-50', 'CARD-MTC-WHOLE-5', 'CARD-MTC-WHOLE-10',
                                 'CARD-MTC-WHOLE-20', 'CARD-MTC-WHOLE-50')
  `).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('retired_round_recharge', 'done')`).run();
}

/*
 * The carrier has been Touch for years; the catalogue still said MTC.
 * Renaming the display name only — the SKUs are what everything else keys
 * off, and a shop that has printed labels should not find them orphaned.
 */
if (!db.prepare(`SELECT value FROM settings WHERE key = 'renamed_mtc_to_touch'`).get()) {
  db.prepare(`
    UPDATE products SET name = 'Touch' || substr(name, 4)
    WHERE sku LIKE 'CARD-MTC-%' AND name LIKE 'MTC %'
  `).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('renamed_mtc_to_touch', 'done')`).run();
}

/*
 * When somebody's password last changed, and whether it is still the one the
 * seed put there.
 *
 * `password_changed_at` is what makes a reset actually throw somebody out: a
 * token issued before it is refused, so an owner who resets a departing
 * cashier's password does not have to wonder whether the phone in their pocket
 * is still signed in.
 *
 * `must_change_password` marks the demo accounts. `admin/admin123` is in the
 * README, on the sign-in screen, and in every copy of this app — on a public
 * address that is not a password, it is a doorbell.
 */
addColumn('users', 'password_changed_at', 'TEXT');
addColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');

/*
 * Existing installations were seeded before that flag existed, and the two demo
 * accounts are the whole reason for it. Guarded so that somebody who has since
 * changed their password — and cleared the flag — is not nagged again on the
 * next deploy.
 */
if (!db.prepare(`SELECT value FROM settings WHERE key = 'flagged_demo_passwords'`).get()) {
  db.prepare(`
    UPDATE users SET must_change_password = 1
    WHERE username IN ('admin', 'cashier') AND password_changed_at IS NULL
  `).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('flagged_demo_passwords', 'done')`).run();
}

/*
 * A handset taken in as part of the sale that replaced it.
 *
 * On the order rather than only on the trade-in, because this is what the
 * customer settled: `total` is what the goods came to, `trade_in_value` is what
 * was knocked off for the phone they handed over, and the difference is the
 * money that actually crossed the counter — in whichever direction.
 */
/*
 * How big this person likes the text.
 *
 * Against the account rather than only the browser, because a shopkeeper signs
 * in on the counter tablet, the office laptop and their phone, and setting it
 * again on each one is the kind of small friction that makes somebody stop
 * bothering. The device still keeps its own copy so the size is right before
 * the first paint; this is what a new device starts from.
 */
addColumn('users', 'text_size', 'TEXT');
/* Light or dark, against the person — see the theme route in routes/auth.js. */
addColumn('users', 'theme', 'TEXT');

addColumn('orders', 'trade_in_value', 'REAL NOT NULL DEFAULT 0');
addColumn('orders', 'trade_in_id', 'INTEGER REFERENCES trade_ins(id)');

/*
 * Money taken on a repair, kept apart from the status.
 *
 * The two were the same thing: taking the money set the ticket to collected and
 * a collected ticket could not be moved again. That is not how the counter
 * works — plenty of customers pay the moment they hand the phone over, and the
 * screen still has to be ordered, fitted and tested afterwards.
 *
 * So payment is now its own event. `paid_usd` and `paid_lbp` accumulate across
 * however many part-payments there are, `paid_at` is the first of them, and the
 * status goes on moving underneath.
 */
addColumn('repair_tickets', 'paid_usd', 'REAL NOT NULL DEFAULT 0');
addColumn('repair_tickets', 'paid_lbp', 'REAL NOT NULL DEFAULT 0');
addColumn('repair_tickets', 'paid_at', 'TEXT');

/**
 * What actually went in the bag.
 *
 * A bundle's contents were a property of the *product* — sell a starter pack
 * and the shelves gave up whatever the catalogue said a starter pack was. But
 * the whole reason a shop sells packs is that the customer wants this case
 * rather than that one, and the counter's answer was either to refuse them or
 * to sell the pack and fix the stock by hand afterwards.
 *
 * So a bundle line now carries its own list of parts. The definition is still
 * what a pack starts as; this is what one particular pack turned out to be, and
 * it is what stock came off and what goes back on a refund. Frozen the way
 * every other line on a sale is frozen — the name and the cost are copied, so
 * a pack sold in March still reads correctly after the case is renamed or the
 * supplier puts its price up.
 *
 * Rows sold before this existed have none of these, and the readers fall back
 * to the definition for them, which is what those sales really did take.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS order_item_components (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_item_id INTEGER NOT NULL REFERENCES order_items(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    name TEXT NOT NULL,
    -- Per one of the bundle, not for the whole line: three packs of two cases
    -- is stored as 2, so the line's quantity can change what it means without
    -- rewriting these.
    quantity REAL NOT NULL,
    cost REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_order_item_components_item
    ON order_item_components(order_item_id);
`);

/**
 * The people who work here.
 *
 * An employee is a contact with a wage attached, and the shop already knows how
 * to keep a running balance with a contact — so each one gets a customer
 * account and everything else follows from that. Buying a charger on payday, an
 * advance handed over on a Tuesday, and the salary itself are all entries on
 * the one balance, which is the number the owner actually wants: what is owed,
 * in which direction, today.
 *
 * Deleting is archiving, for the same reason it is for a customer: the ledger
 * has to stay readable after somebody leaves.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The account their pay and their purchases both run through.
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    -- Set when they also sign in to the app, so a person is one person.
    user_id INTEGER REFERENCES users(id),
    name TEXT NOT NULL,
    phone TEXT,
    job_title TEXT,
    monthly_salary REAL NOT NULL DEFAULT 0,
    started_on TEXT,
    branch_id INTEGER REFERENCES branches(id),
    note TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  /*
   * One row per person per month, and the unique index is the whole point:
   * running the month twice must not pay anybody twice, and somebody will run
   * it twice.
   */
  CREATE TABLE IF NOT EXISTS employee_salaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    period TEXT NOT NULL,
    amount_usd REAL NOT NULL DEFAULT 0,
    entry_id INTEGER REFERENCES account_entries(id),
    expense_id INTEGER REFERENCES expenses(id),
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (employee_id, period)
  );

  CREATE INDEX IF NOT EXISTS idx_employees_customer ON employees(customer_id);
  CREATE INDEX IF NOT EXISTS idx_employee_salaries_period ON employee_salaries(period);
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

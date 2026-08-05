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

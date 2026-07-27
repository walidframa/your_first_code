import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * The orders table predates credit sales, so its CHECK constraint only allowed
 * cash and card. Rebuilding it must not lose a single row or column value.
 */
test('rebuilding orders for credit sales preserves existing data', () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'pos-migrate-'));
  const dbPath = path.join(workDir, 'legacy.sqlite');

  try {
    // Build a database with the pre-credit schema and a couple of real orders.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL, name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','cashier')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number TEXT UNIQUE NOT NULL,
        cashier_id INTEGER NOT NULL REFERENCES users(id),
        subtotal REAL NOT NULL, discount REAL NOT NULL DEFAULT 0,
        tax REAL NOT NULL DEFAULT 0, total REAL NOT NULL,
        payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','card')),
        amount_tendered REAL, change_due REAL,
        status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        exchange_rate REAL,
        paid_usd REAL NOT NULL DEFAULT 0, paid_lbp REAL NOT NULL DEFAULT 0,
        change_usd REAL NOT NULL DEFAULT 0, change_lbp REAL NOT NULL DEFAULT 0,
        change_currency TEXT
      );
      CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER,
        name TEXT NOT NULL, price REAL NOT NULL, quantity INTEGER NOT NULL, line_total REAL NOT NULL);
      INSERT INTO users (id, username, password_hash, name, role)
        VALUES (1, 'admin', 'x', 'Store Owner', 'admin');
      INSERT INTO orders (order_number, cashier_id, subtotal, discount, tax, total,
        payment_method, amount_tendered, change_due, status, exchange_rate,
        paid_usd, paid_lbp, change_usd, change_lbp, change_currency)
        VALUES ('ORD-1', 1, 10, 1, 0.72, 9.72, 'cash', 20, 10.28, 'completed', 89000,
                20, 0, 0, 915000, 'LBP');
      INSERT INTO orders (order_number, cashier_id, subtotal, discount, tax, total,
        payment_method, status)
        VALUES ('ORD-2', 1, 5, 0, 0.4, 5.4, 'card', 'refunded');
      INSERT INTO order_items (order_id, product_id, name, price, quantity, line_total)
        VALUES (1, 7, 'Espresso', 3.5, 2, 7);
    `);
    legacy.close();

    // Importing db.js runs the migrations against this file.
    const result = spawnSync(
      process.execPath,
      ['-e', "import('./src/db.js').then(() => console.log('migrated'))"],
      { cwd: serverRoot, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `migration failed: ${result.stderr}`);

    const migrated = new DatabaseSync(dbPath);

    const orders = migrated.prepare('SELECT * FROM orders ORDER BY id').all();
    assert.equal(orders.length, 2, 'both orders survive');

    const cash = orders[0];
    assert.equal(cash.order_number, 'ORD-1');
    assert.equal(cash.total, 9.72);
    assert.equal(cash.exchange_rate, 89000, 'dual-currency columns are carried across');
    assert.equal(cash.change_lbp, 915000);
    assert.equal(cash.change_currency, 'LBP');

    const card = orders[1];
    assert.equal(card.status, 'refunded', 'status is preserved');

    // Line items still point at their order.
    const items = migrated.prepare('SELECT * FROM order_items WHERE order_id = 1').all();
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'Espresso');

    // The new value is now accepted, and junk is still rejected.
    migrated
      .prepare(
        `INSERT INTO orders (order_number, cashier_id, subtotal, tax, total, payment_method)
         VALUES ('ORD-3', 1, 4, 0.32, 4.32, 'account')`,
      )
      .run();
    assert.throws(() =>
      migrated
        .prepare(
          `INSERT INTO orders (order_number, cashier_id, subtotal, tax, total, payment_method)
           VALUES ('ORD-4', 1, 4, 0.32, 4.32, 'barter')`,
        )
        .run(),
    );

    assert.ok(
      migrated.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'customer_id'),
      'customer_id was added',
    );
    migrated.close();

    // Running the migration again must be a no-op, not a second rebuild.
    const rerun = spawnSync(process.execPath, ['-e', "import('./src/db.js')"], {
      cwd: serverRoot,
      env: { ...process.env, DB_PATH: dbPath },
      encoding: 'utf8',
    });
    assert.equal(rerun.status, 0, `re-running migration failed: ${rerun.stderr}`);

    const after = new DatabaseSync(dbPath);
    assert.equal(after.prepare('SELECT COUNT(*) n FROM orders').get().n, 3, 'no rows duplicated or lost');
    after.close();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

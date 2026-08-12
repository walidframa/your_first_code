import bcrypt from 'bcryptjs';
import { db } from './db.js';
import { addStarterCategories } from './lib/starterCategories.js';

/*
 * Two different jobs wearing one name.
 *
 * Without an argument this fills a **demo**: sixteen products with barcodes
 * that actually scan, which is what the screenshots, the development copy and
 * the end-to-end run are all standing on.
 *
 * With `--starter` it sets up a **real shop somebody has just paid for**. That
 * shop wants its own stock, not a catalogue of espresso and croissants it has
 * to find and delete before it can trust anything on the screen — so it gets
 * the shelves a phone shop files by, and nothing on them.
 */
const starter = process.argv.includes('--starter');

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

if (userCount === 0) {
  /*
   * Flagged as needing a change on the way in, not by a migration afterwards.
   *
   * These two passwords are in the README, on the sign-in screen and in every
   * copy of this app, so on anything reachable from the internet they are a
   * doorbell rather than a lock. The app makes whoever signs in with one change
   * it before they can do anything else.
   */
  const insertUser = db.prepare(
    `INSERT INTO users (username, password_hash, name, role, must_change_password)
     VALUES (?, ?, ?, ?, 1)`,
  );
  insertUser.run('admin', bcrypt.hashSync('admin123', 10), 'Store Owner', 'admin');
  insertUser.run('cashier', bcrypt.hashSync('cashier123', 10), 'Front Register', 'cashier');
  console.log('Seeded users: admin/admin123, cashier/cashier123 — both must be changed on sign-in');
} else {
  console.log('Users already exist, skipping user seed');
}

const categoryCount = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;

if (starter) {
  const added = addStarterCategories(db);
  console.log(
    added.length
      ? `Set up ${added.length} categories for a phone shop, and no products — the shop adds its own`
      : 'Categories already exist, leaving them alone',
  );
} else if (categoryCount === 0) {
  const insertCategory = db.prepare('INSERT INTO categories (name) VALUES (?)');
  const categories = ['Beverages', 'Bakery', 'Snacks', 'Apparel'];
  const ids = Object.fromEntries(categories.map((name) => [name, insertCategory.run(name).lastInsertRowid]));

  const insertProduct = db.prepare(`
    INSERT INTO products (name, sku, barcode, price, cost, stock, reorder_point, category_id, supplier)
    VALUES (@name, @sku, @barcode, @price, @cost, @stock, @reorder_point, @category_id, @supplier)
  `);

  // Barcodes are real EAN-13: the final digit is the modulo-10 check digit, so
  // they scan on actual hardware rather than only looking plausible.
  const products = [
    ['Espresso', 'BEV-001', '5012345000015', 3.5, 1.0, 100, 20, 'Beverages', 'Blue Bottle Roasters'],
    ['Iced Latte', 'BEV-002', '5012345000022', 4.75, 1.5, 80, 20, 'Beverages', 'Blue Bottle Roasters'],
    ['Orange Juice', 'BEV-003', '5012345000039', 3.25, 1.2, 60, 15, 'Beverages', 'Valley Farms'],
    ['Sparkling Water', 'BEV-004', '5012345000046', 2.25, 0.6, 8, 24, 'Beverages', 'Valley Farms'],
    ['Croissant', 'BAK-001', '5012345000053', 3.0, 0.9, 40, 12, 'Bakery', 'Corner Bakehouse'],
    ['Bagel', 'BAK-002', '5012345000060', 2.75, 0.8, 45, 12, 'Bakery', 'Corner Bakehouse'],
    ['Chocolate Muffin', 'BAK-003', '5012345000077', 3.25, 1.0, 6, 12, 'Bakery', 'Corner Bakehouse'],
    ['Sourdough Loaf', 'BAK-004', '5012345000084', 6.5, 2.1, 18, 8, 'Bakery', 'Corner Bakehouse'],
    ['Potato Chips', 'SNK-001', '5012345000091', 2.5, 0.7, 90, 25, 'Snacks', 'Harvest Foods'],
    ['Trail Mix', 'SNK-002', '5012345000107', 4.0, 1.4, 50, 15, 'Snacks', 'Harvest Foods'],
    ['Chocolate Bar', 'SNK-003', '5012345000114', 2.25, 0.6, 100, 30, 'Snacks', 'Harvest Foods'],
    ['Protein Bar', 'SNK-004', '5012345000121', 3.75, 1.3, 0, 20, 'Snacks', 'Harvest Foods'],
    ['Logo T-Shirt', 'APP-001', '5012345000138', 19.99, 6.0, 25, 10, 'Apparel', 'Northside Apparel'],
    ['Tote Bag', 'APP-002', '5012345000145', 14.99, 4.5, 30, 10, 'Apparel', 'Northside Apparel'],
    ['Baseball Cap', 'APP-003', '5012345000152', 16.99, 5.0, 4, 10, 'Apparel', 'Northside Apparel'],
    ['Enamel Mug', 'APP-004', '5012345000169', 12.5, 3.8, 22, 8, 'Apparel', 'Northside Apparel'],
  ];

  for (const [name, sku, barcode, price, cost, stock, reorder_point, category, supplier] of products) {
    insertProduct.run({
      name,
      sku,
      barcode,
      price,
      cost,
      stock,
      reorder_point,
      category_id: ids[category],
      supplier,
    });
  }

  console.log(`Seeded ${categories.length} categories and ${products.length} products`);
} else {
  console.log('Categories already exist, skipping product seed');
}

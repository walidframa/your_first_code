/**
 * A phone shop worth photographing.
 *
 * The manual's screenshots are of a real running copy of this app, so whatever
 * is in the database is what the customer sees on the page. The ordinary demo
 * seed is a café — sixteen products of espresso, croissants and tote bags — and
 * a manual for a phone shop illustrated with bakery items is a manual nobody
 * believes.
 *
 * So this replaces the catalogue with the stock a Beirut phone shop actually
 * carries, at prices in the right neighbourhood, and adds the handful of
 * customers, sales and repairs that make the reporting screens show something
 * other than a row of zeroes. An empty dashboard photographs as a broken one.
 *
 * Everything goes in through the app's own libraries rather than by writing the
 * tables directly — stock in particular, which has one write path on purpose.
 */
import { db } from '../../server/src/db.js';
import { setStock } from '../../server/src/lib/stock.js';
import { addStarterCategories } from '../../server/src/lib/starterCategories.js';

const say = (m) => console.log(`  ${m}`);

/* --------------------------------------------------------------- the shelves */

addStarterCategories(db);
const categoryId = Object.fromEntries(
  db
    .prepare('SELECT id, name FROM categories')
    .all()
    .map((c) => [c.name, c.id]),
);

/* ---------------------------------------------------------------- the stock */

/*
 * Prices in US dollars, which is how this app holds them and how these shops
 * quote them. The pound figures on every screen come from the day's rate.
 *
 * The stock numbers are chosen to make the screens tell a story: a couple of
 * lines below their reorder point so the low-stock warnings are visible, one at
 * zero so "out of stock" can be photographed, and the rest comfortable.
 */
const PRODUCTS = [
  // name, sku, barcode, price, cost, stock, reorder, category, supplier
  ['iPhone 15 128GB', 'PH-I15-128', '5901234123457', 799, 690, 6, 3, 'Phones', 'Beirut Mobile Import'],
  ['iPhone 14 128GB', 'PH-I14-128', '5901234123464', 649, 555, 4, 3, 'Phones', 'Beirut Mobile Import'],
  ['Samsung Galaxy S24', 'PH-S24-256', '5901234123471', 749, 640, 5, 3, 'Phones', 'Beirut Mobile Import'],
  ['Samsung Galaxy A15', 'PH-A15-128', '5901234123488', 179, 142, 12, 5, 'Phones', 'Beirut Mobile Import'],
  ['Xiaomi Redmi Note 13', 'PH-RN13-256', '5901234123495', 209, 168, 9, 5, 'Phones', 'Levant Distribution'],
  ['iPad 10th Gen 64GB', 'TB-IPAD10', '5901234123501', 429, 375, 3, 2, 'Tablets', 'Beirut Mobile Import'],
  ['Apple Watch SE', 'WT-AWSE', '5901234123518', 259, 220, 2, 3, 'Smart watches', 'Beirut Mobile Import'],
  ['AirPods Pro 2', 'HP-APP2', '5901234123525', 249, 205, 8, 4, 'Headphones', 'Beirut Mobile Import'],
  ['JBL Tune 510BT', 'HP-JBL510', '5901234123532', 45, 32, 14, 6, 'Headphones', 'Levant Distribution'],
  ['JBL Go 3 Speaker', 'SP-JBLGO3', '5901234123549', 39, 27, 11, 5, 'Speakers', 'Levant Distribution'],
  ['Anker 20W USB-C Charger', 'CH-ANK20', '5901234123556', 19, 11, 30, 10, 'Chargers', 'Levant Distribution'],
  ['Original Apple 20W Charger', 'CH-APL20', '5901234123563', 29, 21, 16, 8, 'Chargers', 'Beirut Mobile Import'],
  ['USB-C to Lightning Cable 1m', 'CB-CL1M', '5901234123570', 15, 8, 40, 15, 'Cables', 'Levant Distribution'],
  ['USB-C to USB-C Cable 2m', 'CB-CC2M', '5901234123587', 12, 6, 2, 15, 'Cables', 'Levant Distribution'],
  ['Anker PowerCore 10000', 'PB-ANK10K', '5901234123594', 35, 24, 7, 4, 'Power banks', 'Levant Distribution'],
  ['Silicone Case iPhone 15', 'CS-I15-SIL', '5901234123600', 12, 4, 25, 10, 'Cases & covers', 'Sin El Fil Accessories'],
  ['Clear Case Galaxy S24', 'CS-S24-CLR', '5901234123617', 10, 3, 18, 10, 'Cases & covers', 'Sin El Fil Accessories'],
  ['Tempered Glass iPhone 15', 'SP-I15-GLS', '5901234123624', 8, 2, 0, 20, 'Screen protectors', 'Sin El Fil Accessories'],
  ['Tempered Glass Galaxy S24', 'SP-S24-GLS', '5901234123631', 8, 2, 22, 20, 'Screen protectors', 'Sin El Fil Accessories'],
  ['SanDisk 64GB microSD', 'MC-SD64', '5901234123648', 11, 6, 20, 8, 'Memory cards', 'Levant Distribution'],
  ['iPhone 12 64GB (used)', 'SH-I12-64', '5901234123655', 329, 270, 2, 1, 'Second hand', 'Trade-in'],
];

const upsert = db.prepare(`
  INSERT INTO products (name, sku, barcode, price, cost, reorder_point, category_id, supplier)
  VALUES (@name, @sku, @barcode, @price, @cost, @reorder_point, @category_id, @supplier)
  ON CONFLICT(sku) DO UPDATE SET
    name = @name, price = @price, cost = @cost,
    reorder_point = @reorder_point, category_id = @category_id, supplier = @supplier
`);

/*
 * The café is cleared out rather than left alongside.
 *
 * A catalogue with both in it photographs as a shop that sells iPhones and
 * croissants, and the low-stock screen would be full of bagels.
 */
const cafe = db
  .prepare(`SELECT id FROM products WHERE sku LIKE 'BEV-%' OR sku LIKE 'BAK-%'
            OR sku LIKE 'SNK-%' OR sku LIKE 'APP-%'`)
  .all();
if (cafe.length) {
  const drop = db.prepare('DELETE FROM products WHERE id = ?');
  for (const p of cafe) {
    // Only stock that nothing else refers to; a product on an old order stays.
    const used = db.prepare('SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1').get(p.id);
    if (!used) drop.run(p.id);
  }
  say(`cleared ${cafe.length} demo café lines`);
}

for (const [name, sku, barcode, price, cost, stock, reorder_point, category, supplier] of PRODUCTS) {
  upsert.run({
    name,
    sku,
    barcode,
    price,
    cost,
    reorder_point,
    category_id: categoryId[category] ?? null,
    supplier,
  });
  const id = db.prepare('SELECT id FROM products WHERE sku = ?').get(sku).id;
  setStock({ branchId: null, productId: id, stock });
}
say(`${PRODUCTS.length} products on the shelves`);

/* ------------------------------------------------------------- the people */

const CUSTOMERS = [
  ['Rami Haddad', '03 456 789', 'Achrafieh'],
  ['Nour Khalil', '71 223 118', 'Hamra'],
  ['Elie Mansour', '76 998 040', 'Jounieh'],
  ['Layal Saad', '03 771 260', 'Sin El Fil'],
];

const hasCustomer = db.prepare('SELECT id FROM customers WHERE name = ?');
const addCustomer = db.prepare('INSERT INTO customers (name, phone, address) VALUES (?, ?, ?)');
for (const [name, phone, address] of CUSTOMERS) {
  if (!hasCustomer.get(name)) addCustomer.run(name, phone, address);
}
say(`${CUSTOMERS.length} customers`);

const SUPPLIERS = [
  ['Beirut Mobile Import', '01 350 220'],
  ['Levant Distribution', '01 480 907'],
  ['Sin El Fil Accessories', '01 499 133'],
];
const hasSupplier = db.prepare('SELECT id FROM suppliers WHERE name = ?');
const addSupplier = db.prepare('INSERT INTO suppliers (name, phone) VALUES (?, ?)');
for (const [name, phone] of SUPPLIERS) {
  if (!hasSupplier.get(name)) addSupplier.run(name, phone);
}
say(`${SUPPLIERS.length} suppliers`);

/* ------------------------------------------------------------ the settings */

/*
 * A rate somebody would recognise, and tax left off.
 *
 * Off is both the app's default and the honest one for most of these shops, and
 * a manual that photographs a tax line the reader does not have is a manual
 * that gets a phone call.
 */
const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
put.run('exchange_rate', '89000');
put.run('lbp_rounding', '1000');
put.run('company_name', 'XTech Mobile');
put.run('company_phone', '01 350 100');
put.run('company_address', 'Sin El Fil, Beirut');
say('exchange rate 89,000 and the shop named');

/*
 * A second person, so the staff screen is not a list of one and the permission
 * columns have something to show.
 */
if (!db.prepare(`SELECT 1 FROM users WHERE username = 'sara'`).get()) {
  /*
   * Her password is the demo cashier's, borrowed rather than hashed here.
   *
   * bcrypt lives in the server's own dependencies and this file sits outside
   * them, and pulling a hashing library into the documentation build to invent
   * a password for a database that is deleted twenty seconds later is not worth
   * the wiring.
   */
  const borrowed = db
    .prepare(`SELECT password_hash FROM users WHERE username IN ('cashier','admin') LIMIT 1`)
    .get();
  if (borrowed) {
    db.prepare(
      `INSERT INTO users (username, password_hash, name, role, must_change_password)
       VALUES (?, ?, ?, ?, 0)`,
    ).run('sara', borrowed.password_hash, 'Sara Y.', 'cashier');
    say('a second staff account');
  }
}

// The demo admin must not be stopped by the change-your-password screen on the
// way to every screenshot. This copy is thrown away when the build finishes.
db.prepare(`UPDATE users SET must_change_password = 0`).run();

console.log('\n  A phone shop, ready to photograph.\n');

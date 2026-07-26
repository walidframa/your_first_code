import bcrypt from 'bcryptjs';
import { db } from './db.js';

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

if (userCount === 0) {
  const insertUser = db.prepare(
    'INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)',
  );
  insertUser.run('admin', bcrypt.hashSync('admin123', 10), 'Store Owner', 'admin');
  insertUser.run('cashier', bcrypt.hashSync('cashier123', 10), 'Front Register', 'cashier');
  console.log('Seeded users: admin/admin123, cashier/cashier123');
} else {
  console.log('Users already exist, skipping user seed');
}

const categoryCount = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;

if (categoryCount === 0) {
  const insertCategory = db.prepare('INSERT INTO categories (name) VALUES (?)');
  const categories = ['Beverages', 'Bakery', 'Snacks', 'Apparel'];
  const ids = Object.fromEntries(categories.map((name) => [name, insertCategory.run(name).lastInsertRowid]));

  const insertProduct = db.prepare(`
    INSERT INTO products (name, sku, barcode, price, cost, stock, reorder_point, category_id, supplier)
    VALUES (@name, @sku, @barcode, @price, @cost, @stock, @reorder_point, @category_id, @supplier)
  `);

  const products = [
    ['Espresso', 'BEV-001', '5012345000011', 3.5, 1.0, 100, 20, 'Beverages', 'Blue Bottle Roasters'],
    ['Iced Latte', 'BEV-002', '5012345000028', 4.75, 1.5, 80, 20, 'Beverages', 'Blue Bottle Roasters'],
    ['Orange Juice', 'BEV-003', '5012345000035', 3.25, 1.2, 60, 15, 'Beverages', 'Valley Farms'],
    ['Sparkling Water', 'BEV-004', '5012345000042', 2.25, 0.6, 8, 24, 'Beverages', 'Valley Farms'],
    ['Croissant', 'BAK-001', '5012345000059', 3.0, 0.9, 40, 12, 'Bakery', 'Corner Bakehouse'],
    ['Bagel', 'BAK-002', '5012345000066', 2.75, 0.8, 45, 12, 'Bakery', 'Corner Bakehouse'],
    ['Chocolate Muffin', 'BAK-003', '5012345000073', 3.25, 1.0, 6, 12, 'Bakery', 'Corner Bakehouse'],
    ['Sourdough Loaf', 'BAK-004', '5012345000080', 6.5, 2.1, 18, 8, 'Bakery', 'Corner Bakehouse'],
    ['Potato Chips', 'SNK-001', '5012345000097', 2.5, 0.7, 90, 25, 'Snacks', 'Harvest Foods'],
    ['Trail Mix', 'SNK-002', '5012345000103', 4.0, 1.4, 50, 15, 'Snacks', 'Harvest Foods'],
    ['Chocolate Bar', 'SNK-003', '5012345000110', 2.25, 0.6, 100, 30, 'Snacks', 'Harvest Foods'],
    ['Protein Bar', 'SNK-004', '5012345000127', 3.75, 1.3, 0, 20, 'Snacks', 'Harvest Foods'],
    ['Logo T-Shirt', 'APP-001', '5012345000134', 19.99, 6.0, 25, 10, 'Apparel', 'Northside Apparel'],
    ['Tote Bag', 'APP-002', '5012345000141', 14.99, 4.5, 30, 10, 'Apparel', 'Northside Apparel'],
    ['Baseball Cap', 'APP-003', '5012345000158', 16.99, 5.0, 4, 10, 'Apparel', 'Northside Apparel'],
    ['Enamel Mug', 'APP-004', '5012345000165', 12.5, 3.8, 22, 8, 'Apparel', 'Northside Apparel'],
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

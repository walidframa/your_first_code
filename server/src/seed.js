import bcrypt from 'bcryptjs';
import { db } from './db.js';

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

if (userCount === 0) {
  const insertUser = db.prepare(
    'INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)'
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
  const ids = categories.map((name) => insertCategory.run(name).lastInsertRowid);

  const insertProduct = db.prepare(`
    INSERT INTO products (name, sku, price, cost, stock, category_id, image_emoji)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const products = [
    ['Espresso', 'BEV-001', 3.5, 1.0, 100, ids[0], '☕'],
    ['Iced Latte', 'BEV-002', 4.75, 1.5, 80, ids[0], '🧋'],
    ['Orange Juice', 'BEV-003', 3.25, 1.2, 60, ids[0], '🧃'],
    ['Croissant', 'BAK-001', 3.0, 0.9, 40, ids[1], '🥐'],
    ['Bagel', 'BAK-002', 2.75, 0.8, 45, ids[1], '🥯'],
    ['Chocolate Muffin', 'BAK-003', 3.25, 1.0, 35, ids[1], '🧁'],
    ['Potato Chips', 'SNK-001', 2.5, 0.7, 90, ids[2], '🍟'],
    ['Trail Mix', 'SNK-002', 4.0, 1.4, 50, ids[2], '🥜'],
    ['Chocolate Bar', 'SNK-003', 2.25, 0.6, 100, ids[2], '🍫'],
    ['Logo T-Shirt', 'APP-001', 19.99, 6.0, 25, ids[3], '👕'],
    ['Tote Bag', 'APP-002', 14.99, 4.5, 30, ids[3], '👜'],
    ['Baseball Cap', 'APP-003', 16.99, 5.0, 20, ids[3], '🧢'],
  ];

  for (const p of products) insertProduct.run(...p);
  console.log(`Seeded ${categories.length} categories and ${products.length} products`);
} else {
  console.log('Categories already exist, skipping product seed');
}

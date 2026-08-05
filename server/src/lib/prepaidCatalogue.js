/**
 * A ready-made catalogue of the cards a Lebanese phone shop sells all day.
 *
 * These are typed once by somebody, or typed once by us. Validity and recharge
 * prices barely move, and a cashier tapping "ALFA 7.58 · 1 month" is doing in
 * one press what would otherwise be a name, a price and a wallet every time.
 *
 * The prices are the shop's own selling prices, in dollars, with the pound
 * figure derived from the rate like everything else in the app. Cost is seeded
 * equal to price — the shop's dealer discount is its own business, and a
 * guessed one would report a margin nobody earned. Editing the cost is the
 * first thing the Cards screen invites.
 */
import { db } from '../db.js';

/** [name, sku suffix, price] within a section. */
const VALIDITY = [
  ['ALFA 4.5 · 1 month', 'ALFA-4-5-1M', 3.11],
  ['ALFA 7.58 · 1 month', 'ALFA-7-58-1M', 3.11],
  ['ALFA 10 · 1 month', 'ALFA-10-1M', 3.11],
  ['ALFA 77.28 · 1 year', 'ALFA-77-28-1Y', 22.22],
  ['ALFA 7.58x2 · 2 months', 'ALFA-7-58X2-2M', 6.7],
  ['ALFA 15.15 · 2 months', 'ALFA-15-15-2M', 6.7],
  ['ALFA beast · 3 months', 'ALFA-BEAST-3M', 8.88],
  ['ALFA 15.15+7.58 · 3 months', 'ALFA-15-15-7-58-3M', 8.88],
  ['ALFA offer bundle · 6 months', 'ALFA-OFFER-6M', 11.11],
  ['MTC 4.5 · 1 month', 'MTC-4-5-1M', 3.11],
  ['MTC 7.58 · 1 month', 'MTC-7-58-1M', 3.11],
  ['MTC 10 · 1 month', 'MTC-10-1M', 3.11],
  ['MTC 77.28 · 1 year', 'MTC-77-28-1Y', 22.22],
  ['MTC 7.58x2 · 2 months', 'MTC-7-58X2-2M', 6.11],
  ['MTC 15.15 · 2 months', 'MTC-15-15-2M', 6.11],
  ['MTC 15.15+7.58 · 3 months', 'MTC-15-15-7-58-3M', 8.88],
  ['MTC beast · 3 months', 'MTC-BEAST-3M', 8.88],
  ['MTC offer bundle · 6 months', 'MTC-OFFER-6M', 11.11],
];

/*
 * Whole recharge goes entirely to credit, so the denominations are round and
 * the price is the face value until the shop adds its own fee.
 */
const WHOLE = [5, 10, 20, 50].flatMap((amount) => [
  [`ALFA whole recharge $${amount}`, `ALFA-WHOLE-${amount}`, amount],
  [`MTC whole recharge $${amount}`, `MTC-WHOLE-${amount}`, amount],
]);

const GIFT = [
  ['iTunes $10', 'ITUNES-10', 10],
  ['iTunes $25', 'ITUNES-25', 25],
  ['iTunes $50', 'ITUNES-50', 50],
  ['Google Play $10', 'GPLAY-10', 10],
  ['Google Play $25', 'GPLAY-25', 25],
  ['PlayStation $10', 'PSN-10', 10],
  ['PlayStation $25', 'PSN-25', 25],
  ['Roblox $10', 'ROBLOX-10', 10],
  ['Roblox $25', 'ROBLOX-25', 25],
  ['Steam $20', 'STEAM-20', 20],
];

/**
 * The three sections, each with the wallet that funds it.
 *
 * Recharge and whole recharge share one wallet because they are the same credit
 * with the operator; gift-card codes are bought from somebody else entirely, so
 * their balance has to be its own or neither figure means anything.
 */
export const STARTER_SECTIONS = [
  {
    category: 'Recharge',
    wallet: { name: 'Mobile recharge', kind: 'recharge', currency: 'USD' },
    emoji: '📶',
    cards: VALIDITY,
  },
  {
    category: 'Whole Recharge',
    wallet: { name: 'Mobile recharge', kind: 'recharge', currency: 'USD' },
    emoji: '📱',
    cards: WHOLE,
  },
  {
    category: 'Gift Cards',
    wallet: { name: 'Digital cards', kind: 'gift_card', currency: 'USD' },
    emoji: '🎁',
    cards: GIFT,
  },
];

export const STARTER_CARD_COUNT = STARTER_SECTIONS.reduce((n, s) => n + s.cards.length, 0);

function findOrCreateCategory(name) {
  const existing = db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO categories (name) VALUES (?)').run(name).lastInsertRowid;
}

function findOrCreateWallet({ name, kind, currency }) {
  const existing = db.prepare('SELECT id FROM wallets WHERE name = ?').get(name);
  if (existing) return existing.id;
  return db
    .prepare('INSERT INTO wallets (name, kind, currency) VALUES (?, ?, ?)')
    .run(name, kind, currency).lastInsertRowid;
}

/**
 * Install the starter catalogue, skipping anything already there.
 *
 * Idempotent on purpose: a shopkeeper who presses the button twice, or who
 * deleted two cards they do not sell, should get the missing ones and no
 * duplicates. Existing products are left exactly as they are — the prices may
 * well have been edited, and this must not undo that.
 */
export function installStarterCatalogue({ userId = null } = {}) {
  const insert = db.prepare(`
    INSERT INTO products (name, sku, price, cost, stock, category_id, image_emoji, wallet_id, reorder_point)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, 0)
  `);
  const exists = db.prepare('SELECT id FROM products WHERE sku = ?');

  let added = 0;
  let skipped = 0;
  const walletIds = new Set();

  for (const section of STARTER_SECTIONS) {
    const categoryId = findOrCreateCategory(section.category);
    const walletId = findOrCreateWallet(section.wallet);
    walletIds.add(walletId);

    for (const [name, suffix, price] of section.cards) {
      const sku = `CARD-${suffix}`;
      if (exists.get(sku)) {
        skipped += 1;
        continue;
      }
      insert.run(name, sku, price, price, categoryId, section.emoji, walletId);
      added += 1;
    }
  }

  return { added, skipped, wallets: walletIds.size, userId };
}

/**
 * Credit the shop holds with a supplier, and the cards sold out of it.
 *
 * A phone shop sells two kinds of thing. One is stock: it arrives in a box, it
 * is counted, and when the count reaches zero there is nothing left to sell.
 * The other never exists physically at all — a month of Alfa validity, a $25
 * iTunes code — and what limits it is not a shelf but the credit the shop has
 * bought from whoever supplies it.
 *
 * So a wallet is the stock level for those products. Selling a card does not
 * decrement a quantity; it spends the card's cost out of the wallet, and topping
 * the wallet up is the equivalent of taking a delivery.
 */
import { db } from '../db.js';
import { round2 } from './currency.js';
import { getSettings } from './settings.js';

export const WALLET_KINDS = ['recharge', 'gift_card', 'app', 'other'];
export const WALLET_CURRENCIES = ['USD', 'LBP'];
export const MOVEMENT_KINDS = ['top_up', 'withdrawal', 'sale', 'refund', 'adjustment'];

/** Amounts are whole pounds or cents depending on the wallet's currency. */
export function roundAmount(amount, currency) {
  const n = Number(amount) || 0;
  return currency === 'LBP' ? Math.round(n) : round2(n);
}

export function balanceOf(walletId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_movements WHERE wallet_id = ?')
    .get(walletId);
  const wallet = db.prepare('SELECT currency FROM wallets WHERE id = ?').get(walletId);
  return roundAmount(row.balance, wallet?.currency || 'USD');
}

/** Balances for every wallet at once, so a list is one query rather than N. */
export function balanceMap() {
  const rows = db
    .prepare('SELECT wallet_id, COALESCE(SUM(amount), 0) AS balance FROM wallet_movements GROUP BY wallet_id')
    .all();
  return new Map(rows.map((r) => [r.wallet_id, r.balance]));
}

export function walletById(id) {
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(id);
  if (!wallet) return null;
  return { ...wallet, active: !!wallet.active, balance: balanceOf(wallet.id) };
}

export function listWallets({ activeOnly = false } = {}) {
  const rows = db
    .prepare(
      `SELECT w.*, (SELECT COUNT(*) FROM products p WHERE p.wallet_id = w.id AND p.active = 1) AS product_count
       FROM wallets w ${activeOnly ? 'WHERE w.active = 1' : ''} ORDER BY w.name`,
    )
    .all();
  const balances = balanceMap();
  return rows.map((w) => ({
    ...w,
    active: !!w.active,
    balance: roundAmount(balances.get(w.id) || 0, w.currency),
  }));
}

export function movementsFor(walletId, limit = 100) {
  return db
    .prepare(
      `SELECT m.*, u.name AS user_name, o.order_number, d.doc_number, p.name AS product_name
       FROM wallet_movements m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN orders o ON o.id = m.order_id
       LEFT JOIN documents d ON d.id = m.document_id
       LEFT JOIN products p ON p.id = m.product_id
       WHERE m.wallet_id = ?
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
    )
    .all(walletId, Math.min(Number(limit) || 100, 500));
}

/**
 * Record credit moving in or out.
 *
 * `amount` is in the wallet's own currency and signed — the sign says what
 * happened, so there is one column to add up rather than a kind to interpret.
 */
export function recordMovement({
  walletId,
  kind,
  amount,
  amountUsd = null,
  note = null,
  orderId = null,
  productId = null,
  userId = null,
}) {
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
  if (!wallet) throw new Error('That wallet does not exist');
  if (!MOVEMENT_KINDS.includes(kind)) throw new Error(`Unknown wallet movement: ${kind}`);

  const { exchange_rate: rate } = getSettings();
  const value = roundAmount(amount, wallet.currency);
  if (value === 0) return null;

  /*
   * The USD figure is stored rather than derived. A pound wallet reconstructed
   * at today's rate would rewrite what last month's cards cost every time the
   * rate moved, which is the same mistake as reading a product's current cost
   * for an old sale.
   */
  const usd =
    amountUsd !== null
      ? round2(amountUsd)
      : wallet.currency === 'USD'
        ? value
        : rate > 0
          ? round2(value / rate)
          : 0;

  const info = db
    .prepare(
      `INSERT INTO wallet_movements
         (wallet_id, kind, amount, amount_usd, exchange_rate, order_id, product_id, note, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(wallet.id, kind, value, usd, rate || null, orderId, productId, note, userId);

  return info.lastInsertRowid;
}

/**
 * What one line of cards costs the wallet that funds them.
 *
 * Costs are held in USD everywhere in the app, so a pound-denominated wallet is
 * charged the converted figure. Both are returned: the wallet moves in its own
 * currency, the books stay in dollars.
 */
export function costOfLine(wallet, costUsd, quantity, rate = null) {
  /*
   * The rate can be given rather than read. A document's effect is undone with
   * the rate it was confirmed at, so cancelling it takes back exactly what it
   * put on — otherwise a pound wallet would keep a sliver of credit every time
   * the rate moved between the two.
   */
  const useRate = rate === null ? getSettings().exchange_rate : rate;
  const usd = round2((Number(costUsd) || 0) * quantity);
  const amount = wallet.currency === 'LBP' ? Math.round(usd * (useRate || 0)) : usd;
  return { usd, amount };
}

/**
 * Spend a sale's cost out of the wallets that funded it.
 *
 * Called from inside the order transaction, so a card cannot be sold without
 * the credit behind it being spent.
 *
 * It does not refuse an overdrawn wallet. A cashier facing a customer cannot
 * fix a supplier balance, and a card that has already been handed over is sold
 * whatever the ledger says — so the balance is allowed to go negative and shown
 * as such, which is a bill to settle rather than a sale to lose.
 */
export function chargeSale({ walletId, product, quantity, orderId, userId }) {
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
  if (!wallet) throw new Error(`${product.name} is funded by a wallet that no longer exists`);

  const { usd, amount } = costOfLine(wallet, product.cost, quantity);
  if (amount === 0) return null;

  return recordMovement({
    walletId: wallet.id,
    kind: 'sale',
    amount: -amount,
    amountUsd: -usd,
    orderId,
    productId: product.id,
    userId,
    note: `${quantity} × ${product.name}`,
  });
}

/**
 * Put back what a refunded order spent.
 *
 * Reversing the recorded movements rather than recomputing the cost: what was
 * taken out is what goes back, even if the card's cost or the rate has moved
 * since.
 */
export function refundOrder(orderId, userId = null) {
  const spent = db
    .prepare("SELECT * FROM wallet_movements WHERE order_id = ? AND kind = 'sale'")
    .all(orderId);

  for (const m of spent) {
    db.prepare(
      `INSERT INTO wallet_movements
         (wallet_id, kind, amount, amount_usd, exchange_rate, order_id, product_id, note, user_id)
       VALUES (?, 'refund', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.wallet_id, -m.amount, -m.amount_usd, m.exchange_rate, orderId, m.product_id, 'Refunded', userId);
  }

  return spent.length;
}

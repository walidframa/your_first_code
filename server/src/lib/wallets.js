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
import { mainBranchId } from './stock.js';
import { dayEndUtc, dayStartUtc } from './shopTime.js';

export const WALLET_KINDS = ['recharge', 'gift_card', 'app', 'other'];
export const WALLET_CURRENCIES = ['USD', 'LBP'];
export const MOVEMENT_KINDS = ['top_up', 'withdrawal', 'sale', 'refund', 'adjustment'];

/** Amounts are whole pounds or cents depending on the wallet's currency. */
export function roundAmount(amount, currency) {
  const n = Number(amount) || 0;
  return currency === 'LBP' ? Math.round(n) : round2(n);
}

/*
 * A wallet's balance is kept per branch.
 *
 * Each branch holds its own line with the carrier and sells its own cards out
 * of it, so "what is left on the I-Pick wallet" has a different answer at each
 * counter. The wallet is the name they share; the movements say whose credit
 * moved. Asked without a branch, the answer is the company's total.
 */
export function balanceOf(walletId, branchId = null) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_movements
        WHERE wallet_id = ? AND (? IS NULL OR branch_id = ?)`,
    )
    .get(walletId, branchId, branchId);
  const wallet = db.prepare('SELECT currency FROM wallets WHERE id = ?').get(walletId);
  return roundAmount(row.balance, wallet?.currency || 'USD');
}

/** Balances for every wallet at once, so a list is one query rather than N. */
export function balanceMap(branchId = null) {
  const rows = db
    .prepare(
      `SELECT wallet_id, COALESCE(SUM(amount), 0) AS balance FROM wallet_movements
        WHERE (? IS NULL OR branch_id = ?) GROUP BY wallet_id`,
    )
    .all(branchId, branchId);
  return new Map(rows.map((r) => [r.wallet_id, r.balance]));
}

/**
 * The same wallet, branch by branch — every open branch, including the ones
 * holding nothing, so the screen can show where the credit is and is not.
 */
export function balancesByBranch(walletId, currency = 'USD') {
  return db
    .prepare(
      `SELECT b.id AS branch_id, b.name AS branch_name, b.is_main,
              COALESCE((SELECT SUM(m.amount) FROM wallet_movements m
                         WHERE m.wallet_id = ? AND m.branch_id = b.id), 0) AS balance
         FROM branches b
        WHERE b.active = 1
        ORDER BY b.is_main DESC, b.name`,
    )
    .all(walletId)
    .map((r) => ({ ...r, is_main: !!r.is_main, balance: roundAmount(r.balance, currency) }));
}

/**
 * One wallet as a screen reads it: `balance` is the figure where the caller is
 * standing (the company's total when nobody said where), `total` is always the
 * company's, and `balances` says how it splits.
 */
export function walletById(id, { branchId = null } = {}) {
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(id);
  if (!wallet) return null;
  return {
    ...wallet,
    active: !!wallet.active,
    balance: balanceOf(wallet.id, branchId),
    total: balanceOf(wallet.id),
    balances: balancesByBranch(wallet.id, wallet.currency),
    cost_basis: creditCostBasis(wallet.id, branchId),
  };
}

export function listWallets({ activeOnly = false, branchId = null } = {}) {
  const rows = db
    .prepare(
      `SELECT w.*, (SELECT COUNT(*) FROM products p WHERE p.wallet_id = w.id AND p.active = 1) AS product_count
       FROM wallets w ${activeOnly ? 'WHERE w.active = 1' : ''} ORDER BY w.name`,
    )
    .all();
  const here = balanceMap(branchId);
  const everywhere = branchId === null ? here : balanceMap();
  return rows.map((w) => ({
    ...w,
    active: !!w.active,
    balance: roundAmount(here.get(w.id) || 0, w.currency),
    total: roundAmount(everywhere.get(w.id) || 0, w.currency),
    balances: balancesByBranch(w.id, w.currency),
    /*
     * What a dollar of this credit costs the shop, which is what every sale out
     * of it is costed at. Sent to the screen because a shop cannot check a
     * figure it cannot see: 1 means "bought at face value, so this earns
     * nothing", and that is the state a shop sits in without knowing until it
     * is shown. One small query per wallet, and there are a handful of them.
     */
    cost_basis: creditCostBasis(w.id, branchId),
  }));
}

/**
 * The wallet's history, newest first.
 *
 * Every movement, not the last hundred: a shop reconciling against the
 * carrier's statement needs the month, and the month before it. So it is cut
 * by date, by kind and by branch, and paged — `more` says whether there is
 * another page behind the one returned. Dates are the shop's own days, see
 * lib/shopTime.js. The old positional `limit` is still honoured.
 */
export function movementsFor(walletId, options = 100, legacyBranch = null) {
  const opts = typeof options === 'object' && options !== null ? options : { limit: options, branchId: legacyBranch };
  const { limit = 100, offset = 0, branchId = null, from = null, to = null, kind = null } = opts;
  const lo = from ? dayStartUtc(from) : null;
  const hi = to ? dayEndUtc(to) : null;
  const size = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const rows = db
    .prepare(
      `SELECT m.*, u.name AS user_name, o.order_number, d.doc_number, p.name AS product_name,
              b.name AS branch_name
       FROM wallet_movements m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN orders o ON o.id = m.order_id
       LEFT JOIN documents d ON d.id = m.document_id
       LEFT JOIN products p ON p.id = m.product_id
       LEFT JOIN branches b ON b.id = m.branch_id
       WHERE m.wallet_id = ?
         AND (? IS NULL OR m.branch_id = ?)
         AND (? IS NULL OR m.created_at >= ?)
         AND (? IS NULL OR m.created_at <= ?)
         AND (? IS NULL OR m.kind = ?)
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(walletId, branchId, branchId, lo, lo, hi, hi, kind, kind, size + 1, Math.max(Number(offset) || 0, 0));
  const more = rows.length > size;
  return Object.assign(more ? rows.slice(0, size) : rows, { more });
}

/** What the statement says in words for each kind of row. */
export const MOVEMENT_LABELS = {
  top_up: 'Topped up',
  withdrawal: 'Taken out',
  sale: 'Sold',
  refund: 'Refunded',
  adjustment: 'Correction',
};

/**
 * The same history as a spreadsheet.
 *
 * For the accountant, and for the argument with the carrier: their statement
 * is a file, and the shop's answer to it should be one too.
 */
export function movementsCsv(wallet, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    ['When', 'Branch', 'What happened', 'Detail', 'Reference', `Amount (${wallet.currency})`, 'Amount (USD)', 'Cost (USD)', 'By', 'Note'].join(','),
  ];
  for (const m of rows) {
    lines.push(
      [
        m.created_at,
        m.branch_name || '',
        MOVEMENT_LABELS[m.kind] || m.kind,
        m.product_name || '',
        m.order_number || m.doc_number || '',
        m.amount,
        m.amount_usd,
        m.cost_usd ?? '',
        m.user_name || '',
        m.note || '',
      ]
        .map(cell)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
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
  /*
   * What this top-up cost the shop, when that is not simply what it added.
   * Null means bought at face value — cash handed to a distributor for the
   * same number of dollars.
   */
  costUsd = null,
  /* Whose credit moved. The main branch when nobody said, which is the only
     branch a shop with one counter has. */
  branchId = null,
}) {
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
  if (!wallet) throw new Error('That wallet does not exist');
  if (!MOVEMENT_KINDS.includes(kind)) throw new Error(`Unknown wallet movement: ${kind}`);
  const at = branchId ?? mainBranchId();

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
         (wallet_id, kind, amount, amount_usd, exchange_rate, order_id, product_id, note, user_id,
          cost_usd, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      wallet.id, kind, value, usd, rate || null, orderId, productId, note, userId,
      costUsd === null || costUsd === undefined ? null : round2(costUsd),
      at,
    );

  return info.lastInsertRowid;
}

/**
 * What a dollar of this wallet's credit actually cost the shop.
 *
 * Face value is the wrong answer for a shop that gets its credit sideways. Sell
 * a 30-day validity card that comes with $7.50 on it, take $6 of that back onto
 * the shop's own line, and those six dollars cost nothing extra — the card was
 * already bought and already sold at a margin. Priced at face value the shop
 * would think it earns nothing on credit, when credit is the profitable half.
 *
 * So it is the average across every top-up: what was paid, over what was added.
 * An average rather than a queue because credit is fungible — a dollar sent to
 * a customer is not traceably the dollar that came from any one card, and
 * pretending otherwise would be precision with nothing behind it.
 *
 * Returns 1 when nothing has been topped up yet, which reads as "bought at face
 * value" and is the safe assumption: it understates the margin rather than
 * inventing one.
 */
export function creditCostBasis(walletId, branchId = null) {
  const basisOf = (where) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(cost_usd, amount_usd)), 0) AS paid,
                COALESCE(SUM(amount_usd), 0) AS added
         FROM wallet_movements
         WHERE wallet_id = ? AND kind = 'top_up' AND (? IS NULL OR branch_id = ?)`,
      )
      .get(walletId, where, where);

  /*
   * A branch that buys its own credit is costed on its own top-ups; one that
   * has never topped up on its own falls back to what the company paid, which
   * is where its credit came from.
   */
  let row = basisOf(branchId);
  if (!row.added && branchId !== null) row = basisOf(null);
  if (!row.added) return 1;
  return Math.round((row.paid / row.added) * 10_000) / 10_000;
}

/**
 * Move credit from one branch's line to another's.
 *
 * Credit bought centrally and split between shops, or lent from a branch with
 * plenty to one that has run out. Two movements, so each branch's statement
 * reads what happened to its own balance — and the receiving side is costed
 * at what the giving side paid, so moving credit does not invent a margin.
 */
export function transferBetweenBranches({ walletId, fromBranchId, toBranchId, amount, note = null, userId = null }) {
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
  if (!wallet) throw new Error('That wallet does not exist');
  const from = Number(fromBranchId);
  const to = Number(toBranchId);
  if (!from || !to) throw new Error('Say which branch the credit leaves, and which it goes to');
  if (from === to) throw new Error('The credit has to go to a different branch');
  for (const id of [from, to]) {
    const branch = db.prepare('SELECT id, active FROM branches WHERE id = ?').get(id);
    if (!branch || !branch.active) throw new Error('That branch does not exist');
  }
  const value = roundAmount(Math.abs(Number(amount) || 0), wallet.currency);
  if (value === 0) throw new Error('Enter an amount');

  const { exchange_rate: rate } = getSettings();
  const usd = wallet.currency === 'USD' ? value : rate > 0 ? round2(value / rate) : 0;
  const basis = creditCostBasis(wallet.id, from);
  const names = Object.fromEntries(
    db.prepare('SELECT id, name FROM branches WHERE id IN (?, ?)').all(from, to).map((b) => [b.id, b.name]),
  );
  const tag = note ? ` · ${note}` : '';

  recordMovement({
    walletId: wallet.id,
    kind: 'withdrawal',
    amount: -value,
    amountUsd: -usd,
    note: `Moved to ${names[to]}${tag}`,
    userId,
    branchId: from,
  });
  recordMovement({
    walletId: wallet.id,
    kind: 'top_up',
    amount: value,
    amountUsd: usd,
    costUsd: round2(usd * basis),
    note: `Moved from ${names[from]}${tag}`,
    userId,
    branchId: to,
  });
  return { from, to, amount: value };
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
export function chargeSale({ walletId, product, quantity, orderId, userId, branchId = null }) {
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
    branchId,
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
         (wallet_id, kind, amount, amount_usd, exchange_rate, order_id, product_id, note, user_id, branch_id)
       VALUES (?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.wallet_id, -m.amount, -m.amount_usd, m.exchange_rate, orderId, m.product_id, 'Refunded', userId, m.branch_id);
  }

  return spent.length;
}

/**
 * Put back the share of a wallet that one returned line paid for.
 *
 * Proportional to how many of the line are coming back, and taken from what was
 * actually spent rather than from the card's cost today — the card may have
 * been repriced, or pointed at a different wallet, since the sale.
 */
export function refundOrderLine({ orderId, productId, returning, sold, userId = null }) {
  if (!productId || !(returning > 0) || !(sold > 0)) return 0;

  const spent = db
    .prepare("SELECT * FROM wallet_movements WHERE order_id = ? AND kind = 'sale' AND product_id = ?")
    .all(orderId, productId);

  const share = returning / sold;
  for (const m of spent) {
    db.prepare(
      `INSERT INTO wallet_movements
         (wallet_id, kind, amount, amount_usd, exchange_rate, order_id, product_id, note, user_id, branch_id)
       VALUES (?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      m.wallet_id,
      -round2(m.amount * share),
      -round2(m.amount_usd * share),
      m.exchange_rate,
      orderId,
      m.product_id,
      returning === sold ? 'Returned' : `Returned ${returning} of ${sold}`,
      userId,
      m.branch_id,
    );
  }

  return spent.length;
}

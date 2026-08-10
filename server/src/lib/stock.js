/**
 * What is on the shelf, and where.
 *
 * The one place that reads or writes a quantity. Everything else — a sale, a
 * count correction, goods received on an invoice, a part fitted to a repair, a
 * transfer between shops — asks here, and that is what keeps two numbers from
 * disagreeing.
 *
 * There are two numbers on purpose:
 *
 *   branch_stock.stock   how many are at this counter. The truth.
 *   products.stock       how many the company owns, across every branch.
 *
 * The second is a mirror, refreshed here on every change and written nowhere
 * else. It exists because plenty of questions are company-wide — what Shopify
 * should advertise, what the shop owns in total — and rewriting every one of
 * them to sum a table would have been a much larger change for no gain. The
 * rule that keeps it honest is simply that nothing else may touch either
 * column.
 *
 * Products sold from a wallet have no shelf at all: a recharge card cannot run
 * out, and giving it a per-branch quantity would invent a limit the shop does
 * not have. They are skipped throughout.
 */
import { db } from '../db.js';

export function mainBranchId() {
  return db.prepare('SELECT id FROM branches WHERE is_main = 1').get()?.id ?? null;
}

/** The branch a caller meant, falling back to the shop's main one. */
export const resolveBranch = (branchId) => branchId ?? mainBranchId();

/** How many of this product are at this branch. */
export function stockAt(branchId, productId) {
  const branch = resolveBranch(branchId);
  return (
    db.prepare('SELECT stock FROM branch_stock WHERE branch_id = ? AND product_id = ?').get(branch, productId)
      ?.stock ?? 0
  );
}

/**
 * Every product's stock at one branch, keyed by product id.
 *
 * One query, because the register asks this for the whole catalogue every time
 * somebody opens it.
 */
export function stockMap(branchId) {
  const branch = resolveBranch(branchId);
  const rows = db.prepare('SELECT product_id, stock FROM branch_stock WHERE branch_id = ?').all(branch);
  return new Map(rows.map((r) => [r.product_id, r.stock]));
}

/** Where the rest of it is, for a product that is short here. */
export function stockElsewhere(branchId, productId) {
  const branch = resolveBranch(branchId);
  return db
    .prepare(
      `SELECT b.id AS branch_id, b.name AS branch_name, s.stock
       FROM branch_stock s JOIN branches b ON b.id = s.branch_id
       WHERE s.product_id = ? AND s.branch_id <> ? AND s.stock > 0 AND b.active = 1
       ORDER BY s.stock DESC`,
    )
    .all(productId, branch);
}

/**
 * Keep products.stock equal to the sum of the branches.
 *
 * Called after every change here and from nowhere else, so the mirror cannot
 * drift from the thing it mirrors.
 */
function refreshTotal(productId) {
  const total =
    db.prepare('SELECT COALESCE(SUM(stock), 0) AS n FROM branch_stock WHERE product_id = ?').get(productId)
      ?.n ?? 0;
  db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(total, productId);
  return total;
}

const sellsFromCredit = (productId) =>
  Boolean(db.prepare('SELECT wallet_id FROM products WHERE id = ?').get(productId)?.wallet_id);

/**
 * Move a quantity at one branch.
 *
 * `allowNegative` is for the paths that have already checked, or that are
 * correcting something historical — everywhere else a move that would take a
 * shelf below zero is a counting mistake and is refused, because a negative
 * shelf is a number nobody can act on.
 */
export function moveStock({ branchId, productId, delta, allowNegative = false }) {
  const branch = resolveBranch(branchId);
  const change = Math.round(Number(delta) || 0);
  if (!branch) throw new Error('No branch to move stock at');
  if (change === 0) return stockAt(branch, productId);
  if (sellsFromCredit(productId)) return 0;

  const current = stockAt(branch, productId);
  const resulting = current + change;
  if (resulting < 0 && !allowNegative) {
    const product = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
    throw new Error(
      `That would take ${product?.name ?? 'this product'} below zero at this branch (have ${current})`,
    );
  }

  db.prepare(
    `INSERT INTO branch_stock (branch_id, product_id, stock) VALUES (?, ?, ?)
     ON CONFLICT(branch_id, product_id) DO UPDATE SET stock = excluded.stock`,
  ).run(branch, productId, resulting);

  refreshTotal(productId);
  return resulting;
}

/** Set a branch's shelf to a counted figure, rather than nudging it. */
export function setStock({ branchId, productId, stock }) {
  const branch = resolveBranch(branchId);
  if (sellsFromCredit(productId)) return 0;

  const counted = Math.max(0, Math.round(Number(stock) || 0));
  db.prepare(
    `INSERT INTO branch_stock (branch_id, product_id, stock) VALUES (?, ?, ?)
     ON CONFLICT(branch_id, product_id) DO UPDATE SET stock = excluded.stock`,
  ).run(branch, productId, counted);

  refreshTotal(productId);
  return counted;
}

/**
 * What the company owns, wherever it is.
 *
 * For the questions that are genuinely company-wide — what Shopify advertises,
 * what a purchase decision should be made against.
 */
export function totalStock(productId) {
  return (
    db.prepare('SELECT COALESCE(SUM(stock), 0) AS n FROM branch_stock WHERE product_id = ?').get(productId)
      ?.n ?? 0
  );
}

/**
 * Take a product down to nothing everywhere.
 *
 * For the one case that means it: a product switching to IMEI tracking, whose
 * loose count is about to be replaced by handsets booked in by number. Clearing
 * only the branch somebody happens to be standing in would strand the rest.
 */
export function clearStockEverywhere(productId) {
  db.prepare('UPDATE branch_stock SET stock = 0 WHERE product_id = ?').run(productId);
  db.prepare('UPDATE products SET stock = 0 WHERE id = ?').run(productId);
}

/** A product's shelf at every branch, for the stock screen and the transfer form. */
export function stockByBranch(productId) {
  return db
    .prepare(
      `SELECT b.id AS branch_id, b.name AS branch_name, b.is_main,
              COALESCE(s.stock, 0) AS stock
       FROM branches b
       LEFT JOIN branch_stock s ON s.branch_id = b.id AND s.product_id = ?
       WHERE b.active = 1
       ORDER BY b.is_main DESC, b.name`,
    )
    .all(productId);
}

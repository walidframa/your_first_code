/**
 * Sales put to one side.
 *
 * A customer is still deciding, or has gone back to the car for their wallet,
 * and the queue behind them is real. Holding the cart gives the counter back
 * without losing what has been rung up, and picking it up again puts the
 * cashier where they left off.
 *
 * The important thing this is *not*: a hold reserves nothing. Stock belongs to
 * whoever pays for it, and a phone held in a parked sale that somebody else
 * buys twenty minutes later is sold — pretending otherwise would let a shop
 * promise the same handset to two people. So the lines are stored as they were
 * typed, and what has changed underneath them is worked out on the way back in
 * and said plainly, rather than being silently corrected or silently ignored.
 */
import { db, transaction } from '../db.js';
import { round2 } from './currency.js';

/** A hold is a draft; it does not survive as one for long. */
export const HELD_STATUSES = ['held', 'resumed', 'voided'];

/*
 * Numbered from the highest id rather than the count, so a row removed by hand
 * cannot make the next hold collide with one that already exists.
 */
const nextReference = () => {
  const { last } = db.prepare('SELECT COALESCE(MAX(id), 0) AS last FROM held_sales').get();
  return `HOLD-${String(last + 1).padStart(4, '0')}`;
};

/**
 * What the lines come to.
 *
 * Recomputed here rather than taken from the browser: the figure shows up in a
 * list of held sales that somebody decides from, and a total the client could
 * name is a total that can be wrong.
 */
function totalOf(cart, discountPercent = 0) {
  const subtotal = round2(
    cart.reduce((sum, line) => {
      if (line.isGift) return sum;
      const price = Number(line.price) || 0;
      const quantity = Number(line.quantity) || 0;
      return sum + price * quantity - (Number(line.discount) || 0);
    }, 0),
  );
  const percent = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  return round2(subtotal - subtotal * (percent / 100));
}

const countOf = (cart) => cart.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);

const parse = (json, fallback) => {
  try {
    return json ? JSON.parse(json) : fallback;
  } catch {
    return fallback;
  }
};

/** A held sale as the list shows it — no cart, because a list is a list. */
function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    label: row.label,
    customerId: row.customer_id,
    customerName: row.customer_name,
    itemCount: row.item_count,
    total: row.total,
    status: row.status,
    heldBy: row.held_by,
    heldByName: row.held_by_name || null,
    heldAt: row.held_at,
    resumedAt: row.resumed_at,
    note: row.note,
  };
}

/** The whole thing, cart and all, for putting back on the screen. */
function shapeFull(row) {
  if (!row) return null;
  return { ...shape(row), cart: parse(row.cart, []), context: parse(row.context, {}) };
}

export function holdSale({
  label = null,
  cart = [],
  context = {},
  customerId = null,
  customerName = null,
  note = null,
  userId = null,
}) {
  if (!Array.isArray(cart) || cart.length === 0) {
    throw new Error('There is nothing on this sale to hold');
  }

  const discountPercent = Number(context?.discountPercent) || 0;
  const reference = nextReference();

  const info = db
    .prepare(
      `INSERT INTO held_sales
         (reference, label, customer_id, customer_name, cart, context, item_count, total, held_by, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      reference,
      label?.trim() || null,
      customerId ?? null,
      customerName?.trim() || null,
      JSON.stringify(cart),
      JSON.stringify(context ?? {}),
      countOf(cart),
      totalOf(cart, discountPercent),
      userId ?? null,
      note?.trim() || null,
    );

  return heldById(info.lastInsertRowid);
}

export function listHeld({ status = 'held', limit = 50 } = {}) {
  const wanted = status === 'all' ? null : status;
  return db
    .prepare(
      `SELECT h.*, u.name AS held_by_name FROM held_sales h
       LEFT JOIN users u ON u.id = h.held_by
       WHERE (? IS NULL OR h.status = ?)
       ORDER BY h.held_at DESC, h.id DESC LIMIT ?`,
    )
    .all(wanted, wanted, Math.min(Number(limit) || 50, 200))
    .map(shape);
}

export function heldById(id) {
  return shapeFull(
    db
      .prepare(
        `SELECT h.*, u.name AS held_by_name FROM held_sales h
         LEFT JOIN users u ON u.id = h.held_by WHERE h.id = ?`,
      )
      .get(id),
  );
}

export function countHeld() {
  return db.prepare("SELECT COUNT(*) AS n FROM held_sales WHERE status = 'held'").get().n;
}

/**
 * What has changed since the sale was put down.
 *
 * A hold reserves nothing, so by the time it is picked up a handset may have
 * been sold, a product archived, the last three of something gone. Each is
 * reported rather than repaired: the cashier is standing in front of the
 * customer and is the one who decides whether to substitute, re-quote or
 * apologise.
 */
export function checkHeldCart(cart) {
  const issues = [];

  for (const line of cart) {
    const product = db
      .prepare('SELECT id, name, stock, active, wallet_id FROM products WHERE id = ?')
      .get(line.productId);

    if (!product) {
      issues.push({ lineKey: line.lineKey, severity: 'gone', message: `${line.name} is no longer in the catalogue` });
      continue;
    }
    if (!product.active) {
      issues.push({ lineKey: line.lineKey, severity: 'gone', message: `${product.name} has been archived` });
      continue;
    }

    if (line.unitId) {
      const unit = db.prepare('SELECT id, imei, status FROM product_units WHERE id = ?').get(line.unitId);
      if (!unit) {
        issues.push({ lineKey: line.lineKey, severity: 'gone', message: `${product.name} — that handset is gone` });
      } else if (unit.status !== 'in_stock') {
        issues.push({
          lineKey: line.lineKey,
          severity: 'gone',
          message: `${product.name} · ${unit.imei} has been ${unit.status === 'sold' ? 'sold' : unit.status}`,
        });
      }
      continue;
    }

    // A card is funded by a wallet rather than a shelf, so it cannot run out.
    if (product.wallet_id) continue;

    const wanted = Number(line.quantity) || 0;
    if (product.stock < wanted) {
      issues.push({
        lineKey: line.lineKey,
        severity: product.stock <= 0 ? 'gone' : 'short',
        message:
          product.stock <= 0
            ? `${product.name} is out of stock`
            : `${product.name}: only ${product.stock} left, ${wanted} on this sale`,
        available: product.stock,
      });
    }
  }

  return issues;
}

/**
 * Pick a held sale back up.
 *
 * Marked resumed on the way out so two cashiers cannot both put the same cart
 * on their screen. If it is put down again that makes a new hold, which is the
 * honest record of what happened: it was picked up, worked on, and parked again.
 */
export function resumeHeld(id, userId = null) {
  const held = heldById(id);
  if (!held) throw new Error('That held sale does not exist');
  if (held.status === 'resumed') throw new Error('Somebody has already picked that sale up');
  if (held.status === 'voided') throw new Error('That held sale was discarded');

  return transaction(() => {
    db.prepare(
      `UPDATE held_sales SET status = 'resumed', resumed_by = ?, resumed_at = datetime('now') WHERE id = ?`,
    ).run(userId ?? null, id);
    return { ...heldById(id), issues: checkHeldCart(held.cart) };
  })();
}

/** Throw it away. Kept as a row, because a cart that vanished is a question. */
export function voidHeld(id, userId = null) {
  const held = heldById(id);
  if (!held) throw new Error('That held sale does not exist');
  if (held.status !== 'held') throw new Error('That sale is no longer being held');

  db.prepare(
    `UPDATE held_sales SET status = 'voided', resumed_by = ?, resumed_at = datetime('now') WHERE id = ?`,
  ).run(userId ?? null, id);
  return heldById(id);
}

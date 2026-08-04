/**
 * Warranty, repair jobs, and handsets bought back over the counter.
 *
 * These three belong together: a repair is often a warranty claim, and a
 * trade-in is a repair's opposite — a phone the shop takes in and keeps.
 */

import { db } from '../db.js';
import { encryptSecret } from './secrets.js';
import { normaliseImei, receiveUnits, syncStockFromUnits } from './units.js';

export const REPAIR_STATUSES = [
  'received',
  'diagnosed',
  'awaiting_parts',
  'repairing',
  'ready',
  'collected',
  'cancelled',
];

/** Statuses from which nothing more happens. */
const CLOSED = ['collected', 'cancelled'];

export function isClosed(status) {
  return CLOSED.includes(status);
}

/* ------------------------------------------------------------------ warranty */

/**
 * When a handset's warranty runs out.
 *
 * Months, not days: a shop says "six months", and adding 180 days would end the
 * cover on a different date than the customer was told. Returns null when the
 * unit carries no warranty at all, which is not the same as an expired one.
 */
export function warrantyEnds(unit) {
  const months = Number(unit?.warranty_months) || 0;
  if (!months || !unit?.warranty_starts) return null;

  const start = new Date(`${String(unit.warranty_starts).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;

  const end = new Date(start);
  /*
   * setUTCMonth rolls over sensibly for short months: the 31st of January plus
   * one month lands on the 3rd of March, which is later than the customer would
   * expect, so clamp back to the last day of the target month instead.
   */
  const targetMonth = start.getUTCMonth() + months;
  end.setUTCMonth(targetMonth);
  if (end.getUTCMonth() !== ((targetMonth % 12) + 12) % 12) end.setUTCDate(0);

  return end.toISOString().slice(0, 10);
}

/** Is this handset still covered today? */
export function underWarranty(unit, today = new Date()) {
  const ends = warrantyEnds(unit);
  return ends ? today.toISOString().slice(0, 10) <= ends : false;
}

/** Everything the counter needs to answer a warranty question. */
export function warrantyOf(unit) {
  const ends = warrantyEnds(unit);
  return {
    months: unit?.warranty_months ?? null,
    starts: unit?.warranty_starts ?? null,
    ends,
    active: underWarranty(unit),
  };
}

/* ------------------------------------------------------------------- repairs */

function nextTicketNumber() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM repair_tickets').get();
  return `REP-${String(n + 1).padStart(5, '0')}`;
}

export function ticketWithDetail(id) {
  const ticket = db
    .prepare(
      `SELECT t.*, u.imei AS unit_imei, u.imei2 AS unit_imei2,
              u.warranty_months, u.warranty_starts,
              p.name AS unit_product_name,
              tk.name AS taken_by_name
       FROM repair_tickets t
       LEFT JOIN product_units u ON u.id = t.unit_id
       LEFT JOIN products p ON p.id = u.product_id
       LEFT JOIN users tk ON tk.id = t.taken_by
       WHERE t.id = ?`,
    )
    .get(id);
  if (!ticket) return null;

  const parts = db.prepare('SELECT * FROM repair_parts WHERE ticket_id = ? ORDER BY id').all(id);
  const events = db
    .prepare(
      `SELECT e.*, u.name AS user_name FROM repair_events e
       LEFT JOIN users u ON u.id = e.user_id
       WHERE e.ticket_id = ? ORDER BY e.created_at, e.id`,
    )
    .all(id);

  const partsTotal = parts.reduce((sum, p) => sum + p.price * p.quantity, 0);

  return {
    ticket,
    parts,
    events,
    partsTotal: Math.round(partsTotal * 100) / 100,
    warranty: ticket.unit_id ? warrantyOf(ticket) : null,
  };
}

/**
 * Take a device in.
 *
 * If the IMEI matches something the shop sold, the ticket is linked to that
 * handset and the warranty answer comes out of the record rather than out of an
 * argument at the counter.
 */
export function openTicket(input, userId) {
  const imei = normaliseImei(input.imei);
  const unit = imei
    ? db.prepare('SELECT * FROM product_units WHERE imei = ? OR imei2 = ?').get(imei, imei)
    : null;

  if (!input.customerName?.trim()) throw new Error('Whose phone is it? A name is needed');
  if (!input.device?.trim() && !unit) throw new Error('Say what the device is');
  if (!input.fault?.trim()) throw new Error('Say what is wrong with it');

  const product = unit
    ? db.prepare('SELECT name FROM products WHERE id = ?').get(unit.product_id)
    : null;

  const ticketNumber = nextTicketNumber();
  const covered = unit ? underWarranty(unit) : false;

  const info = db
    .prepare(
      `INSERT INTO repair_tickets
         (ticket_number, unit_id, customer_id, customer_name, customer_phone, device, imei,
          fault, condition_note, passcode_enc, under_warranty, quoted, taken_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ticketNumber,
      unit?.id ?? null,
      input.customerId || null,
      input.customerName.trim(),
      input.customerPhone?.trim() || null,
      input.device?.trim() || product?.name || 'Device',
      imei || null,
      input.fault.trim(),
      input.conditionNote?.trim() || null,
      encryptSecret(input.passcode),
      covered ? 1 : 0,
      input.quoted === undefined || input.quoted === null ? null : Number(input.quoted),
      userId,
    );

  db.prepare(
    `INSERT INTO repair_events (ticket_id, status, note, user_id) VALUES (?, 'received', ?, ?)`,
  ).run(info.lastInsertRowid, input.fault.trim(), userId);

  return info.lastInsertRowid;
}

/**
 * Move a ticket along.
 *
 * Statuses are not a strict pipeline — a job goes back to "awaiting parts" as
 * often as it goes forward — so any status is reachable except out of a closed
 * one. Collection is not done here: that is a sale, and it goes through the
 * register so the money lands in the drawer.
 */
export function setStatus(ticketId, status, note, userId) {
  const ticket = db.prepare('SELECT * FROM repair_tickets WHERE id = ?').get(ticketId);
  if (!ticket) throw new Error('Ticket not found');
  if (!REPAIR_STATUSES.includes(status)) {
    throw new Error(`Status must be one of: ${REPAIR_STATUSES.join(', ')}`);
  }
  if (isClosed(ticket.status)) {
    throw new Error(`${ticket.ticket_number} is already ${ticket.status}`);
  }
  if (status === 'collected') {
    throw new Error('Collect the repair from the register, so the money reaches the drawer');
  }

  db.prepare(
    `UPDATE repair_tickets SET status = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(status, ticketId);
  db.prepare(
    'INSERT INTO repair_events (ticket_id, status, note, user_id) VALUES (?, ?, ?, ?)',
  ).run(ticketId, status, note || null, userId);

  return ticketWithDetail(ticketId).ticket;
}

/**
 * Fit a part.
 *
 * Taken out of stock at the moment it is fitted, not when the job is invoiced —
 * the screen is gone from the drawer either way, and waiting would let the shop
 * sell one it no longer has.
 */
export function addPart(ticketId, input, userId) {
  const ticket = db.prepare('SELECT * FROM repair_tickets WHERE id = ?').get(ticketId);
  if (!ticket) throw new Error('Ticket not found');
  if (isClosed(ticket.status)) throw new Error(`${ticket.ticket_number} is already ${ticket.status}`);

  const quantity = Math.max(1, Math.round(Number(input.quantity) || 1));
  let product = null;

  if (input.productId) {
    product = db.prepare('SELECT * FROM products WHERE id = ?').get(input.productId);
    if (!product) throw new Error('Part not found in the catalogue');
    if (product.tracks_units) {
      throw new Error(`${product.name} is tracked by IMEI — a whole handset is not a spare part`);
    }
    if (product.stock < quantity) {
      throw new Error(`Not enough ${product.name} (have ${product.stock}, need ${quantity})`);
    }

    const resulting = product.stock - quantity;
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(resulting, product.id);
    db.prepare(
      `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note)
       VALUES (?, ?, ?, ?, 'damaged', ?)`,
    ).run(product.id, userId, -quantity, resulting, `Fitted on ${ticket.ticket_number}`);
  } else if (!input.name?.trim()) {
    throw new Error('A part needs a product or a description');
  }

  const price = Number(input.price ?? product?.price ?? 0) || 0;
  const cost = Number(input.cost ?? product?.cost ?? 0) || 0;

  db.prepare(
    `INSERT INTO repair_parts (ticket_id, product_id, name, quantity, cost, price)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ticketId, product?.id ?? null, input.name?.trim() || product.name, quantity, cost, price);

  db.prepare(`UPDATE repair_tickets SET updated_at = datetime('now') WHERE id = ?`).run(ticketId);
  return ticketWithDetail(ticketId);
}

/** Take a part back off a job, returning it to stock if it came from there. */
export function removePart(partId, userId) {
  const part = db.prepare('SELECT * FROM repair_parts WHERE id = ?').get(partId);
  if (!part) throw new Error('Part not found');

  const ticket = db.prepare('SELECT * FROM repair_tickets WHERE id = ?').get(part.ticket_id);
  if (isClosed(ticket.status)) throw new Error(`${ticket.ticket_number} is already ${ticket.status}`);

  if (part.product_id) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(part.product_id);
    if (product) {
      const resulting = product.stock + part.quantity;
      db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(resulting, product.id);
      db.prepare(
        `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note)
         VALUES (?, ?, ?, ?, 'return', ?)`,
      ).run(product.id, userId, part.quantity, resulting, `Taken off ${ticket.ticket_number}`);
    }
  }

  db.prepare('DELETE FROM repair_parts WHERE id = ?').run(partId);
  return ticketWithDetail(part.ticket_id);
}

/* ----------------------------------------------------------------- trade-ins */

/**
 * Buy a handset over the counter.
 *
 * The mirror of a sale: money out of the drawer, a phone onto the shelf at the
 * grade and price agreed. From that moment it is an ordinary unit — it sells,
 * costs and reports like any other — and this row only records where it came
 * from.
 */
export function takeTradeIn(input, userId) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(input.productId);
  if (!product) throw new Error('Which model is it? Pick the product it will be sold as');
  if (!product.tracks_units) throw new Error(`${product.name} is not tracked by IMEI`);

  const paidUsd = Number(input.paidUsd) || 0;
  const paidLbp = Number(input.paidLbp) || 0;
  if (paidUsd < 0 || paidLbp < 0) throw new Error('A trade-in cannot pay out less than nothing');

  const rate = Number(input.exchangeRate) || 0;
  // What the handset cost the shop, which is what it paid for it either way.
  const cost = Math.round((paidUsd + (rate > 0 ? paidLbp / rate : 0)) * 100) / 100;

  receiveUnits(
    product.id,
    [{ imei: input.imei, condition: input.condition || 'used', cost, note: input.note || null }],
    {},
  );

  const imei = normaliseImei(String(input.imei).split(/[,/;|]/)[0]);
  const unit = db.prepare('SELECT * FROM product_units WHERE imei = ?').get(imei);

  db.prepare(
    `INSERT INTO trade_ins (unit_id, customer_id, seller_name, seller_phone, paid_usd, paid_lbp, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    unit.id,
    input.customerId || null,
    input.sellerName?.trim() || null,
    input.sellerPhone?.trim() || null,
    paidUsd,
    paidLbp,
    input.note || null,
    userId,
  );

  syncStockFromUnits(product.id);
  return { unit, cost };
}

/**
 * Warranty, repair jobs, and handsets bought back over the counter.
 *
 * These three belong together: a repair is often a warranty claim, and a
 * trade-in is a repair's opposite — a phone the shop takes in and keeps.
 */

import { db } from '../db.js';
import { moveStock, stockAt } from './stock.js';
import { encryptSecret } from './secrets.js';
import { normaliseImei, receiveUnits, syncStockFromUnits } from './units.js';
import { setIdPhoto } from './idPhotos.js';
import { getSettings } from './settings.js';

export const REPAIR_STATUSES = [
  'received',
  'diagnosed',
  'awaiting_parts',
  'repairing',
  'ready',
  'collected',
  'cancelled',
];

/** Statuses that mean the phone is no longer on the bench. */
const CLOSED = ['collected', 'cancelled'];

export function isClosed(status) {
  return CLOSED.includes(status);
}

/** Statuses a job can be put back onto the bench at. */
export const OPEN_STATUSES = REPAIR_STATUSES.filter((s) => !CLOSED.includes(s));

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
              tk.name AS taken_by_name,
              c.name AS account_name
       FROM repair_tickets t
       LEFT JOIN product_units u ON u.id = t.unit_id
       LEFT JOIN products p ON p.id = u.product_id
       LEFT JOIN users tk ON tk.id = t.taken_by
       LEFT JOIN customers c ON c.id = t.customer_id
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
  const { exchange_rate: rate } = getSettings();

  return {
    ticket,
    parts,
    events,
    partsTotal: Math.round(partsTotal * 100) / 100,
    // What is still to pay, so the counter is not doing the subtraction in its
    // head on a job that was half-paid at intake.
    outstanding: outstandingOn(ticket, rate),
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
export function openTicket(input, userId, branchId = null) {
  const imei = normaliseImei(input.imei);
  const unit = imei
    ? db.prepare('SELECT * FROM product_units WHERE imei = ? OR imei2 = ?').get(imei, imei)
    : null;

  /*
   * Picked off the customer list, or typed in.
   *
   * Both are real: a regular gets chosen and their account, their other repairs
   * and what they owe all follow the ticket; a stranger with a cracked screen
   * gets typed. The name is *copied* onto the ticket either way, so a slip
   * printed today still reads the same after the contact is renamed, and so a
   * walk-in needs no account created for them.
   */
  const customer = input.customerId
    ? db.prepare('SELECT * FROM customers WHERE id = ?').get(input.customerId)
    : null;
  if (input.customerId && !customer) throw new Error('That customer does not exist');

  const customerName = input.customerName?.trim() || customer?.name || '';
  const customerPhone = input.customerPhone?.trim() || customer?.phone || null;

  if (!customerName) throw new Error('Whose phone is it? A name is needed');
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
          fault, condition_note, passcode_enc, under_warranty, quoted, taken_by, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ticketNumber,
      unit?.id ?? null,
      customer?.id ?? null,
      customerName,
      customerPhone,
      input.device?.trim() || product?.name || 'Device',
      imei || null,
      input.fault.trim(),
      input.conditionNote?.trim() || null,
      encryptSecret(input.passcode),
      covered ? 1 : 0,
      input.quoted === undefined || input.quoted === null ? null : Number(input.quoted),
      userId,
      // Which shop has the phone. Parts fitted to it come off that branch's
      // shelf, and a ticket with no branch would draw them from the main one.
      branchId,
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
 * often as it goes forward — so every status is reachable from every other one,
 * **including out of a collected job**.
 *
 * That last part is the whole reason this reads the way it does. A repair used
 * to freeze the moment the money was taken, because taking the money and handing
 * the phone back were the same action. They are not: half the shop's customers
 * pay when they drop the phone off, and a ticket that says "collected" while the
 * phone is still on the bench, and cannot be moved off it, is worse than no
 * status at all. So money is recorded by `takePayment` and the status is
 * recorded here, and neither one decides the other.
 *
 * Handing the phone back is still not done here — see the collect route — so
 * that the date it left and any money still owing are written together.
 */
export function setStatus(ticketId, status, note, userId) {
  const ticket = db.prepare('SELECT * FROM repair_tickets WHERE id = ?').get(ticketId);
  if (!ticket) throw new Error('Ticket not found');
  if (!REPAIR_STATUSES.includes(status)) {
    throw new Error(`Status must be one of: ${REPAIR_STATUSES.join(', ')}`);
  }
  if (status === 'collected') {
    throw new Error('Use "Hand it back", so the date it left and anything still owing are recorded');
  }
  if (status === ticket.status) return ticketWithDetail(ticketId).ticket;

  /*
   * Putting a collected job back on the bench clears the date it left, because
   * that date answers "is it gone?" and it is not gone. What was paid stays
   * exactly where it is: the money really did cross the counter, and a customer
   * who brings the phone back the next day has not been refunded.
   */
  const reopening = isClosed(ticket.status) && !isClosed(status);

  db.prepare(
    `UPDATE repair_tickets
       SET status = ?, updated_at = datetime('now')${reopening ? ', collected_at = NULL' : ''}
     WHERE id = ?`,
  ).run(status, ticketId);
  db.prepare(
    'INSERT INTO repair_events (ticket_id, status, note, user_id) VALUES (?, ?, ?, ?)',
  ).run(
    ticketId,
    status,
    note || (reopening ? `Back on the bench from ${ticket.status}` : null),
    userId,
  );

  return ticketWithDetail(ticketId).ticket;
}

/**
 * What is still owing on a job, in dollars.
 *
 * The pounds taken are converted at the rate handed in rather than at a rate
 * stored on the ticket, because a repair is quoted and settled inside a few
 * days and carrying a third rate around would be precision the counter has not
 * got. `charged` is what was agreed; before anything is agreed the quote stands
 * in for it, and a warranty job is nothing to pay whatever either of them says.
 */
export function outstandingOn(ticket, rate = 0) {
  if (ticket.under_warranty) return 0;
  const agreed = Number(ticket.charged ?? ticket.quoted ?? 0) || 0;
  const paid = Number(ticket.paid_usd || 0) + (rate > 0 ? Number(ticket.paid_lbp || 0) / rate : 0);
  return Math.round(Math.max(0, agreed - paid) * 100) / 100;
}

/**
 * Take money on a job without handing the phone back.
 *
 * Records what was paid and, if a figure was agreed at the same time, what the
 * job is being charged. The caller moves the drawer — this only writes down what
 * the ticket now says, so the two cannot be recorded in different transactions.
 */
export function takePayment(ticketId, { charged = null, paidUsd = 0, paidLbp = 0, note = null }, userId) {
  const ticket = db.prepare('SELECT * FROM repair_tickets WHERE id = ?').get(ticketId);
  if (!ticket) throw new Error('Ticket not found');

  const usd = Math.round((Number(paidUsd) || 0) * 100) / 100;
  const lbp = Math.round(Number(paidLbp) || 0);
  if (usd < 0 || lbp < 0) throw new Error('A payment cannot be less than nothing');
  if (usd === 0 && lbp === 0) throw new Error('Enter an amount in dollars, pounds, or both');

  db.prepare(
    `UPDATE repair_tickets
       SET paid_usd = paid_usd + ?, paid_lbp = paid_lbp + ?,
           charged = COALESCE(?, charged),
           paid_at = COALESCE(paid_at, datetime('now')),
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(usd, lbp, charged === null || charged === undefined ? null : Number(charged), ticketId);

  /*
   * Filed against the status the job is actually at, so the history reads as
   * one column of events rather than as a status that jumped and came back.
   */
  db.prepare(
    'INSERT INTO repair_events (ticket_id, status, note, user_id) VALUES (?, ?, ?, ?)',
  ).run(ticketId, 'payment', note || null, userId);

  return ticketWithDetail(ticketId);
}

/**
 * What the bench made over a period.
 *
 * Two figures, because a repair takes money and finishes on two different days
 * and a shop wants both answers:
 *
 *   collected   jobs handed back in the period — what they were charged, what
 *               their parts cost, and the difference. This is profit.
 *   taken       money that actually crossed the counter in the period, whether
 *               or not the phone has gone home yet.
 *
 * They are reported side by side rather than reconciled into one, because they
 * are genuinely different questions and merging them would answer neither. A
 * phone paid for in March and collected in April earns its profit in April and
 * filled the drawer in March; both of those are true, and a single number would
 * have to be wrong about one of them.
 *
 * Parts are costed at what they cost when they were fitted — the figure frozen
 * on the row — so a supplier raising a screen's price next week does not rewrite
 * what last month's jobs made. A part with no cost recorded contributes nothing
 * and is counted, so the screen can say the figure is short rather than quietly
 * flattering the margin.
 *
 * A warranty job is charged nothing and its parts cost real money, so it shows
 * as a loss. That is what a warranty is, and a report that hid it would be
 * hiding the cost of the promise.
 */
export function repairProfit({ from = null, to = null, branchId = null } = {}) {
  // Inclusive of the whole end day: a report "to the 31st" that stopped at
  // midnight would drop the busiest day of the month.
  const lo = from ? `${from} 00:00:00` : '0000-01-01';
  const hi = to ? `${to} 23:59:59` : '9999-12-31';
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  const collected = db
    .prepare(
      `SELECT COUNT(*) AS jobs,
              COALESCE(SUM(t.charged), 0) AS revenue,
              SUM(CASE WHEN t.under_warranty = 1 THEN 1 ELSE 0 END) AS warranty_jobs
         FROM repair_tickets t
        WHERE t.status = 'collected' AND t.collected_at BETWEEN ? AND ?
          AND (? IS NULL OR t.branch_id = ?)`,
    )
    .get(lo, hi, branchId, branchId);

  const parts = db
    .prepare(
      `SELECT COALESCE(SUM(p.cost * p.quantity), 0) AS cost,
              SUM(CASE WHEN p.cost IS NULL OR p.cost = 0 THEN 1 ELSE 0 END) AS unknown_lines
         FROM repair_parts p
         JOIN repair_tickets t ON t.id = p.ticket_id
        WHERE t.status = 'collected' AND t.collected_at BETWEEN ? AND ?
          AND (? IS NULL OR t.branch_id = ?)`,
    )
    .get(lo, hi, branchId, branchId);

  /*
   * Money in, dated by when it was first taken. A job part-paid across two
   * periods lands in the earlier one; the alternative is a per-payment table,
   * which is more machinery than a repair bench needs.
   */
  const { exchange_rate: rate } = getSettings();
  const taken = db
    .prepare(
      `SELECT COUNT(*) AS jobs,
              COALESCE(SUM(t.paid_usd), 0) AS usd,
              COALESCE(SUM(t.paid_lbp), 0) AS lbp
         FROM repair_tickets t
        WHERE t.paid_at BETWEEN ? AND ?
          AND (? IS NULL OR t.branch_id = ?)`,
    )
    .get(lo, hi, branchId, branchId);

  const revenue = round2(collected.revenue);
  const partsCost = round2(parts.cost);

  return {
    from,
    to,
    jobs: collected.jobs,
    warrantyJobs: collected.warranty_jobs || 0,
    revenue,
    partsCost,
    profit: round2(revenue - partsCost),
    // So a screen can say the figure is short rather than pretending.
    unknownCostParts: parts.unknown_lines || 0,
    taken: {
      jobs: taken.jobs,
      usd: round2(taken.usd),
      lbp: Math.round(taken.lbp),
      total: round2(Number(taken.usd) + (rate > 0 ? Number(taken.lbp) / rate : 0)),
    },
  };
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
    /*
     * Off the shelf of the branch whose bench the job is on — the part is
     * physically fitted at one counter, not drawn from the company in general.
     */
    const branchId = ticket.branch_id ?? null;
    const here = stockAt(branchId, product.id);
    if (here < quantity) {
      throw new Error(`Not enough ${product.name} (have ${here}, need ${quantity})`);
    }

    const resulting = moveStock({ branchId, productId: product.id, delta: -quantity });
    db.prepare(
      `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note, branch_id)
       VALUES (?, ?, ?, ?, 'damaged', ?, ?)`,
    ).run(product.id, userId, -quantity, resulting, `Fitted on ${ticket.ticket_number}`, branchId);
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
      const branchId = ticket.branch_id ?? null;
      const resulting = moveStock({ branchId, productId: product.id, delta: part.quantity });
      db.prepare(
        `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note, branch_id)
         VALUES (?, ?, ?, ?, 'return', ?, ?)`,
      ).run(product.id, userId, part.quantity, resulting, `Taken off ${ticket.ticket_number}`, branchId);
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

  const info = db
    .prepare(
      `INSERT INTO trade_ins (unit_id, customer_id, seller_name, seller_phone, paid_usd, paid_lbp, note, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      unit.id,
      input.customerId || null,
      input.sellerName?.trim() || null,
      input.sellerPhone?.trim() || null,
      paidUsd,
      paidLbp,
      input.note || null,
      userId,
    );

  const tradeInId = Number(info.lastInsertRowid);

  /*
   * The seller's ID, if one was photographed. Inside the same transaction as
   * the purchase deliberately: a rejected photo — too big, or not an image —
   * takes the whole trade-in with it rather than leaving the shop holding a
   * handset it has no record of buying, which is the situation the photo exists
   * to prevent.
   */
  if (input.idPhoto) setIdPhoto('trade_in', tradeInId, input.idPhoto, userId);

  syncStockFromUnits(product.id);
  return { unit, cost, tradeInId, hasIdPhoto: Boolean(input.idPhoto) };
}

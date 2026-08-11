/**
 * Sending a receipt to the customer's phone.
 *
 * The shop already has WhatsApp open all day, so the cheapest thing that works
 * is a `wa.me` link: it hands a pre-written message to whichever WhatsApp the
 * machine already has — the desktop app, or the web one — with the customer
 * already selected. No account with Meta, no API key, no monthly fee, and
 * nothing that stops working when a token expires.
 *
 * What it costs in exchange is that nobody can be *sure* the message was sent.
 * The shop composes it and presses send by hand, so this cannot be relied on as
 * a record of delivery — the printed slip stays the thing that proves anything.
 *
 * The text is built here rather than in the browser so that a receipt says the
 * same thing wherever it is sent from, and so that the one place that decides
 * what a customer is told is testable.
 */
import { db } from '../db.js';
import { DOC_TYPES, getDocument } from './documents.js';
import { getSettings } from './settings.js';
import { ticketWithDetail } from './repairs.js';
import { usdToLbp } from './currency.js';

/**
 * A local number as WhatsApp wants it: country code first, no plus, no spaces.
 *
 * Lebanese numbers are written half a dozen ways on a shop counter — 03 123 456,
 * 03/123456, +961 3 123 456, 00961 3 123456 — and WhatsApp accepts exactly one
 * of them. The leading zero is a domestic dialling prefix, so it is dropped
 * before the country code goes on; keeping it produces a number that looks
 * plausible and reaches nobody.
 *
 * Returns null for anything too short to be a phone number, so the caller can
 * fall back to letting the shopkeeper pick the contact by hand.
 */
export function waNumber(raw, countryCode = '961') {
  if (raw === null || raw === undefined) return null;

  const trimmed = String(raw).trim();
  const cc = String(countryCode).replace(/\D/g, '') || '961';
  // Written-out international prefixes, before the punctuation goes: after
  // stripping, "+961…" and "00961…" and a local "0961…" are indistinguishable.
  const international = trimmed.startsWith('+') || trimmed.startsWith('00');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 6) return null;

  if (international) return digits.replace(/^00/, '');
  // A domestic number: the trunk zero is a dialling instruction, not part of it.
  if (digits.startsWith('0')) return cc + digits.slice(1);
  /*
   * Already carrying the country code — but only believe that when what
   * follows is long enough to be a subscriber number on its own. Otherwise
   * "961 234" is a local number that happens to start with those digits.
   */
  if (digits.startsWith(cc) && digits.length > cc.length + 5) return digits;
  return cc + digits;
}

/** The link that opens WhatsApp with the message ready to send. */
export function waLink(number, text) {
  const to = number ? String(number).replace(/\D/g, '') : '';
  // Without a number WhatsApp asks who to send it to, which is the right
  // behaviour when the shop never took one down.
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}

/* ------------------------------------------------------------------ pieces */

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const pounds = (n) => `${Math.round(Number(n) || 0).toLocaleString('en-US')} LL`;

/** A date a customer can read, rather than an ISO timestamp. */
function readableDate(value, { withTime = false } = {}) {
  if (!value) return '';
  // Stored as UTC without the marker, the way SQLite's datetime() writes it.
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

/**
 * Who the shop is, at the top and bottom of anything a customer keeps.
 *
 * The name is bold because WhatsApp will render it that way and because a
 * message with no shop name on it is indistinguishable from a scam.
 */
function letterhead(settings) {
  return `*${settings.company_name}*`;
}

function signature(settings) {
  const phones = [settings.company_phone, settings.company_phone2].filter(Boolean).join(' · ');
  return [settings.company_name, phones, settings.company_address].filter(Boolean);
}

/** Drops the empty lines a missing field would otherwise leave behind. */
function join(lines) {
  return lines
    .filter((line) => line !== null && line !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * One sold line. Deliberately not columns: WhatsApp renders in a proportional
 * face, so padded text that lines up here arrives ragged on the phone.
 */
function itemLine(name, quantity, total) {
  return `${quantity > 1 ? `${quantity}× ` : ''}${name} — ${money(total)}`;
}

/* ---------------------------------------------------------------- messages */

/**
 * The receipt for a finished sale.
 *
 * Both currencies, because the customer paid in one and thinks in the other,
 * and at the rate stored on the order rather than today's — a receipt has to
 * still reconcile after the rate moves.
 */
export function orderMessage(orderId) {
  const order = db
    .prepare(
      /*
       * The buyer's own details are the fallback: a handset sale takes a name
       * and number in the sale dialog without necessarily creating a customer
       * record, and that is precisely the sale worth having a receipt for.
       */
      `SELECT o.*,
              COALESCE(c.name, o.buyer_name) AS customer_name,
              COALESCE(c.phone, o.buyer_phone) AS customer_phone
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = ?`,
    )
    .get(orderId);
  if (!order) return null;

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  const settings = getSettings();
  const rate = order.exchange_rate || 0;

  const lines = [
    letterhead(settings),
    `Receipt ${order.order_number}`,
    readableDate(order.created_at, { withTime: true }),
    '',
    ...items.map((item) => itemLine(item.name, item.quantity, item.line_total)),
    '',
    order.discount > 0 ? `Subtotal: ${money(order.subtotal)}` : null,
    order.discount > 0 ? `Discount: −${money(order.discount)}` : null,
    order.tax > 0 ? `Tax: ${money(order.tax)}` : null,
    `*Total: ${money(order.total)}*`,
    rate > 0 ? pounds(usdToLbp(order.total, rate, settings.lbp_rounding)) : null,
    '',
    order.payment_method === 'card' ? 'Paid by card' : null,
    // What was actually handed over, in whichever currencies it came in.
    order.paid_usd > 0 ? `Paid: ${money(order.paid_usd)}` : null,
    order.paid_lbp > 0 ? `Paid: ${pounds(order.paid_lbp)}` : null,
    order.change_usd > 0 ? `Change: ${money(order.change_usd)}` : null,
    order.change_lbp > 0 ? `Change: ${pounds(order.change_lbp)}` : null,
    // A refunded sale must not read as a valid receipt for the goods.
    order.status === 'refunded' ? '\n*This sale was refunded.*' : null,
    '',
    settings.receipt_footer || null,
    ...signature(settings),
  ];

  return {
    to: waNumber(order.customer_phone, settings.phone_country_code),
    name: order.customer_name || null,
    text: join(lines),
  };
}

/**
 * A quotation, order or invoice, sent to the customer it is addressed to.
 *
 * What is still owed is the line that matters on an invoice, so it is the one
 * in bold — a customer who reads only one line should read that one.
 */
export function documentMessage(id) {
  const found = getDocument(id);
  if (!found) return null;

  const { document: doc, items } = found;
  const settings = getSettings();
  const type = DOC_TYPES[doc.doc_type];
  const rate = doc.exchange_rate || 0;

  const lines = [
    letterhead(settings),
    `${type?.label || 'Document'} ${doc.doc_number}`,
    doc.party_name ? `For: ${doc.party_name}` : null,
    readableDate(doc.issue_date || doc.created_at),
    // A quotation expires; an invoice is due. Both live in the same column.
    doc.valid_until
      ? `${doc.doc_type === 'quotation' ? 'Valid until' : 'Due'}: ${readableDate(doc.valid_until)}`
      : null,
    '',
    ...items.map((item) => itemLine(item.name, item.quantity, item.line_total)),
    '',
    doc.discount > 0 ? `Subtotal: ${money(doc.subtotal)}` : null,
    doc.discount > 0 ? `Discount: −${money(doc.discount)}` : null,
    doc.tax > 0 ? `Tax: ${money(doc.tax)}` : null,
    `Total: ${money(doc.total)}`,
    rate > 0 ? pounds(usdToLbp(doc.total, rate, settings.lbp_rounding)) : null,
    /*
     * Only once something has been paid: "Paid: $0.00" on a fresh invoice
     * reads as a complaint rather than a statement.
     */
    doc.paid_total > 0 ? `Paid: ${money(doc.paid_total)}` : null,
    doc.outstanding > 0 ? `*Outstanding: ${money(doc.outstanding)}*` : null,
    doc.outstanding <= 0 && doc.paid_total > 0 ? '*Paid in full — thank you.*' : null,
    doc.notes ? `\n${doc.notes}` : null,
    '',
    ...signature(settings),
  ];

  return {
    to: waNumber(doc.party_phone, settings.phone_country_code),
    name: doc.party_name || null,
    text: join(lines),
  };
}

const REPAIR_STATUS = {
  received: 'Received',
  diagnosed: 'Diagnosed',
  awaiting_parts: 'Awaiting parts',
  repairing: 'In repair',
  ready: 'Ready to collect',
  collected: 'Collected',
  cancelled: 'Cancelled',
};

/**
 * The repair ticket, so the customer has the number on their phone as well as
 * on paper — the slip is what gets lost between dropping a phone off and coming
 * back for it a week later.
 *
 * The passcode is never in here, and that is not an oversight. It is the one
 * thing the shop is holding that could unlock the customer's whole life, and a
 * WhatsApp message is a copy that lives on two phones, a laptop and whatever
 * backup either has running. It is stored encrypted for exactly this reason;
 * putting it in a message would undo that in one line.
 */
export function repairMessage(id) {
  const detail = ticketWithDetail(id);
  if (!detail) return null;

  const { ticket, parts, partsTotal } = detail;
  const settings = getSettings();
  const rate = settings.exchange_rate || 0;

  const noCharge = ticket.under_warranty === 1 && !ticket.charged;
  const collected = ticket.status === 'collected';
  const amount = collected && ticket.charged != null ? ticket.charged : (ticket.quoted ?? null);

  const priceLine = noCharge
    ? 'Under warranty — no charge'
    : amount === null
      ? 'To be quoted once we have looked at it'
      : `${collected ? 'Paid' : 'Estimate'}: ${money(amount)}${
          rate > 0 ? ` (${pounds(usdToLbp(amount, rate, settings.lbp_rounding))})` : ''
        }`;

  const lines = [
    letterhead(settings),
    'Repair ticket',
    `*${ticket.ticket_number}*`,
    '',
    ticket.customer_name,
    ticket.device,
    `Fault: ${ticket.fault}`,
    ticket.condition_note ? `Condition in: ${ticket.condition_note}` : null,
    `Status: ${REPAIR_STATUS[ticket.status] || ticket.status}`,
    `Taken in: ${readableDate(ticket.created_at, { withTime: true })}`,
    '',
    // Only worth listing once something has actually been fitted.
    parts.length > 0 ? `Parts: ${parts.map((p) => p.name).join(', ')} — ${money(partsTotal)}` : null,
    priceLine,
    '',
    collected ? null : 'Please keep this message and bring it when you collect the phone.',
    '',
    ...signature(settings),
  ];

  return {
    to: waNumber(ticket.customer_phone, settings.phone_country_code),
    name: ticket.customer_name || null,
    text: join(lines),
  };
}

/**
 * What the route hands back: the text, who it is going to, and the link that
 * opens WhatsApp with both already filled in.
 *
 * `phone` overrides whatever is on file — the number the shop has for a
 * customer is often the landline, and the person standing there can give the
 * mobile they actually use.
 */
/**
 * A reminder that somebody has a payment due, or a late one.
 *
 * Written to be sent as it is. A shop chasing money by hand writes something
 * short and polite and gets on with the day, and a reminder that reads like a
 * demand from a system is one a customer holds against the shop rather than
 * against the debt.
 *
 * What is owed altogether is included alongside what is due now, because the
 * question that always comes back is "and how much is left after that".
 */
export function installmentMessage(plan) {
  const settings = getSettings();
  const rate = settings.exchange_rate || 0;
  const inBoth = (usd) =>
    `${money(usd)}${rate > 0 ? ` (${pounds(usdToLbp(usd, rate, settings.lbp_rounding))})` : ''}`;

  const late = plan.overdueCount > 0;
  const due = plan.nextDue;

  const lines = [
    letterhead(settings),
    late ? 'Payment overdue' : 'Payment reminder',
    '',
    plan.customer_name,
    plan.order_number ? `For ${plan.order_number}` : null,
    '',
    late
      ? `*${inBoth(plan.overdueUsd)}* is past due${
          plan.overdueCount > 1 ? ` across ${plan.overdueCount} payments` : ''
        }.`
      : due
        ? `Next payment: *${inBoth(due.amount)}* on ${readableDate(due.date)}.`
        : 'Everything on this plan has been paid — thank you.',
    plan.outstandingUsd > 0 ? `Remaining altogether: ${inBoth(plan.outstandingUsd)}` : null,
    '',
    plan.outstandingUsd > 0 ? 'Thank you — please come by whenever suits you.' : null,
    '',
    ...signature(settings),
  ];

  return {
    to: waNumber(plan.customer_phone, settings.phone_country_code),
    name: plan.customer_name || null,
    text: join(lines),
  };
}

export function sendable(message, phone = null) {
  if (!message) return null;
  const settings = getSettings();
  const to = phone ? waNumber(phone, settings.phone_country_code) : message.to;
  return { ...message, to, url: waLink(to, message.text) };
}

/**
 * What the message actually says.
 *
 * Kept apart from the sending so the wording can be tested without a network,
 * and so every event reads the same way — a phone buzzing at a supplier is not
 * a place to work out what a message means.
 *
 * Rules the shape follows:
 *
 * - **The money first.** That is what the glance is for. A notification that
 *   opens with a document number makes the owner read to the end of the line
 *   before learning anything.
 * - **Who did it, always.** Half the value of knowing a sale was voided is
 *   knowing which till voided it.
 * - **The branch, only when there is more than one.** "Main branch" on every
 *   message for a shop with one counter is noise that trains people to stop
 *   reading.
 */
import { db } from '../db.js';
import { getSettings } from './settings.js';

/** Telegram parses HTML, so anything from the shop's own data is escaped. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function usd(amount) {
  const n = Number(amount) || 0;
  return `$${n.toFixed(2)}`;
}

/** Named only when the shop has more than one, for the reason above. */
function branchLine(branchId) {
  if (!branchId) return '';
  try {
    const count = db.prepare('SELECT COUNT(*) AS n FROM branches WHERE active = 1').get()?.n ?? 1;
    if (count < 2) return '';
    const name = db.prepare('SELECT name FROM branches WHERE id = ?').get(branchId)?.name;
    return name ? `\n🏬 ${esc(name)}` : '';
  } catch {
    return '';
  }
}

function shopName() {
  try {
    return getSettings().company_name || 'The shop';
  } catch {
    return 'The shop';
  }
}

const HOW_PAID = {
  cash: 'cash',
  card: 'card',
  account: 'on account',
  split: 'split',
  transfer: 'transfer',
};

export function saleText({ orderNumber, total, paymentMethod, itemCount, user, branchId, customer }) {
  const how = HOW_PAID[paymentMethod] || paymentMethod || '';
  return (
    `🧾 <b>${usd(total)}</b> — sale${how ? ` (${esc(how)})` : ''}\n` +
    `${esc(orderNumber)} · ${itemCount} item${itemCount === 1 ? '' : 's'}` +
    `${customer ? `\n👤 ${esc(customer)}` : ''}` +
    `\n🧑 ${esc(user)}` +
    branchLine(branchId) +
    `\n<i>${esc(shopName())}</i>`
  );
}

export function refundText({ orderNumber, total, user, branchId, reason }) {
  return (
    `↩️ <b>${usd(total)}</b> — sale voided\n` +
    `${esc(orderNumber)}` +
    `${reason ? `\n${esc(reason)}` : ''}` +
    `\n🧑 ${esc(user)}` +
    branchLine(branchId) +
    `\n<i>${esc(shopName())}</i>`
  );
}

export function returnText({ orderNumber, amount, quantity, itemName, user, branchId }) {
  return (
    `↩️ <b>${usd(amount)}</b> — returned\n` +
    `${quantity} × ${esc(itemName)} from ${esc(orderNumber)}` +
    `\n🧑 ${esc(user)}` +
    branchLine(branchId) +
    `\n<i>${esc(shopName())}</i>`
  );
}

export function cashText({ direction, amountUsd, amountLbp, reason, note, user, branchId }) {
  const parts = [];
  if (Number(amountUsd)) parts.push(usd(Math.abs(amountUsd)));
  if (Number(amountLbp)) parts.push(`${Math.abs(Math.round(amountLbp)).toLocaleString('en-US')} LL`);
  return (
    `${direction === 'in' ? '📥' : '📤'} <b>${parts.join(' + ') || usd(0)}</b> — cash ${direction === 'in' ? 'in' : 'out'}\n` +
    `${esc(reason || '')}${note ? ` · ${esc(note)}` : ''}` +
    `\n🧑 ${esc(user)}` +
    branchLine(branchId) +
    `\n<i>${esc(shopName())}</i>`
  );
}

export function cashboxText({ opened, accountName, countedUsd, overShortUsd, user, branchId }) {
  if (opened) {
    return (
      `🔓 Cashbox opened — ${esc(accountName || 'the drawer')}` +
      `\n🧑 ${esc(user)}` + branchLine(branchId) + `\n<i>${esc(shopName())}</i>`
    );
  }
  const short = Number(overShortUsd) || 0;
  const verdict = short === 0 ? 'counted square' : short < 0 ? `${usd(short)} short` : `${usd(short)} over`;
  return (
    `🔒 Cashbox closed — ${esc(accountName || 'the drawer')}\n` +
    `Counted ${usd(countedUsd)} · <b>${verdict}</b>` +
    `\n🧑 ${esc(user)}` + branchLine(branchId) + `\n<i>${esc(shopName())}</i>`
  );
}

export function documentText({ docNumber, docType, total, partyName, user, branchId }) {
  const label = String(docType || '').replace(/_/g, ' ');
  return (
    `📄 <b>${usd(total)}</b> — ${esc(label)} confirmed\n` +
    `${esc(docNumber)}${partyName ? ` · ${esc(partyName)}` : ''}` +
    `\n🧑 ${esc(user)}` + branchLine(branchId) + `\n<i>${esc(shopName())}</i>`
  );
}

export function deletedText({ what, detail, user, branchId }) {
  return (
    `🗑️ <b>${esc(what)} deleted</b>` +
    `${detail ? `\n${esc(detail)}` : ''}` +
    `\n🧑 ${esc(user)}` + branchLine(branchId) + `\n<i>${esc(shopName())}</i>`
  );
}

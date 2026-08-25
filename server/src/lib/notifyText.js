/**
 * What the message actually says.
 *
 * Kept apart from the sending so the wording can be tested without a network,
 * and so every event reads the same way — a phone buzzing at a supplier is not
 * a place to work out what a message means.
 *
 * The shop can rewrite any of it. The built-in wording below is a default, not
 * a rule: a shop that wants its messages in Arabic, or shorter, or without the
 * cashier's name, types its own. What it cannot change is which facts are
 * available, so each event publishes the placeholders it can fill.
 *
 * Rules the built-in shapes follow, and which a shop is free to abandon:
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
function branchName(branchId) {
  if (!branchId) return '';
  try {
    const count = db.prepare('SELECT COUNT(*) AS n FROM branches WHERE active = 1').get()?.n ?? 1;
    if (count < 2) return '';
    return db.prepare('SELECT name FROM branches WHERE id = ?').get(branchId)?.name || '';
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

/**
 * The wording a shop gets until it writes its own.
 *
 * Every line that depends on a fact which is often absent — a customer, a
 * second branch — is its own placeholder ending in `_line`, holding the whole
 * line including its newline. That is what lets a template leave it in
 * unconditionally: on a sale to a walk-in it renders as nothing at all rather
 * than as a stray emoji with a blank after it.
 */
export const DEFAULT_TEMPLATES = {
  sale: '🧾 <b>{total}</b> — sale{paid_bracket}\n{reference} · {items}{customer_line}\n🧑 {user}{branch_line}\n<i>{shop}</i>',
  refund: '↩️ <b>{total}</b> — sale voided\n{reference}{reason_line}\n🧑 {user}{branch_line}\n<i>{shop}</i>',
  return: '↩️ <b>{total}</b> — returned\n{items} from {reference}\n🧑 {user}{branch_line}\n<i>{shop}</i>',
  cash: '{icon} <b>{total}</b> — cash {direction}\n{reason}{note_suffix}\n🧑 {user}{branch_line}\n<i>{shop}</i>',
  cashbox: '{icon} Cashbox {state} — {account}{count_line}\n🧑 {user}{branch_line}\n<i>{shop}</i>',
  document: '📄 <b>{total}</b> — {kind} confirmed\n{reference}{party_suffix}\n🧑 {user}{branch_line}\n<i>{shop}</i>',
  delete: '🗑️ <b>{what} deleted</b>{detail_line}\n🧑 {user}{branch_line}\n<i>{shop}</i>',
};

/**
 * What a shop may put in each template, and what each one means.
 *
 * Sent to the settings screen so the boxes carry their own instructions. A list
 * of placeholders that lives only in a comment is a list nobody at a counter
 * will ever find.
 */
export const PLACEHOLDERS = {
  sale: {
    total: 'The sale total, e.g. $12.00',
    reference: 'The order number',
    items: 'How many lines, e.g. "3 items"',
    paid: 'cash, card, on account…',
    paid_bracket: 'The same in brackets, or nothing if unknown',
    customer: 'The customer’s name, if there is one',
    customer_line: 'A whole line naming the customer, or nothing',
    user: 'Who rang it up',
    branch: 'Which branch, when there is more than one',
    branch_line: 'A whole line naming the branch, or nothing',
    shop: 'Your shop’s name',
  },
  refund: {
    total: 'What went back', reference: 'The order number',
    reason: 'The reason given, if any', reason_line: 'A whole line for it, or nothing',
    user: 'Who voided it', branch: 'Which branch', branch_line: 'A whole line, or nothing',
    shop: 'Your shop’s name',
  },
  return: {
    total: 'What went back', reference: 'The order number',
    items: 'What came back, e.g. "2 × Charger"',
    user: 'Who took it back', branch: 'Which branch', branch_line: 'A whole line, or nothing',
    shop: 'Your shop’s name',
  },
  cash: {
    total: 'The amount, both currencies if both moved', direction: 'in or out',
    icon: '📥 or 📤', reason: 'Why — supplier, wages, petty cash…',
    note: 'The note typed with it', note_suffix: 'The note after a ·, or nothing',
    user: 'Who moved it', branch: 'Which branch', branch_line: 'A whole line, or nothing',
    shop: 'Your shop’s name',
  },
  cashbox: {
    state: 'opened or closed', icon: '🔓 or 🔒', account: 'Which till',
    counted: 'What was counted at close', verdict: 'square, $5.00 short, $5.00 over',
    count_line: 'A whole line with the count and the verdict, or nothing on open',
    user: 'Who did it', branch: 'Which branch', branch_line: 'A whole line, or nothing',
    shop: 'Your shop’s name',
  },
  document: {
    total: 'The document total', reference: 'The document number',
    kind: 'sales invoice, quotation…', party: 'The customer or supplier',
    party_suffix: 'The party after a ·, or nothing',
    user: 'Who confirmed it', branch: 'Which branch', branch_line: 'A whole line, or nothing',
    shop: 'Your shop’s name',
  },
  delete: {
    what: 'What kind of thing it was', detail: 'Its number and amount',
    detail_line: 'A whole line for that, or nothing',
    user: 'Who deleted it', branch: 'Which branch', branch_line: 'A whole line, or nothing',
    shop: 'Your shop’s name',
  },
};

/** The shop's own wording for one event, or the built-in one. */
export function templateFor(event, settings = getSettings()) {
  try {
    const stored = JSON.parse(settings.telegram_templates || '{}');
    const own = String(stored?.[event] ?? '').trim();
    if (own) return own;
  } catch {
    // A settings row that is not valid JSON must not stop the message going
    // out — the built-in wording is a working answer.
  }
  return DEFAULT_TEMPLATES[event] || '';
}

/**
 * Put the facts into the wording.
 *
 * The **template** is the shop's own and may contain HTML, because Telegram
 * renders it and a shop that wants a figure in bold should be able to say so.
 * The **values** are the shop's data and are escaped, because a customer called
 * `Ahmad <Phones>` must not be able to break the message — or, put less
 * politely, must not be able to write the markup.
 *
 * A placeholder nobody recognises is left standing rather than dropped. A
 * template with `{totl}` in it then says `{totl}` on the phone, which is how
 * somebody finds out they typed it wrong; silently rendering nothing there
 * would look like the app losing the figure.
 */
export function render(template, values) {
  return String(template || '').replace(/\{(\w+)\}/g, (whole, key) =>
    Object.hasOwn(values, key) ? String(values[key] ?? '') : whole,
  );
}

/** The values every event carries, so the common placeholders behave alike. */
function common({ user, branchId }) {
  const branch = branchName(branchId);
  return {
    user: esc(user),
    branch: esc(branch),
    branch_line: branch ? `\n🏬 ${esc(branch)}` : '',
    shop: esc(shopName()),
  };
}

function build(event, values, settings) {
  return render(templateFor(event, settings), values);
}

export function saleText({ orderNumber, total, paymentMethod, itemCount, user, branchId, customer }, settings) {
  const how = HOW_PAID[paymentMethod] || paymentMethod || '';
  return build('sale', {
    ...common({ user, branchId }),
    total: usd(total),
    reference: esc(orderNumber),
    items: `${itemCount} item${itemCount === 1 ? '' : 's'}`,
    paid: esc(how),
    paid_bracket: how ? ` (${esc(how)})` : '',
    customer: esc(customer || ''),
    customer_line: customer ? `\n👤 ${esc(customer)}` : '',
  }, settings);
}

export function refundText({ orderNumber, total, user, branchId, reason }, settings) {
  return build('refund', {
    ...common({ user, branchId }),
    total: usd(total),
    reference: esc(orderNumber),
    reason: esc(reason || ''),
    reason_line: reason ? `\n${esc(reason)}` : '',
  }, settings);
}

export function returnText({ orderNumber, amount, quantity, itemName, user, branchId }, settings) {
  return build('return', {
    ...common({ user, branchId }),
    total: usd(amount),
    reference: esc(orderNumber),
    items: `${quantity} × ${esc(itemName)}`,
  }, settings);
}

export function cashText({ direction, amountUsd, amountLbp, reason, note, user, branchId }, settings) {
  const parts = [];
  if (Number(amountUsd)) parts.push(usd(Math.abs(amountUsd)));
  if (Number(amountLbp)) parts.push(`${Math.abs(Math.round(amountLbp)).toLocaleString('en-US')} LL`);
  return build('cash', {
    ...common({ user, branchId }),
    total: parts.join(' + ') || usd(0),
    direction: direction === 'in' ? 'in' : 'out',
    icon: direction === 'in' ? '📥' : '📤',
    reason: esc(reason || ''),
    note: esc(note || ''),
    note_suffix: note ? ` · ${esc(note)}` : '',
  }, settings);
}

export function cashboxText({ opened, accountName, countedUsd, overShortUsd, user, branchId }, settings) {
  const short = Number(overShortUsd) || 0;
  /* "$-5.00 short" says the minus twice. The word carries the direction, so
     the figure is the size of the gap and nothing else. */
  const verdict =
    short === 0 ? 'counted square' : `${usd(Math.abs(short))} ${short < 0 ? 'short' : 'over'}`;
  return build('cashbox', {
    ...common({ user, branchId }),
    state: opened ? 'opened' : 'closed',
    icon: opened ? '🔓' : '🔒',
    account: esc(accountName || 'the drawer'),
    counted: opened ? '' : usd(countedUsd),
    verdict: opened ? '' : verdict,
    count_line: opened ? '' : `\nCounted ${usd(countedUsd)} · <b>${verdict}</b>`,
  }, settings);
}

export function documentText({ docNumber, docType, total, partyName, user, branchId }, settings) {
  return build('document', {
    ...common({ user, branchId }),
    total: usd(total),
    reference: esc(docNumber),
    kind: esc(String(docType || '').replace(/_/g, ' ')),
    party: esc(partyName || ''),
    party_suffix: partyName ? ` · ${esc(partyName)}` : '',
  }, settings);
}

export function deletedText({ what, detail, user, branchId }, settings) {
  return build('delete', {
    ...common({ user, branchId }),
    what: esc(what),
    detail: esc(detail || ''),
    detail_line: detail ? `\n${esc(detail)}` : '',
  }, settings);
}

/**
 * One event's message, with a worked example in it.
 *
 * Deliberately routed through the same builders the real messages use rather
 * than through a second copy of the wording: a preview that is written
 * separately is a preview that will eventually disagree with what actually
 * gets sent, and the shop will trust the wrong one.
 *
 * The example is a plausible sale rather than lorem ipsum, because the point of
 * looking is to judge whether the message reads well with real figures in it.
 */
export function previewText(event, settings = getSettings()) {
  const who = { user: 'Store Owner', branchId: null };
  switch (event) {
    case 'sale':
      return saleText(
        { ...who, orderNumber: 'ORD-2416', total: 27.5, paymentMethod: 'cash', itemCount: 3, customer: 'Rami Haddad' },
        settings,
      );
    case 'refund':
      return refundText({ ...who, orderNumber: 'ORD-2416', total: 27.5, reason: 'wrong item' }, settings);
    case 'return':
      return returnText({ ...who, orderNumber: 'ORD-2416', amount: 12, quantity: 2, itemName: 'Fast charger' }, settings);
    case 'cash':
      return cashText(
        { ...who, direction: 'out', amountUsd: -40, amountLbp: 0, reason: 'supplier', note: 'Cables delivery' },
        settings,
      );
    case 'cashbox':
      return cashboxText({ ...who, opened: false, accountName: 'Counter drawer', countedUsd: 315, overShortUsd: -5 }, settings);
    case 'document':
      return documentText(
        { ...who, docNumber: 'SI-0104', docType: 'sales_invoice', total: 180, partyName: 'Rami Haddad' },
        settings,
      );
    case 'delete':
      return deletedText({ ...who, what: 'sales invoice', detail: 'SI-0104 · 180.00 USD' }, settings);
    default:
      throw new Error('Not an event this app sends');
  }
}

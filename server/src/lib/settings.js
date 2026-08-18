import { db } from '../db.js';

/**
 * Store settings, held as a small key/value table so new options can be added
 * without a migration. Values are stored as text and coerced on read.
 */
export const SETTING_DEFAULTS = {
  exchange_rate: 89000,
  lbp_rounding: 1000,
  secondary_currency: 'LBP',

  /*
   * Who the shop is, as it appears on anything a customer keeps.
   *
   * A receipt with no name on it is a scrap of paper: it cannot be brought back
   * for a warranty claim, and it is not a document anybody would accept. These
   * are settings rather than a table because there is exactly one shop — the
   * branches under it are a separate thing, and they are the ones that vary.
   */
  company_name: 'Front Desk POS',
  company_tagline: '',
  company_phone: '',
  company_phone2: '',
  company_address: '',
  company_email: '',
  company_website: '',
  /* The registration number a Lebanese invoice is expected to carry. */
  company_tax_number: '',
  /* A URL, or a data: URI for a logo pasted straight in. */
  company_logo_url: '',
  /* The line at the foot of a receipt: returns policy, thank you, opening hours. */
  receipt_footer: '',
  /*
   * The dialling code local numbers get when they are sent to WhatsApp, which
   * wants every number in international form. Lebanon by default; a shop
   * anywhere else changes it once and every number it has on file follows.
   */
  phone_country_code: '961',

  /*
   * Tax, as the shop's own number rather than the machine's.
   *
   * This was an environment variable, which meant a shop that charges no tax —
   * most small shops here — had eight per cent added to every sale and no way
   * to reach the setting that did it. A figure that appears on every receipt a
   * customer keeps belongs on the settings screen.
   *
   * Off by default, and stored as a percentage rather than a fraction because
   * that is what somebody types: `11` is eleven per cent, not eleven hundred.
   */
  tax_enabled: 'false',
  tax_percent: 0,
  /* What it is called on a receipt — VAT, TVA, or the shop's own word. */
  tax_name: 'Tax',

  /*
   * The till the transfer counter works out of.
   *
   * Empty means it shares the register's drawer, which is right for a shop with
   * one counter and wrong for every shop that runs the agency desk as its own
   * position: the operator's float, their sends and their payouts all landing
   * in the cashier's drawer makes both of them impossible to count. Stored as
   * the id of a cash account, shop-wide rather than per browser, because which
   * physical drawer the money goes into is not a matter of opinion.
   */
  transfer_account_id: '',

  /*
   * Whether a cash sale needs an open drawer. On by default: a till that can
   * take money with nothing to put it in cannot be counted at the end of the
   * day, which is the whole point of a cashbox.
   */
  require_cash_session: 'true',

  // Shopify connection. The token is a credential: it is stored here but never
  // sent back to the browser — see SECRET_SETTINGS.
  shopify_enabled: 'false',
  shopify_domain: '',
  shopify_token: '',
  shopify_location_id: '',
  shopify_location_name: '',
  shopify_last_sync: '',
  // Only ever set by the tests, which point the client at a stand-in server.
  shopify_base_url: '',
};

/** Never leaves the server. Redacted to a boolean for the UI. */
export const SECRET_SETTINGS = new Set(['shopify_token']);

const NUMERIC = new Set(['exchange_rate', 'lbp_rounding', 'tax_percent']);

/**
 * The rate to actually multiply by, as a fraction.
 *
 * One function so the register, the invoices and the receipt cannot disagree
 * about it — three copies of `percent / 100` is three chances to ship a shop
 * that charges eight hundred per cent. Switched off means zero, not "skip the
 * arithmetic", so every total keeps the same shape whether tax is on or not.
 */
export function taxRate(settings = getSettings()) {
  if (String(settings.tax_enabled) !== 'true') return 0;
  const percent = Number(settings.tax_percent);
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  // A shop cannot mistype its way to charging more tax than the price.
  return Math.min(percent, 100) / 100;
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const settings = {};
  for (const [key, fallback] of Object.entries(SETTING_DEFAULTS)) {
    const raw = stored[key];
    if (raw === undefined) {
      settings[key] = fallback;
    } else if (NUMERIC.has(key)) {
      const n = Number(raw);
      settings[key] = Number.isFinite(n) ? n : fallback;
    } else {
      settings[key] = raw;
    }
  }
  return settings;
}

/** The rate to price a sale at right now. */
export function getExchangeRate() {
  return getSettings().exchange_rate;
}

/**
 * Settings safe to send to a browser: credentials become a boolean saying
 * whether one is set, so the UI can show "connected" without ever holding a
 * token it could leak.
 */
export function publicSettings() {
  const settings = getSettings();
  const safe = {};
  for (const [key, value] of Object.entries(settings)) {
    if (SECRET_SETTINGS.has(key)) safe[`${key}_set`] = !!value;
    else safe[key] = value;
  }
  return safe;
}

export function setSetting(key, value, userId) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(key, String(value), userId ?? null);
}

/** Record a rate change so past rates remain auditable. */
export function recordRateChange(rate, userId) {
  db.prepare('INSERT INTO exchange_rate_history (rate, user_id) VALUES (?, ?)').run(rate, userId ?? null);
}

export function getRateHistory(limit = 30) {
  return db
    .prepare(
      `SELECT h.*, u.name AS user_name
       FROM exchange_rate_history h
       LEFT JOIN users u ON u.id = h.user_id
       ORDER BY h.created_at DESC, h.id DESC
       LIMIT ?`,
    )
    .all(Math.min(Number(limit) || 30, 200));
}

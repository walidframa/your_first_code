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

const NUMERIC = new Set(['exchange_rate', 'lbp_rounding']);

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

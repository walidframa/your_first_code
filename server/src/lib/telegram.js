/**
 * Telling the owner what just happened at the counter.
 *
 * A shop owner is not standing at the till. They are at a supplier, at home,
 * at the second branch — and the one thing they want from a POS while they are
 * anywhere else is to know that it is still ringing up sales, and to find out
 * within seconds when somebody voids one. Reading it back off a report the next
 * morning is not the same fact.
 *
 * Telegram rather than SMS or email, for three reasons that all matter here:
 * it costs nothing per message, the bot is set up in two minutes without an
 * account manager, and it already has an app on the owner's phone that buzzes.
 * That last one is the whole "notify my phone" requirement, met by software
 * somebody else maintains.
 *
 * ## The rule this file exists to enforce
 *
 * **A sale must never fail, or wait, because of a notification.**
 *
 * The message is a courtesy; the sale is the shop's money. So nothing in here
 * is awaited by a route, nothing in here throws where a route could catch it,
 * and every send carries its own timeout — a Telegram that accepts the
 * connection and then says nothing must not hold a socket open behind a
 * cashier who has already moved on to the next customer.
 *
 * Failures are counted and the last one is kept, so the settings screen can
 * say "the last twelve messages did not arrive" instead of the shop finding out
 * by noticing silence.
 */
import { getSettings, setSetting } from './settings.js';

/** Kept in memory: what happened to the last send, for the settings screen. */
let lastResult = null;

export function lastSend() {
  return lastResult;
}

/** So a test can watch what would have gone out without a network. */
let fetchImpl = (...args) => fetch(...args);
export function setFetchForTests(fn) {
  fetchImpl = fn || ((...args) => fetch(...args));
}

/**
 * The events a shop can be told about.
 *
 * Named rather than free-form so the settings screen can offer them as
 * checkboxes, and so a shop that only wants to hear about voids is not also
 * woken by every bar of chocolate.
 */
export const NOTIFY_EVENTS = {
  sale: 'Sales rung up',
  refund: 'Refunds and voids',
  return: 'Single lines returned',
  cash: 'Cash in and out of the drawer by hand',
  cashbox: 'The cashbox opened and closed',
  document: 'Invoices and quotations confirmed',
  delete: 'Anything deleted',
};

export function enabledEvents(settings = getSettings()) {
  const raw = String(settings.telegram_events || '').trim();
  // Empty means everything: a shop that has just switched this on wants to see
  // that it works, not to discover it also had to tick seven boxes.
  if (!raw) return new Set(Object.keys(NOTIFY_EVENTS));
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

export function isConfigured(settings = getSettings()) {
  return Boolean(settings.telegram_bot_token && settings.telegram_chat_id);
}

function apiBase(settings) {
  // Overridable so the tests can point at a stand-in rather than the real API.
  const base = String(settings.telegram_base_url || 'https://api.telegram.org').replace(/\/$/, '');
  return `${base}/bot${settings.telegram_bot_token}`;
}

/**
 * Post one message. Awaited only by the "send a test message" button, which is
 * the one caller that genuinely wants to know whether it worked.
 */
export async function sendMessage(text, { settings = getSettings() } = {}) {
  if (!isConfigured(settings)) throw new Error('Telegram is not set up — add the bot token and chat id');

  const res = await fetchImpl(`${apiBase(settings)}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: settings.telegram_chat_id,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
    /*
     * A hard ceiling, because this runs behind a counter. Telegram accepting
     * the connection and then going quiet must not hold a socket for two
     * minutes on a machine that is also serving a register.
     */
    signal: AbortSignal.timeout(8000),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    /*
     * Telegram's own words, not a status code. "chat not found" and "bot was
     * blocked by the user" are both 400, and they are completely different
     * things to go and fix.
     */
    throw new Error(body?.description || `Telegram returned ${res.status}`);
  }
  return body.result;
}

/**
 * Tell the owner, and get out of the way.
 *
 * Deliberately not `async` from the caller's point of view: a route calls this
 * and carries straight on. Whatever happens to the message happens after the
 * customer has their receipt.
 */
export function notify(event, text) {
  let settings;
  try {
    settings = getSettings();
  } catch {
    // The database is the shop's problem, not this file's, and a notification
    // is never the right place to surface it.
    return;
  }

  if (String(settings.telegram_enabled) !== 'true') return;
  if (!isConfigured(settings)) return;
  if (!enabledEvents(settings).has(event)) return;

  /*
   * Off the request's back. `queueMicrotask` rather than an await so the
   * response is already on its way to the till before the first byte of this
   * goes anywhere.
   */
  queueMicrotask(() => {
    sendMessage(text, { settings })
      .then(() => {
        lastResult = { ok: true, at: new Date().toISOString(), event };
      })
      .catch((err) => {
        lastResult = { ok: false, at: new Date().toISOString(), event, error: err.message };
        /*
         * Counted, so the settings screen can say how long it has been
         * failing. A shop finds out its notifications stopped by noticing
         * silence, which is the worst possible way to find out.
         */
        try {
          const failures = Number(getSettings().telegram_failures || 0) + 1;
          setSetting('telegram_failures', String(failures));
          setSetting('telegram_last_error', err.message.slice(0, 300));
        } catch {
          // Writing down that a message failed must not itself throw.
        }
      });
  });
}

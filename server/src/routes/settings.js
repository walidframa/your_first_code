import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { serialiseLabelStyle } from '../lib/labelStyle.js';
import {
  getSettings,
  publicSettings,
  setSetting,
  recordRateChange,
  getRateHistory,
} from '../lib/settings.js';
import { NOTIFY_EVENTS, enabledEvents, isConfigured, lastSend, sendMessage } from '../lib/telegram.js';
import { DEFAULT_TEMPLATES, PLACEHOLDERS, previewText } from '../lib/notifyText.js';

const router = Router();

/**
 * Who the shop is. Free text, so it is saved as typed.
 *
 * The one that needs a limit is the logo: pasted as a data: URI it is the only
 * setting that can be megabytes, and it is read on every page load.
 */
const COMPANY_FIELDS = [
  'company_name',
  'company_tagline',
  'company_phone',
  'company_phone2',
  'company_address',
  'company_email',
  'company_website',
  'company_tax_number',
  'company_logo_url',
  'receipt_footer',
  'phone_country_code',
];

const TELEGRAM_FIELDS = [
  'telegram_enabled',
  'telegram_bot_token',
  'telegram_chat_id',
  'telegram_events',
  'telegram_templates',
  'telegram_base_url',
];

const MAX_LOGO_BYTES = 400 * 1024;

/** Any signed-in user can read settings — the register needs the live rate. */
router.get('/', requireAuth, (req, res) => {
  res.json({ settings: publicSettings() });
});

router.get('/rate-history', requireAuth, requirePermission('settings'), (req, res) => {
  res.json({ history: getRateHistory(req.query.limit) });
});

router.put('/', requireAuth, requirePermission('settings'), (req, res) => {
  const { exchange_rate: exchangeRate, lbp_rounding: lbpRounding } = req.body || {};
  const current = getSettings();

  if (exchangeRate !== undefined) {
    const rate = Number(exchangeRate);
    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(400).json({ error: 'Exchange rate must be a positive number' });
    }
    if (rate !== current.exchange_rate) {
      setSetting('exchange_rate', rate, req.user.id);
      recordRateChange(rate, req.user.id);
    }
  }

  if (lbpRounding !== undefined) {
    const step = Number(lbpRounding);
    if (!Number.isFinite(step) || step < 1) {
      return res.status(400).json({ error: 'Rounding step must be at least 1' });
    }
    setSetting('lbp_rounding', Math.round(step), req.user.id);
  }

  /*
   * Tax, which is the shop's own number rather than the machine's.
   *
   * Validated here rather than trusted from the browser, because it lands on
   * every receipt a customer keeps: a slipped decimal is a shop charging eleven
   * hundred per cent and only finding out from the person at the counter.
   */
  /*
   * Checked before any of it is written.
   *
   * These arrive together — switch, rate and name are one form — so applying
   * the switch and then refusing the rate would turn tax *on* at whatever the
   * old rate was, which is the opposite of what the person pressing Save
   * asked for and lands on the next customer's receipt.
   */
  if (req.body.tax_percent !== undefined) {
    const percent = Number(req.body.tax_percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return res.status(400).json({ error: 'Tax must be between 0 and 100 per cent' });
    }
  }

  if (req.body.tax_enabled !== undefined) {
    const on = req.body.tax_enabled === true || req.body.tax_enabled === 'true';
    setSetting('tax_enabled', on ? 'true' : 'false', req.user.id);
  }
  if (req.body.tax_percent !== undefined) {
    setSetting('tax_percent', Number(req.body.tax_percent), req.user.id);
  }
  if (req.body.tax_name !== undefined) {
    // Blank falls back rather than printing an unlabelled line on a receipt.
    setSetting('tax_name', String(req.body.tax_name || '').trim() || 'Tax', req.user.id);
  }

  /*
   * The shop's own label design.
   *
   * Normalised rather than stored as sent: this row is served on every page
   * load, and a size out of range prints a label with the barcode off the
   * bottom of it. Sending null puts the shop back on the built-in design.
   */
  if (req.body.label_style !== undefined) {
    const wanted = req.body.label_style;
    setSetting('label_style', wanted === null ? '' : serialiseLabelStyle(wanted), req.user.id);
  }

  /*
   * The money the shop started with, and the month it started counting from.
   *
   * Checked here rather than trusted: this is the figure every capital number
   * is measured from, and a stray minus sign would report a shop as having lost
   * its way through a year it actually did well in.
   */
  if (req.body.capital_opening !== undefined) {
    const amount = Number(req.body.capital_opening);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'Opening capital cannot be less than nothing' });
    }
    setSetting('capital_opening', amount, req.user.id);
  }

  if (req.body.capital_opening_date !== undefined) {
    const date = String(req.body.capital_opening_date || '').trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Give the starting date as YYYY-MM-DD' });
    }
    setSetting('capital_opening_date', date, req.user.id);
  }

  for (const field of COMPANY_FIELDS) {
    if (req.body[field] === undefined) continue;
    const value = String(req.body[field] ?? '').trim();

    if (field === 'company_logo_url' && Buffer.byteLength(value, 'utf8') > MAX_LOGO_BYTES) {
      return res.status(400).json({
        error:
          'That logo is too big. Keep it under 400KB — a receipt prints it at about 40mm wide, ' +
          'so a small PNG is all it needs.',
      });
    }
    /*
     * A dialling code with anything but digits in it silently produces numbers
     * WhatsApp cannot open, and the failure looks like "the button is broken"
     * rather than "the code is wrong". Cheaper to refuse it here.
     */
    if (field === 'phone_country_code' && value && !/^\d{1,4}$/.test(value)) {
      return res.status(400).json({ error: 'A dialling code is 1–4 digits, without the +' });
    }
    if (field === 'company_name' && !value) {
      // Everything a customer keeps is headed with this. Blank would print a
      // receipt nobody could bring back.
      return res.status(400).json({ error: 'The company name cannot be empty' });
    }

    setSetting(field, value, req.user.id);
  }

  /*
   * Telling the owner what happened.
   *
   * Its own block rather than another name in COMPANY_FIELDS, because each of
   * these fails in the same nasty way when it is wrong: silence. A mistyped bot
   * token and a shop that simply has not sold anything yet look identical from
   * the settings screen, so what can be checked is checked here.
   */
  for (const field of TELEGRAM_FIELDS) {
    if (req.body[field] === undefined) continue;
    const value = String(req.body[field] ?? '').trim();

    /*
     * Telegram issues these as `<digits>:<letters and dashes>`. A token pasted
     * with the surrounding quotes, or half of one, produces "unauthorized" —
     * which the shop never sees, because nothing awaits the send.
     */
    if (field === 'telegram_bot_token' && value && !/^\d{5,}:[\w-]{20,}$/.test(value)) {
      return res.status(400).json({
        error: 'That does not look like a bot token. BotFather gives you one like 123456789:AA…',
      });
    }
    /* A group's id is negative, a person's is positive; both are digits. */
    if (field === 'telegram_chat_id' && value && !/^-?\d+$/.test(value)) {
      return res.status(400).json({ error: 'A chat id is a number, like 123456789 or -1001234567890' });
    }
    /*
     * Refused rather than stored, because a broken template is a message that
     * either never arrives or arrives wrong, and neither says why. Checked as
     * JSON and then event by event: an unknown event name is almost always a
     * typo, and stored quietly it would sit there doing nothing for ever.
     */
    if (field === 'telegram_templates' && value) {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        return res.status(400).json({ error: 'The message templates could not be read' });
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return res.status(400).json({ error: 'The message templates could not be read' });
      }
      for (const [event, text] of Object.entries(parsed)) {
        if (!(event in NOTIFY_EVENTS)) {
          return res.status(400).json({ error: `Not an event this app sends: ${event}` });
        }
        if (String(text).length > 2000) {
          return res.status(400).json({ error: 'A message template is too long — keep it under 2000 characters' });
        }
      }
    }
    if (field === 'telegram_events' && value) {
      const unknown = value.split(',').map((v) => v.trim()).filter((v) => v && !(v in NOTIFY_EVENTS));
      if (unknown.length) {
        return res.status(400).json({ error: `Not an event this app sends: ${unknown.join(', ')}` });
      }
    }
    /*
     * Only ever pointed somewhere else by the tests. In a running shop this
     * would be a way to send every sale to somebody else's server, and no shop
     * has a reason to change it.
     */
    if (field === 'telegram_base_url' && process.env.NODE_ENV !== 'test') continue;

    setSetting(field, value, req.user.id);
  }

  res.json({ settings: publicSettings() });
});

/**
 * Send one message now, and say plainly whether it arrived.
 *
 * The whole setup is two strings copied from two different places in Telegram,
 * and getting either of them wrong produces silence rather than an error. So
 * this is not a nicety: it is the only way a shop can tell the difference
 * between "configured correctly and nothing has happened yet" and "typed the
 * chat id wrong a week ago".
 *
 * Awaited, unlike every other send in the app, because this is the one caller
 * that exists specifically to find out.
 */
router.post('/telegram/test', requireAuth, requirePermission('settings'), async (req, res) => {
  try {
    await sendMessage(
      `✅ <b>Front Desk is connected</b>\nThis is a test message from ${
        getSettings().company_name || 'your shop'
      }. Sales, voids and cash movements will arrive here.`,
    );
    // A message that got through clears the tally: whatever was wrong is not
    // wrong any more, and a stale count would keep saying it was.
    setSetting('telegram_failures', '0', req.user.id);
    setSetting('telegram_last_error', '', req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * What a template would actually say, with a worked example in it.
 *
 * A template is edited blind otherwise: the shop types `{paid_bracket}` and has
 * to ring up a real sale to find out what it does. This renders the same
 * builders the real messages go through, so the preview cannot drift from the
 * thing it is previewing.
 */
router.post('/telegram/preview', requireAuth, requirePermission('settings'), (req, res) => {
  const event = String(req.body?.event || '');
  if (!(event in NOTIFY_EVENTS)) return res.status(400).json({ error: 'Not an event this app sends' });

  // The shop's unsaved draft, or what is stored if they are only looking.
  const draft = req.body?.template;
  const settings =
    draft === undefined
      ? getSettings()
      : { ...getSettings(), telegram_templates: JSON.stringify({ [event]: String(draft) }) };

  try {
    res.json({ text: previewText(event, settings) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Whether the last message got through, for the settings screen. */
router.get('/telegram/status', requireAuth, requirePermission('settings'), (req, res) => {
  const settings = getSettings();
  res.json({
    configured: isConfigured(settings),
    enabled: String(settings.telegram_enabled) === 'true',
    events: NOTIFY_EVENTS,
    chosen: [...enabledEvents(settings)],
    defaults: DEFAULT_TEMPLATES,
    placeholders: PLACEHOLDERS,
    templates: (() => {
      try {
        return JSON.parse(settings.telegram_templates || '{}');
      } catch {
        // Unreadable is the same as unset for the screen's purposes; the
        // boxes fill with the defaults and saving fixes it.
        return {};
      }
    })(),
    failures: Number(settings.telegram_failures || 0),
    lastError: settings.telegram_last_error || null,
    lastSend: lastSend(),
  });
});

export default router;

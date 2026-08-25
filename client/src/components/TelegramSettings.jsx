import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RotateCcw, Send } from 'lucide-react';
import api from '../api';
import { Button, Card, Input, LoadError, Skeleton, cx, useToast } from './ui';

/**
 * Telling the owner what just happened, on their phone.
 *
 * A shop owner is not standing at the till. They are at a supplier, at home, at
 * the other branch — and what they want from a POS while they are anywhere else
 * is to know it is still ringing up sales, and to hear within seconds when
 * somebody voids one. Tomorrow's report is a different fact.
 *
 * The whole setup is two strings copied out of Telegram, and getting either one
 * wrong produces **silence** rather than an error — which is indistinguishable
 * from a quiet afternoon. That is why this screen leans so hard on the test
 * button and on saying how many messages have failed since the last one that
 * worked: those are the only two ways a shop can tell the difference.
 */

/**
 * The preview, showing the formatting rather than the tags.
 *
 * The server escapes the shop's *data* before it goes into a message, but the
 * *template* is the shop's own text and is not escaped — Telegram renders it,
 * and a shop that wants a figure in bold has to be able to say so. Handing that
 * straight to `dangerouslySetInnerHTML` would let anything typed into the box
 * run on this page.
 *
 * So the whole string is escaped here and then exactly two tags are put back:
 * bold and italic, which are what these templates use. Anything else a shop
 * types shows as the text it is, which is also the more useful answer — a
 * template carrying a tag Telegram will not render should look wrong here too.
 */
function formatted(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/&lt;b&gt;/g, '<strong>')
    .replace(/&lt;\/b&gt;/g, '</strong>')
    .replace(/&lt;i&gt;/g, '<em>')
    .replace(/&lt;\/i&gt;/g, '</em>');
}

export default function TelegramSettings() {
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [chatId, setChatId] = useState('');
  const [botToken, setBotToken] = useState('');
  const [events, setEvents] = useState(new Set());
  /* The shop's own wording, keyed by event. Absent means the built-in one. */
  const [templates, setTemplates] = useState({});
  const [editing, setEditing] = useState('sale');
  const [preview, setPreview] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  /*
   * Held, rather than allowed to leave a skeleton spinning.
   *
   * An unguarded `await` here is a panel that says "loading" for ever when the
   * request fails, and the most likely reason for it to fail is the one this
   * screen exists to be new for: a server that has not been restarted since the
   * files were replaced, which answers 404 for an endpoint the page knows
   * about. Spinning silently is the least useful thing to do about that —
   * `LoadError` says it in words and offers to try again.
   */
  const [failed, setFailed] = useState(null);

  async function load() {
    try {
      const [s, st] = await Promise.all([api.get('/settings'), api.get('/settings/telegram/status')]);
      setFailed(null);
      setSettings(s.data.settings);
      setStatus(st.data);
      setEnabled(String(s.data.settings.telegram_enabled) === 'true');
      setChatId(s.data.settings.telegram_chat_id || '');
      setEvents(new Set(st.data.chosen || []));
      setTemplates(st.data.templates || {});
      // Never sent back — the box stays empty and typing in it replaces it.
      setBotToken('');
    } catch (err) {
      setFailed(err);
    }
  }

  useEffect(() => {
    load();
  }, []);

  /*
   * What this wording would actually say, rendered by the same builders the
   * real messages go through — asked of the server rather than mocked up here,
   * because a preview written separately is a preview that will eventually
   * disagree with what gets sent, and the shop will believe the wrong one.
   *
   * Debounced: this fires on every keystroke otherwise.
   */
  useEffect(() => {
    if (!status) return undefined;
    let live = true;
    const id = setTimeout(() => {
      api
        .post('/settings/telegram/preview', { event: editing, template: templates[editing] ?? '' })
        .then((res) => live && setPreview(res.data.text))
        .catch(() => live && setPreview(''));
    }, 250);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [editing, templates, status]);

  function toggleEvent(key) {
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.put('/settings', {
        telegram_enabled: enabled ? 'true' : 'false',
        telegram_chat_id: chatId.trim(),
        /*
         * Only when something was typed. Sending the empty box back would wipe
         * a token that is working, which is the sort of thing somebody does by
         * opening this screen to change a checkbox.
         */
        ...(botToken.trim() ? { telegram_bot_token: botToken.trim() } : {}),
        telegram_events: [...events].join(','),
        /*
         * Only the ones actually rewritten. Saving every box would freeze the
         * built-in wording of six events a shop never touched, so a later
         * improvement to any of them would never reach this shop.
         */
        telegram_templates: JSON.stringify(
          Object.fromEntries(
            Object.entries(templates).filter(([, text]) => String(text || '').trim()),
          ),
        ),
      });
      await load();
      toast('Notifications saved');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setError('');
    setTesting(true);
    try {
      await api.post('/settings/telegram/test');
      await load();
      toast('Sent — check your phone');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send');
    } finally {
      setTesting(false);
    }
  }

  if (failed) {
    return (
      <Card>
        <LoadError error={failed} what="the notification settings" onRetry={load} />
      </Card>
    );
  }

  if (!settings || !status) {
    return (
      <Card className="p-5">
        <Skeleton className="h-40 w-full" />
      </Card>
    );
  }

  /*
   * A saved token never comes back — `publicSettings` replaces it with a plain
   * `..._set` boolean — so this asks that, not the key, which is always
   * undefined here. Reading the key made the test button disable itself the
   * moment a token was saved, which is exactly when it becomes useful.
   */
  const tokenSaved = Boolean(settings.telegram_bot_token_set);
  const hasToken = tokenSaved || Boolean(botToken.trim());

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start gap-2.5">
        <span className="rounded-lg bg-sky-50 p-1.5 text-sky-600">
          <Send size={16} />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-800">Notifications on your phone</h2>
          <p className="text-xs text-slate-500">
            A Telegram message the moment a sale, a void or a cash movement happens.
          </p>
        </div>
      </div>

      {/*
        * How many messages have failed since one last got through.
        *
        * The single most useful thing on this screen. A shop whose chat id is a
        * digit out gets no messages and no errors, and finds out weeks later by
        * realising it has not heard from the till.
        */}
      {status.failures > 0 && (
        <div className="mb-4 flex gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p>
            <span className="font-medium">
              {status.failures} message{status.failures === 1 ? '' : 's'} did not arrive.
            </span>{' '}
            {status.lastError ? `Telegram said: ${status.lastError}` : ''} Send a test message to
            check the token and the chat id.
          </p>
        </div>
      )}
      {status.failures === 0 && status.configured && enabled && (
        <p className="mb-4 flex items-center gap-1.5 text-sm text-emerald-700">
          <CheckCircle2 size={15} /> Connected, and everything has been getting through.
        </p>
      )}

      <form onSubmit={save} className="space-y-4">
        <label className="flex items-start gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
          <input
            type="checkbox"
            name="telegram_enabled"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand-600"
          />
          <span>
            <span className="block text-sm font-medium text-slate-800">Send me a message</span>
            <span className="block text-xs text-slate-500">
              Nothing is sent until this is on and both boxes below are filled in.
            </span>
          </span>
        </label>

        <Input
          label="Bot token"
          name="telegram_bot_token"
          type="password"
          autoComplete="off"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          placeholder={tokenSaved ? '•••••••• — saved' : '123456789:AA…'}
          hint={
            tokenSaved
              ? 'Already saved. Leave empty to keep it, or paste a new one to replace it.'
              : 'Open Telegram, message @BotFather, send /newbot, and paste what it gives you.'
          }
        />

        <Input
          label="Chat id"
          name="telegram_chat_id"
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          placeholder="123456789"
          hint="Message @userinfobot on Telegram and it replies with yours. A group's id starts with a minus."
        />

        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700">What to tell me about</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {Object.entries(status.events).map(([key, label]) => (
              <label
                key={key}
                className={cx(
                  'flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm ring-1 transition',
                  events.has(key)
                    ? 'bg-brand-50 text-brand-900 ring-brand-200'
                    : 'bg-white text-slate-600 ring-slate-200',
                )}
              >
                <input
                  type="checkbox"
                  checked={events.has(key)}
                  onChange={() => toggleEvent(key)}
                  className="h-4 w-4 rounded border-slate-300 accent-brand-600"
                />
                {label}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            None ticked means all of them — a shop switching this on wants to see that it works.
          </p>
        </div>

        {/*
          * The wording itself.
          *
          * One event at a time rather than seven boxes stacked: a shop rewrites
          * the sale message and leaves the rest alone, and seven textareas is a
          * screen nobody reads to the bottom of.
          */}
        <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
          <p className="mb-2 text-sm font-medium text-slate-700">What the message says</p>

          <div className="mb-2.5 flex flex-wrap gap-1">
            {Object.entries(status.events).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setEditing(key)}
                className={cx(
                  'rounded-lg px-2 py-1 text-xs font-medium transition',
                  editing === key
                    ? 'bg-slate-800 text-white'
                    : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:text-slate-900',
                  // A rewritten one is marked, so a shop can see at a glance
                  // which of the seven it has already been through.
                  editing !== key && templates[key]?.trim() ? 'ring-brand-300' : '',
                )}
              >
                {label}
                {templates[key]?.trim() ? ' ·' : ''}
              </button>
            ))}
          </div>

          <textarea
            name={`template_${editing}`}
            rows={5}
            value={templates[editing] ?? status.defaults[editing] ?? ''}
            onChange={(e) => setTemplates((t) => ({ ...t, [editing]: e.target.value }))}
            spellCheck={false}
            className="w-full rounded-lg bg-white px-3 py-2 font-mono text-xs leading-relaxed ring-1 ring-edge transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
          />

          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="text-xs text-slate-500">Tap to insert:</span>
            {Object.entries(status.placeholders[editing] || {}).map(([key, meaning]) => (
              <button
                key={key}
                type="button"
                title={meaning}
                onClick={() =>
                  setTemplates((t) => ({
                    ...t,
                    [editing]: `${t[editing] ?? status.defaults[editing] ?? ''}{${key}}`,
                  }))
                }
                className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-brand-700 ring-1 ring-slate-200 transition hover:bg-brand-50"
              >
                {`{${key}}`}
              </button>
            ))}
          </div>

          {/* Rendered by the server, from the same code the real message uses. */}
          {preview && (
            <div className="mt-2.5">
              <p className="mb-1 text-xs text-slate-500">On your phone it reads:</p>
              <p
                className="rounded-lg bg-white px-3 py-2 text-sm whitespace-pre-wrap text-slate-800 ring-1 ring-slate-200"
                // Escaped, then bold and italic put back — see `formatted`.
                dangerouslySetInnerHTML={{ __html: formatted(preview) }}
              />
            </div>
          )}

          <button
            type="button"
            onClick={() => setTemplates((t) => ({ ...t, [editing]: '' }))}
            className="mt-2 flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-800"
          >
            <RotateCcw size={12} /> Put the built-in wording back
          </button>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2">
          <Button type="submit" loading={saving}>
            Save
          </Button>
          {/* The only way to tell "set up correctly and quiet" from "typed the
              chat id wrong last week". */}
          <Button
            type="button"
            variant="secondary"
            onClick={test}
            loading={testing}
            disabled={!hasToken || !chatId.trim()}
            title={!hasToken || !chatId.trim() ? 'Fill in the token and the chat id first' : undefined}
          >
            <Send size={15} /> Send a test message
          </Button>
        </div>
      </form>
    </Card>
  );
}

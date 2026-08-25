import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Send } from 'lucide-react';
import api from '../api';
import { Button, Card, Input, Skeleton, cx, useToast } from './ui';

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
export default function TelegramSettings() {
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [chatId, setChatId] = useState('');
  const [botToken, setBotToken] = useState('');
  const [events, setEvents] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    const [s, st] = await Promise.all([api.get('/settings'), api.get('/settings/telegram/status')]);
    setSettings(s.data.settings);
    setStatus(st.data);
    setEnabled(String(s.data.settings.telegram_enabled) === 'true');
    setChatId(s.data.settings.telegram_chat_id || '');
    setEvents(new Set(st.data.chosen || []));
    // Never sent back — the box stays empty and typing in it replaces it.
    setBotToken('');
  }

  useEffect(() => {
    load();
  }, []);

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

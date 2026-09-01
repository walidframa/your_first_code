import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, History, MonitorCheck, MonitorDown, Save } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import CompanySettings from '../../components/CompanySettings';
import Backups from '../../components/Backups';
import TaxSettings from '../../components/TaxSettings';
import TelegramSettings from '../../components/TelegramSettings';
import PhotoSourceSettings from '../../components/PhotoSourceSettings';
import SupportVisits from '../../components/SupportVisits';
import { useSettings, lbp } from '../../context/SettingsContext';
import { TEXT_SIZES, applyTextSize, getTextSize } from '../../lib/textSize';
import { THEMES, applyTheme, getTheme } from '../../lib/theme';
import { useLanguage } from '../../context/LanguageContext';
import { install, isInstalled, onInstallable } from '../../lib/install';
import ChangePassword from '../ChangePassword';
import { when } from '../../lib/when';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Input,
  Skeleton,
  cx,
  money,
  useToast,
} from '../../components/ui';

const PREVIEW_AMOUNTS = [1, 5, 10, 25, 100];

/**
 * How big everything is, on this screen.
 *
 * Kept on the device rather than in the shop's settings: the till is a tablet
 * propped up at arm's length and the back office is a laptop a foot away, and
 * the right answer is different for each. Nothing to save — it takes effect on
 * the press, which is also the only way to judge whether it is right.
 */
function TextSize() {
  const [size, setSize] = useState(getTextSize);

  /**
   * Kept on the device *and* against the account.
   *
   * The device copy is what makes the size right before the first paint. The
   * account copy is what makes it right on a machine this person has never sat
   * at — a shopkeeper uses the counter tablet, the office laptop and their
   * phone, and setting this again on each one is how somebody stops bothering.
   *
   * Saved on the press, with no Save button: there is nothing to review, the
   * result is already on screen, and a preference behind a button is a
   * preference half the shop leaves unsaved.
   */
  function choose(id) {
    setSize(applyTextSize(id));
    // A display preference is not worth a red message if it does not reach the
    // server — this device is already showing the right thing.
    api.put('/auth/text-size', { textSize: id }).catch(() => {});
  }

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-slate-900">Text size</h2>
      <p className="mt-0.5 mb-4 text-xs text-slate-500">
        Applies to this screen only, and is remembered on it. Everything grows together — the
        numbers, the buttons and the space around them — so nothing ends up in the wrong place.
      </p>

      <div className="flex gap-2">
        {TEXT_SIZES.map(([id, label]) => (
          <button
            key={id}
            onClick={() => choose(id)}
            aria-pressed={size === id}
            className={cx(
              'flex-1 rounded-xl px-3 py-2.5 text-sm font-medium ring-1 transition',
              size === id
                ? 'bg-brand-600 text-white ring-brand-600'
                : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50',
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </Card>
  );
}

/**
 * Light or dark.
 *
 * Beside the text size because it is the same kind of decision — how this
 * screen, in this room, should look — and saved the same way: on the press,
 * on the device, and against the account so the next machine agrees.
 */
function Theme() {
  const [theme, setTheme] = useState(getTheme);

  function choose(id) {
    setTheme(applyTheme(id));
    api.put('/auth/theme', { theme: id }).catch(() => {});
  }

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-slate-900">Theme</h2>
      <p className="mt-0.5 mb-4 text-xs text-slate-500">
        Dark suits a counter under shop lights in the evening; light suits a desk by a window.
        Match device follows whatever this machine already does, including when it changes itself
        at sunset. Receipts, labels and invoices print on white paper either way.
      </p>

      <div className="flex gap-2">
        {THEMES.map(([id, label]) => (
          <button
            key={id}
            onClick={() => choose(id)}
            aria-pressed={theme === id}
            className={cx(
              'flex-1 rounded-xl px-3 py-2.5 text-sm font-medium ring-1 transition',
              theme === id
                ? 'bg-brand-600 text-white ring-brand-600'
                : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50',
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </Card>
  );
}

/**
 * Putting the till on the desktop.
 *
 * Three states worth telling apart, because the honest answer differs: it is
 * already installed and there is nothing to do; the browser is offering, and
 * one press is the whole job; or the browser has no offer to make, in which
 * case the menu item is named rather than pretended away — a button that does
 * nothing is worse than a sentence saying where to look.
 */
function InstallApp() {
  const [offered, setOffered] = useState(false);
  const [installed, setInstalled] = useState(isInstalled);

  useEffect(() => onInstallable(setOffered), []);

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-slate-900">On this computer</h2>
      <p className="mt-0.5 mb-4 text-xs text-slate-500">
        Installing puts Front Desk in the Start menu with an icon of its own and opens it in its own
        window — no address bar, and nothing for a cashier to click out of. It stays the same app, so
        there is no download to repeat: an update is live the next time it is opened.
      </p>

      {installed ? (
        <p className="flex items-center gap-2 rounded-xl bg-brand-50 px-3 py-2.5 text-sm text-brand-800">
          <MonitorCheck size={16} className="shrink-0" /> Installed — this is the app, not a tab.
        </p>
      ) : offered ? (
        <Button
          onClick={async () => {
            if (await install()) setInstalled(true);
          }}
        >
          <MonitorDown size={16} /> Install Front Desk
        </Button>
      ) : (
        <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
          Your browser has not offered yet. In Chrome or Edge it is the install icon at the right of
          the address bar, or <strong>⋮ → Cast, save and share → Install</strong>. On an iPad it is{' '}
          <strong>Share → Add to Home Screen</strong>. Installing needs the app to be on{' '}
          <strong>https://</strong> or on this same computer — a plain{' '}
          <code className="rounded bg-slate-200 px-1">http://</code> address over the network cannot
          be installed.
        </p>
      )}
    </Card>
  );
}

/**
 * Which language, for anybody already signed in.
 *
 * The switch that matters is the one on the sign-in screen, since somebody who
 * needs Arabic cannot read the screen asking them to choose. This one is for
 * changing your mind afterwards without signing out to do it.
 */
function LanguageChoice() {
  const { language, choose, languages, t } = useLanguage();

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-slate-900">{t('Language')}</h2>
      <p className="mt-0.5 mb-4 text-xs text-slate-500">
        {t(
          'Applies to this device and is remembered on it, so the counter and the back office can differ.',
        )}
      </p>

      <div className="flex gap-2">
        {languages.map(([id, label]) => (
          <button
            key={id}
            onClick={() => choose(id)}
            lang={id}
            aria-pressed={language === id}
            className={cx(
              'flex-1 rounded-xl px-3 py-2.5 text-sm font-medium ring-1 transition',
              language === id
                ? 'bg-brand-600 text-white ring-brand-600'
                : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50',
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </Card>
  );
}

export default function Settings() {
  const toast = useToast();
  const { settings, refresh } = useSettings();

  const [rate, setRate] = useState('');
  const [step, setStep] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState(null);

  const loadHistory = useCallback(() => {
    api.get('/settings/rate-history').then((res) => setHistory(res.data.history));
  }, []);

  useEffect(() => {
    if (settings) {
      setRate(String(settings.exchange_rate));
      setStep(String(settings.lbp_rounding));
    }
  }, [settings]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const rateNum = Number(rate);
  const stepNum = Number(step);
  const valid = Number.isFinite(rateNum) && rateNum > 0 && Number.isFinite(stepNum) && stepNum >= 1;
  const dirty =
    settings && (rateNum !== settings.exchange_rate || stepNum !== settings.lbp_rounding);

  const preview = (usd) => {
    if (!valid) return 0;
    const raw = usd * rateNum;
    return stepNum > 1 ? Math.round(raw / stepNum) * stepNum : Math.round(raw);
  };

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.put('/settings', { exchange_rate: rateNum, lbp_rounding: stepNum });
      await refresh();
      loadHistory();
      toast('Exchange rate updated');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Settings"
        subtitle="Your company, the exchange rate, and how currency is shown"
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {/* Who the shop is comes first: it is on every piece of paper that
            leaves the counter, and it is set once and then forgotten. */}
        <div className="mb-4 max-w-4xl">
          <CompanySettings />
        </div>

        <div className="mb-4 grid max-w-4xl grid-cols-2 gap-4">
          <LanguageChoice />
          <Theme />
          <TextSize />
        </div>

        {/* Where the owner finds out what the till is doing while they are
            somewhere else. Above the machine-shaped settings below it, because
            it is the one on this page somebody comes here on purpose to set. */}
        <div className="mb-4 max-w-4xl">
          <TelegramSettings />
        </div>

        {/* Almost nobody opens this — the free libraries work with nothing set
            up. It is here for the shop whose stock they have nothing for. */}
        <div className="mb-4 max-w-4xl">
          <PhotoSourceSettings />
        </div>

        <div className="mb-4 grid max-w-4xl grid-cols-2 gap-4">
          <InstallApp />
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-slate-900">Your password</h2>
            <p className="mt-0.5 mb-4 text-xs text-slate-500">
              Changing it signs out every other device this account is open on — which is the point
              of changing it. This screen stays signed in.
            </p>
            <ChangePassword />
          </Card>
        </div>

        {/* Boring until the day it is the only thing that matters. */}
        <div className="mb-4 max-w-4xl">
          <Backups />
        </div>

        {/* Set once and then forgotten — but wrong by default until it is. */}
        <div className="mb-4 max-w-4xl">
          <TaxSettings />
        </div>

        {/* Nothing at all until somebody from outside the shop has been in it. */}
        <div className="mb-4 max-w-4xl">
          <SupportVisits />
        </div>

        <div className="grid max-w-4xl grid-cols-2 gap-4">
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-slate-900">Exchange rate</h2>
            <p className="mt-0.5 mb-4 text-xs text-slate-500">
              Products are priced in US dollars. Lebanese pounds are calculated from this rate
              everywhere in the app, so this is the only number to update.
            </p>

            {!settings ? (
              <Skeleton className="h-40" />
            ) : (
              <form onSubmit={save} className="space-y-4">
                <Input
                  label="Lebanese pounds per 1 US dollar"
                  type="number"
                  min="1"
                  step="any"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  hint="Ask around for the day's rate and set it here each morning."
                  required
                />
                <Input
                  label="Round pound amounts to the nearest"
                  type="number"
                  min="1"
                  step="1"
                  value={step}
                  onChange={(e) => setStep(e.target.value)}
                  hint="1,000 is typical — quoting to the single pound is meaningless."
                  required
                />

                {error && <p className="text-sm text-red-600">{error}</p>}

                <Button type="submit" loading={saving} disabled={!valid || !dirty}>
                  <Save size={15} /> {dirty ? 'Save changes' : 'Saved'}
                </Button>
              </form>
            )}
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader title="Preview" subtitle="What cashiers and customers will see" />
              <ul className="space-y-1.5 px-5 pb-5 text-sm">
                {PREVIEW_AMOUNTS.map((usd) => (
                  <li key={usd} className="flex items-center justify-between">
                    <span className="tnum text-slate-600">{money(usd)}</span>
                    <ArrowRight size={13} className="text-slate-300" />
                    <span className="tnum w-40 text-right font-medium text-slate-800">
                      {lbp(preview(usd))}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <CardHeader title="Rate history" subtitle="Every change, and who made it" />
              {!history ? (
                <div className="px-5 pb-5">
                  <Skeleton className="h-20" />
                </div>
              ) : history.length === 0 ? (
                <EmptyState
                  icon={History}
                  title="No changes yet"
                  description="Rate updates will be listed here."
                />
              ) : (
                <ul className="max-h-56 space-y-1.5 overflow-y-auto px-5 pb-5 text-sm">
                  {history.map((h) => (
                    <li key={h.id} className="flex items-baseline justify-between gap-3">
                      <span className="tnum font-medium text-slate-800">
                        {Number(h.rate).toLocaleString('en-US')}
                      </span>
                      <span className="truncate text-xs text-slate-400">
                        {when(h.created_at)} · {h.user_name || 'System'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

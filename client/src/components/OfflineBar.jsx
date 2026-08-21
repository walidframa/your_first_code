import { ArrowUpCircle, CalendarClock, CloudOff, LifeBuoy, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useOffline } from '../context/OfflineContext';
import { useLicence } from '../context/LicenceContext';
import { useSupport } from '../context/SupportContext';
import { useAuth } from '../context/AuthContext';
import { Button, cx, money } from './ui';
import { useT } from '../context/LanguageContext';
import { applyUpdate, onUpdateReady } from '../lib/appUpdate';

/**
 * What the counter needs to know when the server is away.
 *
 * Two things, and only when they are true: that the shop is selling on its own
 * for the moment, and that nothing has been lost. A cashier who cannot tell the
 * difference between "waiting" and "gone" will stop trusting the till, and a
 * till nobody trusts gets a paper notebook beside it.
 *
 * A refused sale is louder than either, because it is the one that needs a
 * person: the money was taken and the books will not have it until somebody
 * decides what to do.
 */
/**
 * How long this shop has left on its licence.
 *
 * Two weeks of quiet notice, then a louder one naming the day the till stops.
 * A shopkeeper should never learn about this from a customer standing at the
 * counter, which is what happens when the only warning is the lock itself.
 *
 * The overdue bar is not dismissible on purpose: it is the last thing between
 * the shop and a stopped till, and somebody who closes it will not think about
 * it again until the morning it matters.
 */
function LicenceBar() {
  const { licence } = useLicence();
  if (!licence || (licence.state !== 'due' && licence.state !== 'overdue')) return null;

  const overdue = licence.state === 'overdue';

  return (
    <div
      className={cx(
        'flex items-center gap-2 px-4 py-1.5 text-sm font-medium text-white',
        overdue ? 'bg-red-600' : 'bg-slate-700',
      )}
    >
      <CalendarClock size={15} className="shrink-0" />
      <span>{licence.message}</span>
      {overdue && (
        <span className="ml-auto shrink-0 text-xs opacity-90">
          {licence.graceLeft} day{licence.graceLeft === 1 ? '' : 's'} left
        </span>
      )}
    </div>
  );
}

/**
 * Somebody who is not the shop is in the shop.
 *
 * Named, with their reason, and not dismissible. This is the whole bargain the
 * support visit is built on: the vendor can come in without asking, and in
 * exchange the shop is never in the dark about it. A bar that could be closed
 * would be closed once and never thought about again, which turns "you can see
 * me" into "you could have seen me".
 *
 * Purple rather than red. It is not a fault, and a shop that learns to read
 * every coloured bar as something broken stops reading the red one.
 */
function SupportBar() {
  const { support } = useSupport();
  const { user } = useAuth();
  const t = useT();
  if (!support?.active) return null;

  const mine = Boolean(user?.support);

  return (
    <div className="flex items-start gap-2 bg-violet-700 px-4 py-1.5 text-sm font-medium text-white">
      <LifeBuoy size={15} className="mt-0.5 shrink-0" />
      <span>
        {mine
          ? t('You are in this shop as support. They can see you, and every change is logged.')
          : t('{name} from support is in your shop right now.', { name: support.operator })}
        {support.reason && <span className="font-normal opacity-90"> — {support.reason}</span>}
      </span>
    </div>
  );
}

/** How many sales are waiting, and — if it is worth saying — how much money. */
function waiting(t, count, total) {
  if (total > 0) {
    return count === 1
      ? t('One sale waiting ({amount}), and nothing is lost.', { amount: money(total) })
      : t('{count} sales waiting ({amount}), and nothing is lost.', {
          count,
          amount: money(total),
        });
  }
  return count === 1
    ? t('One sale waiting, and nothing is lost.')
    : t('{count} sales waiting, and nothing is lost.', { count });
}

/**
 * A new version of the app is waiting.
 *
 * Offered rather than taken: the reload is a button, because a page that
 * reloads itself because a deploy happened can throw away a half-rung sale,
 * and no amount of freshness is worth that. Between customers is the right
 * moment and only the person at the counter knows when that is.
 *
 * Dismissible, and it comes back on the next load if it is still waiting —
 * a shop in the middle of something should be able to make it go away without
 * that meaning "never tell me again".
 */
function UpdateBar() {
  const t = useT();
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => onUpdateReady(setReady), []);

  if (!ready || dismissed) return null;

  return (
    <div className="flex items-center gap-2 bg-brand-700 px-4 py-1.5 text-sm font-medium text-white">
      <ArrowUpCircle size={15} className="shrink-0" />
      <span>{t('A new version of the app is ready.')}</span>
      <button
        onClick={applyUpdate}
        className="ms-auto shrink-0 rounded-md bg-white/15 px-2 py-0.5 text-xs transition hover:bg-white/25"
      >
        {t('Reload now')}
      </button>
      <button
        onClick={() => setDismissed(true)}
        aria-label={t('Not now')}
        title={t('Not now')}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-xs opacity-80 transition hover:bg-white/15 hover:opacity-100"
      >
        {t('Later')}
      </button>
    </div>
  );
}

export default function OfflineBar() {
  const { reachable, sending, pending, refused, send } = useOffline();
  const t = useT();

  // The licence and support bars have their own reasons to appear, so this one
  // no longer gets to decide there is nothing to show.
  if (reachable && pending.length === 0 && refused.length === 0) {
    return (
      <>
        <SupportBar />
        <LicenceBar />
        <UpdateBar />
      </>
    );
  }

  const total = pending.reduce((sum, s) => sum + (s.total || 0), 0);

  return (
    <div className="no-print">
      <SupportBar />
      <LicenceBar />
      <UpdateBar />

      {!reachable && (
        <div className="flex items-center gap-2 bg-amber-500 px-4 py-1.5 text-sm font-medium text-white">
          <CloudOff size={15} className="shrink-0" />
          <span>
            {t('Selling on its own — the server is not answering.')}
            {pending.length > 0 && ` ${waiting(t, pending.length, total)}`}
          </span>
        </div>
      )}

      {reachable && pending.length > 0 && (
        <div className="flex items-center gap-2 bg-slate-800 px-4 py-1.5 text-sm text-white">
          <RefreshCw size={15} className={cx('shrink-0', sending && 'animate-spin')} />
          <span>
            {pending.length === 1
              ? t('Catching up — one sale to send.')
              : t('Catching up — {count} sales to send.', { count: pending.length })}
          </span>
          {!sending && (
            <Button size="sm" variant="secondary" className="ml-auto" onClick={send}>
              {t('Send now')}
            </Button>
          )}
        </div>
      )}

      {refused.length > 0 && (
        <div className="flex items-start gap-2 bg-red-600 px-4 py-1.5 text-sm text-white">
          <TriangleAlert size={15} className="mt-0.5 shrink-0" />
          <span>
            <strong>
              {refused.length === 1
                ? t('One sale the server would not take')
                : t('{count} sales the server would not take', { count: refused.length })}
            </strong>{' '}
            — {refused[0].refused}
            {refused.length > 1 && t(', among others')}.{' '}
            {t('The money was taken, so these need somebody to look at them.')}
          </span>
        </div>
      )}
    </div>
  );
}

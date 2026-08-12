import { CalendarClock, CloudOff, RefreshCw, TriangleAlert } from 'lucide-react';
import { useOffline } from '../context/OfflineContext';
import { useLicence } from '../context/LicenceContext';
import { Button, cx, money } from './ui';
import { useT } from '../context/LanguageContext';

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

export default function OfflineBar() {
  const { reachable, sending, pending, refused, send } = useOffline();
  const t = useT();

  // The licence bar has its own reasons to appear, so this one no longer gets
  // to decide there is nothing to show.
  if (reachable && pending.length === 0 && refused.length === 0) return <LicenceBar />;

  const total = pending.reduce((sum, s) => sum + (s.total || 0), 0);

  return (
    <div className="no-print">
      <LicenceBar />

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

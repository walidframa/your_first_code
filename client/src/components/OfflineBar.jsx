import { CloudOff, RefreshCw, TriangleAlert } from 'lucide-react';
import { useOffline } from '../context/OfflineContext';
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

  if (reachable && pending.length === 0 && refused.length === 0) return null;

  const total = pending.reduce((sum, s) => sum + (s.total || 0), 0);

  return (
    <div className="no-print">
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

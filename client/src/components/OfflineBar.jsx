import { CloudOff, RefreshCw, TriangleAlert } from 'lucide-react';
import { useOffline } from '../context/OfflineContext';
import { Button, cx, money } from './ui';

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
export default function OfflineBar() {
  const { reachable, sending, pending, refused, send } = useOffline();

  if (reachable && pending.length === 0 && refused.length === 0) return null;

  const total = pending.reduce((sum, s) => sum + (s.total || 0), 0);

  return (
    <div className="no-print">
      {!reachable && (
        <div className="flex items-center gap-2 bg-amber-500 px-4 py-1.5 text-sm font-medium text-white">
          <CloudOff size={15} className="shrink-0" />
          <span>
            Selling on its own — the server is not answering.
            {pending.length > 0 && (
              <>
                {' '}
                <strong>
                  {pending.length} sale{pending.length === 1 ? '' : 's'}
                </strong>{' '}
                waiting{total > 0 && <> ({money(total)})</>}, and nothing is lost.
              </>
            )}
          </span>
        </div>
      )}

      {reachable && pending.length > 0 && (
        <div className="flex items-center gap-2 bg-slate-800 px-4 py-1.5 text-sm text-white">
          <RefreshCw size={15} className={cx('shrink-0', sending && 'animate-spin')} />
          <span>
            Catching up — {pending.length} sale{pending.length === 1 ? '' : 's'} to send.
          </span>
          {!sending && (
            <Button size="sm" variant="secondary" className="ml-auto" onClick={send}>
              Send now
            </Button>
          )}
        </div>
      )}

      {refused.length > 0 && (
        <div className="flex items-start gap-2 bg-red-600 px-4 py-1.5 text-sm text-white">
          <TriangleAlert size={15} className="mt-0.5 shrink-0" />
          <span>
            <strong>
              {refused.length} sale{refused.length === 1 ? '' : 's'} the server would not take
            </strong>{' '}
            — {refused[0].refused}
            {refused.length > 1 && ', among others'}. The money was taken, so these need somebody to
            look at them.
          </span>
        </div>
      )}
    </div>
  );
}

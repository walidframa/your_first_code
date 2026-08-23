import { useCallback, useEffect, useState } from 'react';
import { Banknote } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import CashReport from '../../components/CashReport';
import HistoryFilter from '../../components/HistoryFilter';
import { useHistoryFilter } from '../../lib/history';
import { lbp } from '../../context/SettingsContext';
import { Badge, Card, EmptyState, LoadError, Skeleton, cx, money } from '../../components/ui';
import { when, atTime } from '../../lib/when';

/** Over/short in the currency it happened in — never the two added together. */
function Difference({ usd, lbpAmount }) {
  if (usd === null || usd === undefined) return <span className="text-slate-400">—</span>;
  const exact = usd === 0 && lbpAmount === 0;
  if (exact) return <Badge tone="good">exact</Badge>;

  const parts = [];
  if (usd !== 0) parts.push(`${usd > 0 ? '+' : ''}${money(usd)}`);
  if (lbpAmount !== 0) parts.push(`${lbpAmount > 0 ? '+' : ''}${lbp(lbpAmount)}`);
  const short = usd < 0 || lbpAmount < 0;

  return <Badge tone={short ? 'critical' : 'warning'}>{parts.join(' · ')}</Badge>;
}

export default function CashSessions() {
  const [sessions, setSessions] = useState(null);
  const [current, setCurrent] = useState(null);
  const [failed, setFailed] = useState(null);
  const [viewing, setViewing] = useState(null);
  /*
   * A sitting from last month is what somebody reaches for when a count is
   * being argued about, and until now the list stopped wherever it stopped.
   */
  const history = useHistoryFilter('month');

  /*
   * Both refusals are caught. Without this the list stayed on its skeleton for
   * ever when the request failed, saying "loading" about something that had
   * already finished going wrong.
   *
   * The sitting in progress is the softer of the two: not knowing it leaves one
   * panel out, so it is allowed to fail quietly. The list is the screen.
   */
  const load = useCallback(() => {
    setFailed(null);
    api
      .get('/cash/sessions')
      .then((res) => setSessions(res.data.sessions))
      .catch((err) => setFailed(err));
    api
      .get('/cash/current')
      .then((res) => setCurrent(res.data))
      .catch(() => setCurrent(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const shown = (sessions || []).filter(
    (s) => history.within(s.opened_at) && history.matches(s.opened_by_name, s.account_name, s.closed_by_name),
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Cashbox" subtitle="Every sitting of the till, and how it counted" />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {/*
         * Cash on hand first, because it is the question this page is opened to
         * answer. Everything below is history.
         */}
        <Card className={cx('mb-4 px-5 py-4', current?.session ? 'ring-brand-200' : '')}>
          {current?.session ? (
            <>
              <div className="flex items-baseline justify-between gap-4">
                <div>
                  <p className="text-xs text-slate-500">Cash on hand</p>
                  <p className="mt-1 flex items-baseline gap-3">
                    <span className="tnum text-3xl font-semibold text-slate-900">
                      {money(current.expected?.usd ?? 0)}
                    </span>
                    <span className="tnum text-xl font-medium text-slate-500">
                      {lbp(current.expected?.lbp ?? 0)}
                    </span>
                  </p>
                </div>
                <div className="text-right">
                  <Badge tone="good">cashbox open</Badge>
                  <p className="mt-1 text-xs text-slate-400">
                    since {when(current.session.opened_at)} ·{' '}
                    {current.session.opened_by_name}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-slate-100 pt-3 text-sm">
                <span className="text-slate-500">
                  Opened with{' '}
                  <span className="tnum text-slate-800">
                    {money(current.session.opening_usd)} · {lbp(current.session.opening_lbp)}
                  </span>
                </span>
                <span className="text-slate-500">
                  <span className="tnum text-slate-800">{current.movementCount}</span> movement
                  {current.movementCount === 1 ? '' : 's'} since
                </span>
              </div>

              {/*
                * What the shop has made since the drawer was opened — takings
                * less what the goods cost less what was spent. Only present for
                * whoever may see profit at all; the server leaves it out
                * entirely for everyone else.
                */}
              {current.profit && (
                <div className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-4">
                  {[
                    ['Sold', current.profit.revenue, 'text-slate-800'],
                    ['Cost of goods', -current.profit.cost, 'text-slate-500'],
                    ['Gross profit', current.profit.grossProfit, 'text-slate-800'],
                    [
                      'Net profit',
                      current.profit.netProfit,
                      current.profit.netProfit < 0 ? 'text-red-600' : 'text-brand-700',
                    ],
                  ].map(([label, value, colour]) => (
                    <div key={label}>
                      <p className="text-[11px] tracking-wide text-slate-500 uppercase">{label}</p>
                      <p className={cx('tnum text-lg font-semibold', colour)}>{money(value)}</p>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs text-slate-500">Cash on hand</p>
                <p className="mt-1 text-3xl font-semibold text-slate-400">—</p>
              </div>
              <div className="text-right">
                <Badge tone="neutral">cashbox closed</Badge>
                <p className="mt-1 text-xs text-slate-400">Open it from the register to start a sitting.</p>
              </div>
            </div>
          )}
        </Card>

        <HistoryFilter
          filter={history}
          label="Search cashboxes"
          placeholder="Search who opened it, or the till…"
        />

        <Card>
          {failed ? (
            <LoadError error={failed} onRetry={load} what="the till sittings" />
          ) : !sessions ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <EmptyState
              icon={Banknote}
              title="The cashbox has never been opened"
              description="Open it from the register to start tracking the drawer."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Opened</th>
                  <th className="px-3 py-2.5 font-medium">By</th>
                  <th className="px-3 py-2.5 font-medium">Closed</th>
                  <th className="px-3 py-2.5 text-right font-medium">Counted</th>
                  <th className="px-5 py-2.5 text-right font-medium">Difference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {shown.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => setViewing(s.id)}
                    className="cursor-pointer hover:bg-slate-50/60"
                  >
                    <td className="px-5 py-2.5 font-medium text-slate-800">
                      {when(s.opened_at)}
                    </td>
                    <td className="px-3 py-2.5 text-slate-500">{s.opened_by_name}</td>
                    <td className="px-3 py-2.5 text-slate-500">
                      {s.closed_at ? (
                        atTime(s.closed_at)
                      ) : (
                        <Badge tone="good">open now</Badge>
                      )}
                    </td>
                    <td className="tnum px-3 py-2.5 text-right text-slate-700">
                      {s.counted_usd === null ? (
                        '—'
                      ) : (
                        <>
                          {money(s.counted_usd)}
                          <span className="block text-xs text-slate-400">{lbp(s.counted_lbp)}</span>
                        </>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <Difference usd={s.over_short_usd} lbpAmount={s.over_short_lbp} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {viewing && <CashReport sessionId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

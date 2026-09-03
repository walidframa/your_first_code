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
  /*
   * The dates go to the server rather than being sifted here.
   *
   * Two reasons, and the shop hit both. A list capped at the most recent fifty
   * sittings, filtered afterwards in the browser, silently shows nothing for a
   * month that is fifty sittings ago. And "in this period" for a sitting means
   * *open during it*, not opened inside it — a drawer opened on Friday and
   * closed on Sunday belongs to Saturday as well, which the server now works
   * out; see listSessions.
   */
  const { from, to } = history.range;

  const load = useCallback(() => {
    setFailed(null);
    api
      .get('/cash/sessions', {
        params: {
          from: from || undefined,
          to: to || undefined,
          limit: 500,
          /* What each sitting made. The server leaves it out for anyone
             without the permission, so asking for it is harmless. */
          withProfit: true,
        },
      })
      .then((res) => setSessions(res.data.sessions))
      .catch((err) => setFailed(err));
    api
      .get('/cash/current')
      .then((res) => setCurrent(res.data))
      .catch(() => setCurrent(null));
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  /* The dates were applied by the server — see load. The typed search is the
     only thing left to sift here. */
  const shown = (sessions || []).filter((s) =>
    history.matches(s.opened_by_name, s.account_name, s.closed_by_name),
  );

  /* What the sittings on screen made between them, which is the question this
     screen is opened with: "how did the cashbox do over these days?" */
  const totals = shown.reduce(
    (sum, s) => ({
      sittings: sum.sittings + 1,
      revenue: sum.revenue + (s.profit?.revenue ?? 0),
      grossProfit: sum.grossProfit + (s.profit?.grossProfit ?? 0),
      netProfit: sum.netProfit + (s.profit?.netProfit ?? 0),
    }),
    { sittings: 0, revenue: 0, grossProfit: 0, netProfit: 0 },
  );
  const showsProfit = shown.some((s) => s.profit);

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

        {/*
          * What these sittings made between them.
          *
          * The screen's own question, asked from the counter: "how did the
          * cashbox do over these days?" Each sitting's figure runs from when
          * that drawer was opened to when it was closed — however many days
          * that turns out to be — so this adds up whole sittings rather than
          * slicing them at midnight.
          */}
        {showsProfit && (
          <Card className="mb-4 px-5 py-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                [
                  'sittings',
                  totals.sittings === 1 ? 'Sitting' : 'Sittings',
                  String(totals.sittings),
                  'text-slate-800',
                ],
                ['sold', 'Sold', money(totals.revenue), 'text-slate-800'],
                ['gross', 'Gross profit', money(totals.grossProfit), 'text-slate-800'],
                [
                  'net',
                  'Net profit',
                  money(totals.netProfit),
                  totals.netProfit < 0 ? 'text-red-600' : 'text-brand-700',
                ],
              ].map(([key, label, value, colour]) => (
                <div key={key}>
                  <p className="text-[11px] tracking-wide text-slate-500 uppercase">{label}</p>
                  {/* Named, so the end-to-end suite can check the column adds
                     up to it without guessing at the layout around it. */}
                  <p data-cashbox-total={key} className={cx('tnum text-lg font-semibold', colour)}>
                    {value}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Each sitting counted from the moment its drawer was opened to the moment it was
              closed, whether that was an hour or three days. Expenses recorded during the sitting
              are already off the net figure.
            </p>
          </Card>
        )}

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
                  {showsProfit && (
                    <th className="px-3 py-2.5 text-right font-medium">Profit</th>
                  )}
                  <th className="px-5 py-2.5 text-right font-medium">Difference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
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
                    {showsProfit && (
                      <td className="tnum px-3 py-2.5 text-right">
                        {s.profit ? (
                          <>
                            <span
                              className={cx(
                                'font-semibold',
                                s.profit.netProfit < 0 ? 'text-red-600' : 'text-brand-700',
                              )}
                            >
                              {money(s.profit.netProfit)}
                            </span>
                            {/* What it is made of, small: sold, and the gross
                                before what was spent during the sitting. */}
                            <span className="block text-xs text-slate-400">
                              {money(s.profit.revenue)} sold
                            </span>
                          </>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    )}
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

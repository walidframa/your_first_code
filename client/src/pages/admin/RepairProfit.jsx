import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, Printer, Wrench } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { Card, EmptyState, Input, LoadError, Select, Skeleton, cx, money } from '../../components/ui';
import { isoDay } from '../../lib/when';

const PRESETS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'This week'],
  ['lastweek', 'Last week'],
  ['month', 'This month'],
  ['lastmonth', 'Last month'],
  ['year', 'This year'],
  ['custom', 'Custom dates…'],
];

const GROUPINGS = [
  ['day', 'By day'],
  ['week', 'By week'],
  ['month', 'By month'],
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** How a row is named: the day itself, the Monday its week starts on, or the month. */
function periodLabel(period, groupBy) {
  if (groupBy === 'week') return `Week of ${period}`;
  if (groupBy === 'month') {
    const [y, m] = period.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }
  return period;
}

/**
 * What the bench made, period by period.
 *
 * The Repairs board carries one profit figure for whatever range is on
 * screen. The question the owner actually asks is "what does the bench make
 * in a day, in a week, in a month?" — and one total, however right, is not an
 * answer to that. So this is the same figure cut into the days, weeks or
 * months it is made of, with the total at the bottom that they add up to.
 *
 * A job is dated by the day the phone went home, costed by the parts fitted
 * to it plus what was paid outside for it. The money for it went into the
 * drawer in full when it was taken; the cost was paid from elsewhere, so the
 * profit is simply what was charged less what it cost.
 */
export default function RepairProfit() {
  const [preset, setPreset] = useState('month');
  const [groupBy, setGroupBy] = useState('day');
  const [from, setFrom] = useState(`${isoDay().slice(0, 8)}01`);
  const [to, setTo] = useState(isoDay());
  const [report, setReport] = useState(null);
  const [failed, setFailed] = useState(null);

  const load = useCallback(async () => {
    setReport(null);
    setFailed(null);
    const params = preset === 'custom' ? { from, to } : { preset };
    try {
      const res = await api.get('/repairs/profit', { params: { ...params, groupBy } });
      setReport(res.data);
    } catch (err) {
      setFailed(err);
    }
  }, [preset, from, to, groupBy]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = report?.byPeriod || [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Repair profits"
        subtitle={
          report?.from
            ? `${report.from} to ${report.to} · what the bench made, after what it cost`
            : 'What the bench made, after what it cost'
        }
        actions={
          <div className="flex items-center gap-2">
            <div className="w-32 shrink-0">
              <Select
                name="groupBy"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value)}
                aria-label="Cut by"
              >
                {GROUPINGS.map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-40 shrink-0">
              <Select
                name="preset"
                value={preset}
                onChange={(e) => setPreset(e.target.value)}
                aria-label="Period"
              >
                {PRESETS.map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {preset === 'custom' && (
          <div className="mb-4 flex items-end gap-3">
            <Input label="From" name="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <Input label="To" name="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        )}

        {failed ? (
          <LoadError error={failed} onRetry={load} what="the repair profits" />
        ) : !report ? (
          <Skeleton className="h-72" />
        ) : (
          <div className="space-y-4">
            {/*
              * The headline, then what it is made of. Profit first because it
              * is the figure the page is opened for; the drawer figure sits
              * apart because it answers a different question — what crossed
              * the counter, whether or not the phone has gone home yet.
              */}
            <Card className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-5" data-repair-profit-summary>
              {[
                ['Profit', report.profit, report.profit < 0 ? 'text-red-600' : 'text-brand-700'],
                ['Charged', report.revenue, 'text-slate-900'],
                ['Parts', -report.partsCost, 'text-slate-600'],
                ['Paid outside', -report.outsideCost, 'text-slate-600'],
                ['Money taken', report.taken.total, 'text-slate-700'],
              ].map(([label, value, colour]) => (
                <div key={label}>
                  <p className="text-[11px] tracking-wide text-slate-500 uppercase">{label}</p>
                  <p className={cx('tnum text-xl font-semibold', colour)}>{money(value)}</p>
                </div>
              ))}
              <p className="col-span-full text-xs text-slate-500">
                {report.jobs} {report.jobs === 1 ? 'job' : 'jobs'} handed back
                {report.warrantyJobs > 0 ? ` · ${report.warrantyJobs} under warranty, charged nothing` : ''}
                {' '}· the money went into the drawer in full; the cost was paid from elsewhere, so
                the profit is what was charged less what it cost.
              </p>
              {report.unknownCostParts > 0 && (
                <p className="col-span-full flex items-start gap-1.5 text-xs text-amber-700">
                  <AlertTriangle size={14} className="mt-px shrink-0" />
                  <span>
                    {report.unknownCostParts} {report.unknownCostParts === 1 ? 'part has' : 'parts have'}{' '}
                    no cost recorded, so the profit is flattered by whatever they cost.
                  </span>
                </p>
              )}
            </Card>

            <Card>
              <div className="border-b border-slate-100 px-5 py-3">
                <p className="font-medium text-slate-900">
                  {GROUPINGS.find(([v]) => v === groupBy)[1]}
                </p>
                <p className="text-sm text-slate-500">
                  Dated by the day the phone went home. The rows add up to the figures above.
                </p>
              </div>
              {rows.length === 0 ? (
                <EmptyState
                  icon={Wrench}
                  title="No repairs handed back"
                  description={
                    report.from
                      ? `Nothing was handed back between ${report.from} and ${report.to}.`
                      : 'Nothing has been handed back yet.'
                  }
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-repair-profit-rows>
                    <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                      <tr>
                        <th className="px-5 py-2 font-medium">Period</th>
                        <th className="px-3 py-2 text-right font-medium">Jobs</th>
                        <th className="px-3 py-2 text-right font-medium">Charged</th>
                        <th className="px-3 py-2 text-right font-medium">Parts</th>
                        <th className="px-3 py-2 text-right font-medium">Paid outside</th>
                        <th className="px-5 py-2 text-right font-medium">Profit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-rule">
                      {rows.map((r) => (
                        <tr key={r.period}>
                          <td className="tnum px-5 py-2 font-medium text-slate-800">
                            {periodLabel(r.period, groupBy)}
                            {r.warrantyJobs > 0 && (
                              <span className="ml-1 text-xs text-slate-400">
                                · {r.warrantyJobs} warranty
                              </span>
                            )}
                          </td>
                          <td className="tnum px-3 py-2 text-right text-slate-600">{r.jobs}</td>
                          <td className="tnum px-3 py-2 text-right text-slate-700">{money(r.revenue)}</td>
                          <td className="tnum px-3 py-2 text-right text-slate-500">{money(r.partsCost)}</td>
                          <td className="tnum px-3 py-2 text-right text-slate-500">{money(r.outsideCost)}</td>
                          <td
                            className={cx(
                              'tnum px-5 py-2 text-right font-semibold',
                              r.profit >= 0 ? 'text-brand-700' : 'text-red-600',
                            )}
                          >
                            {money(r.profit)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t border-slate-200 text-sm font-semibold">
                      <tr>
                        <td className="px-5 py-2 text-slate-900">Total</td>
                        <td className="tnum px-3 py-2 text-right text-slate-700">{report.jobs}</td>
                        <td className="tnum px-3 py-2 text-right text-slate-900">{money(report.revenue)}</td>
                        <td className="tnum px-3 py-2 text-right text-slate-600">{money(report.partsCost)}</td>
                        <td className="tnum px-3 py-2 text-right text-slate-600">{money(report.outsideCost)}</td>
                        <td className="tnum px-5 py-2 text-right text-brand-700">{money(report.profit)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </Card>

            <div className="no-print flex items-center gap-3 pb-2">
              <button
                onClick={() => window.print()}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 ring-1 ring-edge transition hover:bg-slate-50"
              >
                <Printer size={15} /> Print this report
              </button>
              <Link to="/admin/repairs" className="text-sm text-brand-700 hover:underline">
                Back to the repairs board
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

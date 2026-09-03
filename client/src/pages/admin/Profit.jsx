import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Printer, TrendingUp } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { Card, EmptyState, Input, LoadError, Select, Skeleton, cx, money } from '../../components/ui';
import { isoDay } from '../../lib/when';

const PRESETS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'This week'],
  /* The comparison a shop actually makes. "This week" on a Tuesday morning is
     two days measured against somebody's memory of seven. */
  ['lastweek', 'Last week'],
  ['month', 'This month'],
  ['lastmonth', 'Last month'],
  ['year', 'This year'],
  ['custom', 'Custom dates…'],
];

/**
 * The three figures, in the order they are worked out.
 *
 * Shown as a sequence rather than four unrelated tiles, because the story is
 * subtractive: this came in, this much of it was the goods, this much was the
 * shop, and this is what is left.
 */
function Waterfall({ report }) {
  const rows = [
    ['Revenue', report.revenue, 'text-slate-900', 'What was sold for'],
    ['Cost of goods', -report.cost, 'text-slate-600', 'What those goods cost to buy'],
    ['Gross profit', report.grossProfit, 'text-slate-900', `${Math.round(report.grossMargin)}% margin`],
  ];
  if (report.includeExpenses) {
    rows.push(['Expenses', -report.expenses.total, 'text-slate-600', `${report.expenses.count} recorded`]);
  }

  const net = report.includeExpenses ? report.netProfit : report.grossProfit;

  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-rule">
        {rows.map(([label, value, tone, hint]) => (
          <li key={label} className="flex items-baseline justify-between gap-4 px-5 py-3">
            <div>
              <p className={cx('font-medium', tone)}>{label}</p>
              <p className="text-xs text-slate-400">{hint}</p>
            </div>
            <p className={cx('tnum text-lg font-semibold', value < 0 ? 'text-red-600' : 'text-slate-900')}>
              {value < 0 ? `−${money(-value)}` : money(value)}
            </p>
          </li>
        ))}
      </ul>

      <div
        className={cx(
          'flex items-baseline justify-between gap-4 px-5 py-4',
          net >= 0 ? 'bg-brand-50' : 'bg-red-50',
        )}
      >
        <div>
          <p className={cx('font-semibold', net >= 0 ? 'text-brand-900' : 'text-red-900')}>
            {report.includeExpenses ? 'Net profit' : 'Gross profit'}
          </p>
          <p className={cx('text-xs', net >= 0 ? 'text-brand-700' : 'text-red-700')}>
            {report.revenue > 0
              ? `${Math.round(report.includeExpenses ? (report.netMargin ?? 0) : report.grossMargin)}% of revenue`
              : 'nothing sold in this period'}
          </p>
        </div>
        <p className={cx('tnum text-3xl font-semibold', net >= 0 ? 'text-brand-700' : 'text-red-700')}>
          {money(net)}
        </p>
      </div>
    </Card>
  );
}

export default function Profit() {
  const [preset, setPreset] = useState('month');
  /* This device's calendar, not UTC's — see lib/when.js. */
  const [from, setFrom] = useState(`${isoDay().slice(0, 8)}01`);
  const [to, setTo] = useState(isoDay());
  const [includeExpenses, setIncludeExpenses] = useState(true);
  const [report, setReport] = useState(null);
  const [failed, setFailed] = useState(null);

  /*
   * The failure is held, not thrown away. Unguarded, a refused request left
   * `report` null and the screen on its skeleton for ever — indistinguishable
   * from a slow one, and it never resolved either way.
   */
  const load = useCallback(async () => {
    setReport(null);
    setFailed(null);
    const query =
      preset === 'custom'
        ? `from=${from}&to=${to}`
        : `preset=${preset}`;
    try {
      const res = await api.get(`/expenses/profit?${query}&includeExpenses=${includeExpenses}`);
      setReport(res.data);
    } catch (err) {
      setFailed(err);
    }
  }, [preset, from, to, includeExpenses]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Profit"
        /*
          * The dates the period actually came out as, not just its name.
          *
          * "This week" is a label, and a shop that thinks it means one thing
          * while the server means another has no way to find that out from a
          * screen that only ever says "This week". Saying the two dates makes
          * the range checkable at a glance.
          */
        subtitle={
          report?.period?.from
            ? `${report.period.from} to ${report.period.to} · what the shop made, after what it cost`
            : 'What the shop made, after what it cost'
        }
        actions={
          <div className="flex items-center gap-2">
            <label className="flex shrink-0 items-center gap-2 text-sm whitespace-nowrap text-slate-600">
              <input
                type="checkbox"
                checked={includeExpenses}
                onChange={(e) => setIncludeExpenses(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-brand-600"
              />
              Take expenses off
            </label>
            {/* Sized by a wrapper: the Select is w-full by design, and two
                width utilities on one element is a coin toss. */}
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
          <LoadError error={failed} onRetry={load} what="the profit figures" />
        ) : !report ? (
          <Skeleton className="h-72" />
        ) : (
          <div className="space-y-4">
            {report.unknownCostLines > 0 && (
              <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>
                  {report.unknownCostLines} sold line{report.unknownCostLines === 1 ? ' has' : 's have'} no
                  cost recorded — sold before costs were kept on the line. Profit for those is overstated.
                </span>
              </p>
            )}

            <Waterfall report={report} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Card className="p-5">
                <p className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">Where it came from</p>
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-slate-600">
                      Register<span className="ml-1 text-xs text-slate-400">×{report.register.orders}</span>
                    </dt>
                    <dd className="tnum text-slate-800">{money(report.register.revenue)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-600">
                      Invoices<span className="ml-1 text-xs text-slate-400">×{report.invoices.invoices}</span>
                    </dt>
                    <dd className="tnum text-slate-800">{money(report.invoices.revenue)}</dd>
                  </div>
                  <div className="flex justify-between border-t border-slate-100 pt-1.5 font-semibold">
                    <dt className="text-slate-900">Revenue</dt>
                    <dd className="tnum text-slate-900">{money(report.revenue)}</dd>
                  </div>

                  {/*
                    * Below the total, and worded as already-gone, because it is.
                    *
                    * This used to sit above the line with a minus in front of
                    * it, which read as a subtraction the total had not done —
                    * $0 and $128 and −$384 above a Revenue of $128 is arithmetic
                    * that visibly does not work, and a figure a shopkeeper
                    * cannot make add up is a figure they stop believing.
                    *
                    * Refunded sales were never in revenue in the first place:
                    * they are struck out where they happened, not netted off
                    * afterwards. So this is context for a quiet month, not a
                    * line in the sum.
                    */}
                  {(report.refunds.orders > 0 || report.refunds.partial > 0) && (
                    <div className="mt-1.5 space-y-1 border-t border-slate-100 pt-1.5 text-xs">
                      <p className="text-slate-400">Already taken off the figures above</p>
                      {report.refunds.orders > 0 && (
                        <div className="flex justify-between">
                          <dt className="text-slate-400">
                            {report.refunds.orders} refunded sale
                            {report.refunds.orders === 1 ? '' : 's'}
                          </dt>
                          <dd className="tnum text-slate-400">{money(report.refunds.total)}</dd>
                        </div>
                      )}
                      {/*
                        * Named separately because it is a different thing: the
                        * sale still stands, and only part of it came back. Left
                        * unsaid, this money simply went missing from a month's
                        * takings with nothing on the screen to account for it.
                        */}
                      {report.refunds.partial > 0 && (
                        <div className="flex justify-between">
                          <dt className="text-slate-400">
                            items returned off {report.refunds.partialOrders} other sale
                            {report.refunds.partialOrders === 1 ? '' : 's'}
                          </dt>
                          <dd className="tnum text-slate-400">{money(report.refunds.partial)}</dd>
                        </div>
                      )}
                    </div>
                  )}
                </dl>
              </Card>

              <Card className="col-span-2 p-5">
                <p className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">
                  Spending by category
                </p>
                {report.expenses.byCategory.length === 0 ? (
                  <p className="py-4 text-sm text-slate-400">
                    {report.includeExpenses
                      ? 'Nothing recorded in this period.'
                      : 'Expenses are switched off for this report.'}
                  </p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {report.expenses.byCategory.map((c) => (
                      <li key={c.category} className="flex items-center gap-3">
                        <span className="w-28 shrink-0 capitalize text-slate-600">{c.category}</span>
                        <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <span
                            className="block h-full rounded-full bg-amber-400"
                            style={{
                              width: `${Math.max(2, (c.total / report.expenses.total) * 100)}%`,
                            }}
                          />
                        </span>
                        <span className="tnum w-24 shrink-0 text-right text-slate-800">{money(c.total)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            {/*
              * The same total, day by day.
              *
              * The complaint this answers: "the register says $650 and the
              * report says something else." With one number on the screen
              * there is nothing to check it against and no way to find out
              * which of the two is wrong — so here are the days it is made of.
              * A day that looks wrong can be opened in Sales and counted.
              */}
            <Card>
              <div className="border-b border-slate-100 px-5 py-3">
                <p className="font-medium text-slate-900">Day by day</p>
                <p className="text-sm text-slate-500">
                  What the total above is made of{report.period.zone ? ` · days as they fall in ${report.period.zone.replace(/_/g, ' ')}` : ''}
                </p>
              </div>
              {report.byDay.length === 0 ? (
                <EmptyState
                  icon={TrendingUp}
                  title="No sales in this period"
                  description={
                    report.period.from
                      ? `Nothing was rung up or invoiced between ${report.period.from} and ${report.period.to}.`
                      : 'Nothing has been sold yet.'
                  }
                />
              ) : (
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                    <tr>
                      <th className="px-5 py-2 font-medium">Day</th>
                      <th className="px-3 py-2 text-right font-medium">Sales</th>
                      <th className="px-3 py-2 text-right font-medium">Revenue</th>
                      <th className="px-3 py-2 text-right font-medium">Cost</th>
                      <th className="px-5 py-2 text-right font-medium">Gross profit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    {report.byDay.map((d) => (
                      <tr key={d.day}>
                        <td className="tnum px-5 py-2 font-medium text-slate-800">{d.day}</td>
                        <td className="tnum px-3 py-2 text-right text-slate-600">{d.sales}</td>
                        <td className="tnum px-3 py-2 text-right text-slate-700">{money(d.revenue)}</td>
                        <td className="tnum px-3 py-2 text-right text-slate-500">{money(d.cost)}</td>
                        <td
                          className={cx(
                            'tnum px-5 py-2 text-right font-semibold',
                            d.profit >= 0 ? 'text-brand-700' : 'text-red-600',
                          )}
                        >
                          {money(d.profit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {/* The column adds up to the figure at the top, which is the
                      whole point of showing it. */}
                  <tfoot className="border-t border-slate-200 text-sm font-semibold">
                    <tr>
                      <td className="px-5 py-2 text-slate-900">Total</td>
                      <td className="tnum px-3 py-2 text-right text-slate-700">
                        {report.byDay.reduce((n, d) => n + d.sales, 0)}
                      </td>
                      <td className="tnum px-3 py-2 text-right text-slate-900">{money(report.revenue)}</td>
                      <td className="tnum px-3 py-2 text-right text-slate-600">{money(report.cost)}</td>
                      <td className="tnum px-5 py-2 text-right text-brand-700">
                        {money(report.grossProfit)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </Card>

            <Card>
              <div className="border-b border-slate-100 px-5 py-3">
                <p className="font-medium text-slate-900">What made the most</p>
                <p className="text-sm text-slate-500">By profit, not by how many sold</p>
              </div>
              {report.topProducts.length === 0 ? (
                <EmptyState
                  icon={TrendingUp}
                  title="Nothing sold in this period"
                  description="Pick a wider range, or ring up a sale."
                />
              ) : (
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                    <tr>
                      <th className="px-5 py-2 font-medium">Product</th>
                      <th className="px-3 py-2 text-right font-medium">Sold</th>
                      <th className="px-3 py-2 text-right font-medium">Revenue</th>
                      <th className="px-3 py-2 text-right font-medium">Cost</th>
                      <th className="px-5 py-2 text-right font-medium">Profit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    {report.topProducts.map((p) => (
                      <tr key={p.id}>
                        <td className="px-5 py-2">
                          <p className="font-medium text-slate-800">{p.name}</p>
                          <p className="text-xs text-slate-400">{p.sku}</p>
                        </td>
                        <td className="tnum px-3 py-2 text-right text-slate-600">{p.quantity}</td>
                        <td className="tnum px-3 py-2 text-right text-slate-700">{money(p.revenue)}</td>
                        <td className="tnum px-3 py-2 text-right text-slate-500">{money(p.cost)}</td>
                        <td
                          className={cx(
                            'tnum px-5 py-2 text-right font-semibold',
                            p.profit >= 0 ? 'text-brand-700' : 'text-red-600',
                          )}
                        >
                          {money(p.profit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <div className="no-print pb-2">
              <button
                onClick={() => window.print()}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 ring-1 ring-edge transition hover:bg-slate-50"
              >
                <Printer size={15} /> Print this report
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

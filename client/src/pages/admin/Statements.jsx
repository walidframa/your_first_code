import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { Card, Input, LoadError, Skeleton, cx, money } from '../../components/ui';
import { isoDay } from '../../lib/when';

/**
 * The two statements a shop is actually asked for.
 *
 * The trial balance beside this is a working paper — it proves the ledger adds
 * up. This is the pair anybody outside the shop wants: what it earned over a
 * period, and what it owns and owes on a date. An accountant asks for both by
 * name; a bank will not open a file without them.
 *
 * Read straight off the posted journal every time, so neither can drift from
 * the books they came from.
 */

/** A month, as the two dates the server wants. */
function thisMonth() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  /* Formatted on the device's own calendar: `toISOString` on a local midnight
     lands on the day before in any zone east of Greenwich, so "this month"
     quietly began on the 31st. See lib/when.js. */
  return { from: isoDay(first), to: isoDay(now) };
}

function Lines({ rows, empty }) {
  if (!rows.length) return <p className="px-5 py-3 text-sm text-slate-400">{empty}</p>;
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.id} className="flex items-baseline gap-3 px-5 py-1.5 text-sm">
          <span className="w-14 shrink-0 font-mono text-xs text-slate-400">{r.code}</span>
          <span className="min-w-0 flex-1 truncate text-slate-700">{r.name}</span>
          <span className="tnum shrink-0 text-slate-800">{money(r.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

/** A figure the eye is meant to stop on. */
function Total({ label, value, strong = false, note = null }) {
  return (
    <div
      className={cx(
        'flex items-baseline gap-3 border-t px-5 py-2.5',
        strong ? 'border-slate-300' : 'border-slate-100',
      )}
    >
      <span className={cx('flex-1 text-sm', strong ? 'font-semibold text-slate-900' : 'text-slate-600')}>
        {label}
        {note && <span className="ml-2 text-xs font-normal text-slate-400">{note}</span>}
      </span>
      <span
        className={cx(
          'tnum',
          strong ? 'text-base font-semibold text-slate-900' : 'text-sm text-slate-800',
        )}
      >
        {money(value)}
      </span>
    </div>
  );
}

export default function Statements() {
  const month = thisMonth();
  const [from, setFrom] = useState(month.from);
  const [to, setTo] = useState(month.to);
  const [income, setIncome] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [failed, setFailed] = useState(null);

  const load = useCallback(async () => {
    try {
      /*
       * The balance sheet is drawn on the last day of the period being read,
       * not today. Reading March's trading beside June's position is two
       * statements about two different things on one screen.
       */
      const [is, bs] = await Promise.all([
        api.get('/ledger/income-statement', { params: { from, to } }),
        api.get('/ledger/balance-sheet', { params: { asAt: to } }),
      ]);
      setIncome(is.data);
      setSheet(bs.data);
      setFailed(null);
    } catch (err) {
      setFailed(err);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  if (failed) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Financial statements" subtitle="Profit and position, from the books" />
        <div className="p-4 sm:p-6">
          <LoadError error={failed} onRetry={load} what="the statements" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Financial statements"
        subtitle="Profit and position, read straight off the posted journal"
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-5xl space-y-5">
          <Card className="flex flex-wrap items-end gap-3 p-4">
            {/* Sized to a date. Left to itself the field fills the row, and two
                of them become two rows for eight characters each. */}
            <div className="w-40">
              <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="w-40">
              <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <p className="flex-1 pb-2 text-xs text-slate-400">
              The profit covers these dates. The position is drawn on the closing date.
            </p>
          </Card>

          {!income || !sheet ? (
            <Skeleton className="h-64" />
          ) : (
            <>
              <Card>
                <div className="border-b border-slate-100 px-5 py-3">
                  <h2 className="text-sm font-semibold text-slate-900">What the shop earned</h2>
                  <p className="text-xs text-slate-500">
                    {from} to {to}
                  </p>
                </div>

                <p className="px-5 pt-3 pb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                  Revenue
                </p>
                <Lines rows={income.revenue} empty="Nothing sold in these dates." />
                <Total label="Total revenue" value={income.totals.revenue} />

                <p className="px-5 pt-3 pb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                  What the goods cost
                </p>
                <Lines rows={income.costOfSales} empty="No cost of sales posted." />
                {/*
                  * The line a shop actually manages. Everything above it moves
                  * with what is bought and sold; everything below it is the
                  * cost of being open, and the two are fixed by completely
                  * different decisions.
                  */}
                <Total
                  label="Gross profit"
                  value={income.totals.grossProfit}
                  note={
                    income.totals.grossMargin === null
                      ? null
                      : `${income.totals.grossMargin.toFixed(1)}% margin`
                  }
                />

                <p className="px-5 pt-3 pb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                  The cost of being open
                </p>
                <Lines rows={income.operating} empty="No running costs posted." />
                <Total label="Total costs" value={income.totals.operating} />
                <Total label="Profit for the period" value={income.totals.netProfit} strong />
              </Card>

              <Card>
                <div className="border-b border-slate-100 px-5 py-3">
                  <h2 className="text-sm font-semibold text-slate-900">
                    What the shop owns and owes
                  </h2>
                  <p className="text-xs text-slate-500">as at {to}</p>
                </div>

                <p className="px-5 pt-3 pb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                  What it owns
                </p>
                <Lines rows={sheet.assets} empty="Nothing posted to an asset account." />
                <Total label="Total assets" value={sheet.totals.assets} strong />

                <p className="px-5 pt-4 pb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                  What it owes
                </p>
                <Lines rows={sheet.liabilities} empty="The shop owes nothing." />
                <Total label="Total owed" value={sheet.totals.liabilities} />

                <p className="px-5 pt-4 pb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                  The owner’s share
                </p>
                <Lines rows={sheet.equity} empty="Nothing posted to equity." />
                {/*
                  * Its own line, and the one this screen would be wrong without.
                  * Between one closing and the next, what the shop has earned
                  * sits in the income and expense accounts rather than in
                  * equity — so a balance sheet drawn without it is out by
                  * exactly the profit, which reads as a bookkeeping error and
                  * is not one. Naming it is the difference between a statement
                  * somebody can check and one they have to trust.
                  */}
                <Total label="Profit since the last closing" value={sheet.result} />
                <Total label="Total owner’s share" value={sheet.totals.equity} />
                <Total label="Owed and owned together" value={sheet.totals.fundedBy} strong />

                <div
                  className={cx(
                    'flex items-center gap-2 rounded-b-xl px-5 py-3 text-sm',
                    sheet.balanced ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800',
                  )}
                >
                  {sheet.balanced ? (
                    <>
                      <CheckCircle2 size={16} />
                      What the shop owns equals what it owes plus the owner’s share. The books
                      balance.
                    </>
                  ) : (
                    <>
                      <AlertTriangle size={16} />
                      These are out by {money(sheet.totals.difference)}. Double entry makes that
                      impossible, so this is a fault in the app rather than in your bookkeeping —
                      please report it.
                    </>
                  )}
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

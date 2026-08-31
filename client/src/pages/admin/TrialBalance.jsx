import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { Card, EmptyState, Input, LoadError, Skeleton, cx, money } from '../../components/ui';

/**
 * The trial balance, and the one line on it that matters.
 *
 * Every account with anything posted to it, in two columns — and underneath,
 * whether the two columns agree. That last fact is not decoration: it is the
 * check that the ledger has not been corrupted by anything, including by this
 * app. So it is stated in words at the top rather than left for somebody to
 * add up the columns and notice.
 *
 * A shop should never see it say no. If it ever does, that is a bug here and
 * the message says so, because a shopkeeper cannot be expected to work out
 * that the software has broken its own arithmetic.
 */
const TYPE_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'];
const TYPE_HEADING = {
  asset: 'What the shop owns',
  liability: 'What it owes',
  equity: 'The owner’s share',
  income: 'What it earns',
  expense: 'What it spends',
};

export default function TrialBalance() {
  const [report, setReport] = useState(null);
  const [failed, setFailed] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get('/ledger/trial-balance', {
        params: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
      });
      setReport(res.data);
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
        <PageHeader title="Trial balance" />
        <Card className="m-4">
          <LoadError error={failed} what="the trial balance" onRetry={load} />
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Trial balance" subtitle="Every account with something on it, and the proof it adds up" />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mb-4 flex max-w-4xl flex-wrap items-end gap-3">
          <Input label="From" name="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="To" name="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <p className="pb-2 text-xs text-slate-500">Leave both empty for everything since the books opened.</p>
        </div>

        {!report ? (
          <Card className="max-w-4xl p-5"><Skeleton className="h-64 w-full" /></Card>
        ) : report.accounts.length === 0 ? (
          <Card className="max-w-4xl">
            <EmptyState
              title="Nothing posted yet"
              hint="Write a journal entry and it will appear here, on both sides."
            />
          </Card>
        ) : (
          <>
            {/* The proof, before the figures rather than after them. */}
            <div
              className={cx(
                'mb-3 flex max-w-4xl items-start gap-2 rounded-xl px-3 py-2.5 text-sm ring-1',
                report.balanced
                  ? 'bg-emerald-50 text-emerald-900 ring-emerald-200'
                  : 'bg-red-50 text-red-900 ring-red-200',
              )}
            >
              {report.balanced ? (
                <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              )}
              <p>
                {report.balanced ? (
                  <>
                    <span className="font-medium">The books balance.</span> Both columns come to{' '}
                    <span className="tnum">{money(report.totals.debit)}</span>.
                  </>
                ) : (
                  <>
                    <span className="font-medium">The books do not balance.</span> Debits{' '}
                    <span className="tnum">{money(report.totals.debit)}</span>, credits{' '}
                    <span className="tnum">{money(report.totals.credit)}</span>. This should not be
                    possible — every entry is refused unless it balances — so it is a fault in the app
                    rather than anything you have done.
                  </>
                )}
              </p>
            </div>

            <Card className="max-w-4xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Account</th>
                    <th className="w-32 px-2 py-2 text-right font-medium">Debit</th>
                    <th className="w-32 px-2 py-2 text-right font-medium">Credit</th>
                    <th className="w-32 px-2 py-2 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {TYPE_ORDER.flatMap((type) => {
                    const rows = report.accounts.filter((a) => a.type === type);
                    if (rows.length === 0) return [];
                    return [
                      <tr key={`h-${type}`} className="border-t border-slate-200 bg-slate-50/70">
                        <td colSpan={4} className="px-3 py-1.5 text-xs font-semibold text-slate-600">
                          {TYPE_HEADING[type]}
                        </td>
                      </tr>,
                      ...rows.map((a) => (
                        <tr key={a.id} className="border-t border-slate-100">
                          <td className="px-3 py-2">
                            <span className="font-mono text-xs text-slate-400">{a.code}</span>{' '}
                            <span className="text-slate-800">{a.name}</span>
                          </td>
                          <td className="tnum px-2 py-2 text-right text-slate-700">{a.debit ? money(a.debit) : ''}</td>
                          <td className="tnum px-2 py-2 text-right text-slate-700">{a.credit ? money(a.credit) : ''}</td>
                          <td className="tnum px-2 py-2 text-right font-medium text-slate-900">{money(a.balance)}</td>
                        </tr>
                      )),
                    ];
                  })}
                </tbody>
                <tfoot className="border-t-2 border-slate-300 bg-slate-50">
                  <tr>
                    <td className="px-3 py-2.5 text-sm font-semibold text-slate-800">Totals</td>
                    <td className="tnum px-2 py-2.5 text-right font-semibold text-slate-900">{money(report.totals.debit)}</td>
                    <td className="tnum px-2 py-2.5 text-right font-semibold text-slate-900">{money(report.totals.credit)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Wallet } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import AddExpense, { EXPENSE_CATEGORIES } from '../../components/AddExpense';
import HistoryFilter from '../../components/HistoryFilter';
import { useHistoryFilter } from '../../lib/history';
import { lbp } from '../../context/SettingsContext';
import { Badge, Button, Card, EmptyState, Skeleton, cx, money, useToast } from '../../components/ui';
import { useConfirm } from '../../components/ConfirmProvider';

const label = (list, value) => list.find(([v]) => v === value)?.[1] || value;

export default function Expenses() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const history = useHistoryFilter('month');
  const confirm = useConfirm();
  const { range } = history;

  /*
   * The dates go to the server rather than being applied here, because the
   * tiles above the table are its totals — filtering the rows alone would give
   * a month's summary over a week's list.
   */
  const load = useCallback(async () => {
    const params = {};
    if (range.from) params.from = range.from;
    if (range.to) params.to = range.to;
    const res = await api.get('/expenses', { params });
    setData(res.data);
  }, [range.from, range.to]);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(expense) {
    const agreed = await confirm({
      title: 'Delete this expense?',
      body: `${money(expense.amount_usd)} on ${expense.spent_on}${expense.note ? ` — ${expense.note}` : ''}. If it was paid out of the till, the money goes back into the drawer.`,
      confirmLabel: 'Delete it',
    });
    if (!agreed) return;

    try {
      await api.delete(`/expenses/${expense.id}`);
      toast('Expense deleted');
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not delete that', 'error');
    }
  }

  // The tiles above are the period's totals; this only narrows what is listed.
  const shown = (data?.expenses || []).filter((e) =>
    history.matches(e.note, label(EXPENSE_CATEGORIES, e.category), e.supplier_name, e.paid_with),
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Expenses"
        subtitle="What it costs to keep the doors open"
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus size={16} /> Add expense
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <HistoryFilter
          filter={history}
          label="Search expenses"
          placeholder="Search a note, a category, who was paid…"
        />

        {!data ? (
          <Skeleton className="h-64" />
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Card className="px-4 py-3">
                <p className="text-xs text-slate-500">Spent</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">{money(data.summary.total)}</p>
                <p className="text-xs text-slate-400">
                  {data.summary.count} expense{data.summary.count === 1 ? '' : 's'}
                </p>
              </Card>

              {data.summary.byCategory.slice(0, 3).map((c) => (
                <Card key={c.category} className="px-4 py-3">
                  <p className="text-xs text-slate-500">{label(EXPENSE_CATEGORIES, c.category)}</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{money(c.total)}</p>
                  <p className="text-xs text-slate-400">
                    {data.summary.total > 0
                      ? `${Math.round((c.total / data.summary.total) * 100)}% of spending`
                      : ''}
                  </p>
                </Card>
              ))}
            </div>

            <Card>
              {shown.length === 0 ? (
                <EmptyState
                  icon={Wallet}
                  title="Nothing recorded for this period"
                  description="Add rent, wages, electricity — anything that costs money but never appears on an invoice."
                />
              ) : (
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                    <tr>
                      <th className="px-5 py-2.5 font-medium">Date</th>
                      <th className="px-3 py-2.5 font-medium">What for</th>
                      <th className="px-3 py-2.5 font-medium">Note</th>
                      <th className="px-3 py-2.5 font-medium">Paid with</th>
                      <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                      <th className="px-5 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    {shown.map((e) => (
                      <tr key={e.id} className="hover:bg-slate-50/60">
                        <td className="px-5 py-2.5 text-slate-500">{e.spent_on}</td>
                        <td className="px-3 py-2.5">
                          <Badge tone="neutral">{label(EXPENSE_CATEGORIES, e.category)}</Badge>
                        </td>
                        <td className="max-w-xs truncate px-3 py-2.5 text-slate-600">{e.note || '—'}</td>
                        <td className="px-3 py-2.5 text-slate-500">
                          {e.paid_with}
                          {e.cash_movement_id && (
                            <span className="ml-1 text-xs text-slate-400">from the till</span>
                          )}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right font-semibold text-slate-900">
                          {money(e.total_usd)}
                          {e.amount_lbp > 0 && (
                            <span className="block text-xs font-normal text-slate-400">
                              {lbp(e.amount_lbp)}
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-2.5 text-right">
                          <button
                            onClick={() => remove(e)}
                            aria-label={`Delete ${e.category} expense`}
                            className="rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            {data.summary.byCategory.length > 0 && (
              <Card className="mt-4">
                <div className="border-b border-slate-100 px-5 py-3">
                  <p className="font-medium text-slate-900">Where the money went</p>
                </div>
                <ul className="divide-y divide-rule">
                  {data.summary.byCategory.map((c) => {
                    const share = data.summary.total > 0 ? (c.total / data.summary.total) * 100 : 0;
                    return (
                      <li key={c.category} className="flex items-center gap-3 px-5 py-2.5">
                        <span className="w-28 shrink-0 text-sm text-slate-600">
                          {label(EXPENSE_CATEGORIES, c.category)}
                        </span>
                        {/* The bar is a second reading of the same number, not the only one. */}
                        <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <span
                            className="block h-full rounded-full bg-brand-500"
                            style={{ width: `${Math.max(2, share)}%` }}
                          />
                        </span>
                        <span className="tnum w-24 shrink-0 text-right text-sm font-medium text-slate-800">
                          {money(c.total)}
                        </span>
                        <span className={cx('tnum w-12 shrink-0 text-right text-xs text-slate-400')}>
                          {Math.round(share)}%
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
          </>
        )}
      </div>

      {adding && (
        <AddExpense
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Wallet } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { lbp } from '../../context/SettingsContext';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  Select,
  Skeleton,
  cx,
  money,
  useToast,
} from '../../components/ui';

const CATEGORIES = [
  ['rent', 'Rent'],
  ['utilities', 'Utilities'],
  ['wages', 'Wages'],
  ['supplies', 'Supplies'],
  ['transport', 'Transport'],
  ['maintenance', 'Maintenance'],
  ['marketing', 'Marketing'],
  ['fees', 'Fees'],
  ['tax', 'Tax'],
  ['other', 'Other'],
];

const PAID_WITH = [
  ['cash', 'Cash — from the till'],
  ['bank', 'Bank'],
  ['card', 'Card'],
  ['other', 'Other'],
];

const PRESETS = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['year', 'This year'],
  ['', 'All time'],
];

const label = (list, value) => list.find(([v]) => v === value)?.[1] || value;

function AddExpense({ onClose, onSaved }) {
  const toast = useToast();
  const [category, setCategory] = useState('supplies');
  const [usd, setUsd] = useState('');
  const [lbpAmount, setLbpAmount] = useState('');
  const [paidWith, setPaidWith] = useState('cash');
  const [spentOn, setSpentOn] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/expenses', {
        spentOn,
        category,
        amountUsd: Number(usd) || 0,
        amountLbp: Number(lbpAmount) || 0,
        paidWith,
        note: note || null,
      });
      toast('Expense recorded');
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Add an expense" subtitle="Money spent running the shop">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Select label="What for" name="category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
          <Input
            label="Date"
            name="spentOn"
            type="date"
            value={spentOn}
            onChange={(e) => setSpentOn(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Dollars"
            name="amountUsd"
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={usd}
            onChange={(e) => setUsd(e.target.value)}
          />
          <Input
            label="Pounds"
            name="amountLbp"
            type="number"
            min="0"
            step="1000"
            placeholder="0"
            value={lbpAmount}
            onChange={(e) => setLbpAmount(e.target.value)}
          />
        </div>

        <Select label="Paid with" name="paidWith" value={paidWith} onChange={(e) => setPaidWith(e.target.value)}>
          {PAID_WITH.map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </Select>
        {paidWith === 'cash' && (
          <p className="text-xs text-slate-500">
            This comes out of the open cashbox, so the drawer still counts right at close.
          </p>
        )}

        <Input
          label="Note"
          name="note"
          placeholder="e.g. July rent"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            className="flex-1"
            loading={busy}
            disabled={!Number(usd) && !Number(lbpAmount)}
          >
            <Plus size={16} /> Record it
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function Expenses() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [preset, setPreset] = useState('month');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get(`/expenses${preset ? `?preset=${preset}` : ''}`);
    setData(res.data);
  }, [preset]);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(expense) {
    try {
      await api.delete(`/expenses/${expense.id}`);
      toast('Expense deleted');
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not delete that', 'error');
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Expenses"
        subtitle="What it costs to keep the doors open"
        actions={
          <div className="flex items-center gap-2">
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
            <Button onClick={() => setAdding(true)}>
              <Plus size={16} /> Add expense
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {!data ? (
          <Skeleton className="h-64" />
        ) : (
          <>
            <div className="mb-4 grid grid-cols-4 gap-3">
              <Card className="px-4 py-3">
                <p className="text-xs text-slate-500">Spent</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">{money(data.summary.total)}</p>
                <p className="text-xs text-slate-400">
                  {data.summary.count} expense{data.summary.count === 1 ? '' : 's'}
                </p>
              </Card>

              {data.summary.byCategory.slice(0, 3).map((c) => (
                <Card key={c.category} className="px-4 py-3">
                  <p className="text-xs text-slate-500">{label(CATEGORIES, c.category)}</p>
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
              {data.expenses.length === 0 ? (
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
                  <tbody className="divide-y divide-slate-50">
                    {data.expenses.map((e) => (
                      <tr key={e.id} className="hover:bg-slate-50/60">
                        <td className="px-5 py-2.5 text-slate-500">{e.spent_on}</td>
                        <td className="px-3 py-2.5">
                          <Badge tone="neutral">{label(CATEGORIES, e.category)}</Badge>
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
                <ul className="divide-y divide-slate-50">
                  {data.summary.byCategory.map((c) => {
                    const share = data.summary.total > 0 ? (c.total / data.summary.total) * 100 : 0;
                    return (
                      <li key={c.category} className="flex items-center gap-3 px-5 py-2.5">
                        <span className="w-28 shrink-0 text-sm text-slate-600">
                          {label(CATEGORIES, c.category)}
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

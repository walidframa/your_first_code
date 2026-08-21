import { useCallback, useEffect, useState } from 'react';
import { PiggyBank, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import MoneyInput from '../../components/MoneyInput';
import { useAuth } from '../../context/AuthContext';
import { Button, Card, Input, LoadError, Skeleton, cx, money, useToast } from '../../components/ui';

/** "2026-03" as a shopkeeper would say it. */
function monthName(ym) {
  const [y, m] = ym.split('-');
  return new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Setting the figure everything else is measured from.
 *
 * Offered with what the shelves cost, because that is what most shops mean by
 * the money they have in the business — and adding it up by hand across nine
 * hundred products is how the number ends up being a guess.
 */
function OpeningForm({ stockAtCost, opening, openedOn, onSaved }) {
  const toast = useToast();
  const [amount, setAmount] = useState(opening ? String(opening) : '');
  const [date, setDate] = useState(openedOn || `${new Date().toISOString().slice(0, 8)}01`);
  const [saving, setSaving] = useState(false);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put('/settings', {
        capital_opening: Number(amount) || 0,
        capital_opening_date: date,
      });
      toast('Saved');
      onSaved();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not save that', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="max-w-xl p-5">
      <h2 className="text-base font-semibold text-slate-900">What did you start with?</h2>
      <p className="mt-1 text-sm text-slate-500">
        The figure every month after it is measured from. Most shops use what the stock on the
        shelves cost them, because that is where the money went.
      </p>

      <form onSubmit={save} className="mt-4 space-y-3">
        <MoneyInput
          label="Opening capital"
          name="capital_opening"
          value={amount}
          onChange={setAmount}
        />
        <button
          type="button"
          onClick={() => setAmount(String(stockAtCost))}
          className="text-sm font-medium text-brand-700 hover:underline"
        >
          Use what the stock cost — {money(stockAtCost)}
        </button>

        <Input
          label="Counting from"
          name="capital_opening_date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          hint="Profit is counted from the start of this month onwards"
        />

        <Button type="submit" loading={saving} disabled={!amount}>
          Save
        </Button>
      </form>
    </Card>
  );
}

/**
 * What the shop is worth, and how the months have moved it.
 *
 * One question — "I put this much in; am I ahead?" — which the ledgers do not
 * answer on their own. The rise from one month to the next is exactly what the
 * shop earned that month, and nothing else moves it: buying stock does not,
 * because the money only changed shape.
 */
export default function Capital() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(null);
  const [editing, setEditing] = useState(false);

  /*
   * The failure is state, not a console line.
   *
   * This used to be an unguarded `await`: anything that went wrong rejected a
   * promise nobody was holding, `data` stayed null, and the screen sat on its
   * loading skeleton for ever. The person looking at it had no way of knowing
   * whether it was slow, broken, or waiting on a server that was not coming
   * back — which is a worse answer than any error message.
   */
  const load = useCallback(async () => {
    setFailed(null);
    try {
      const res = await api.get('/expenses/capital');
      setData(res.data);
      setEditing(!res.data.capital.set);
    } catch (err) {
      setFailed(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (failed) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Capital" subtitle="What the shop is worth, month by month" />
        <LoadError error={failed} onRetry={load} what="the capital figures" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Capital" subtitle="What the shop is worth, month by month" />
        <div className="p-4 sm:p-6">
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }

  const { capital: c, stockAtCost } = data;
  const earned = c.set ? Math.round((c.capital - c.opening) * 100) / 100 : 0;
  // The tallest bar in the table below, so the column reads as a shape.
  const peak = Math.max(c.opening, ...c.months.map((m) => m.capital), 1);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Capital"
        subtitle="What the shop is worth, month by month"
        actions={
          c.set && user?.role === 'admin' ? (
            <Button variant="secondary" onClick={() => setEditing((v) => !v)}>
              {editing ? 'Cancel' : 'Change the opening figure'}
            </Button>
          ) : undefined
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
        {/*
          * `!c.set` as well as `editing`, and not as a belt-and-braces: saving
          * the opening figure used to close the form before the reload had
          * come back, so the summary rendered for a moment against a shop that
          * still had no starting date — and read `null.slice(...)`. The state
          * that decides which of the two to show is now the data itself.
          */}
        {editing || !c.set ? (
          <OpeningForm
            stockAtCost={stockAtCost}
            opening={c.opening}
            openedOn={c.openedOn}
            /* Only `load`, which sets `editing` from what came back. */
            onSaved={load}
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Card className="p-5">
                <p className="flex items-center gap-1.5 text-sm text-slate-500">
                  <PiggyBank size={15} /> Capital now
                </p>
                <p className="tnum mt-1 text-3xl font-semibold text-slate-900">
                  {money(c.capital)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Counted from {monthName(c.openedOn.slice(0, 7))}
                </p>
              </Card>

              <Card className="p-5">
                <p className="flex items-center gap-1.5 text-sm text-slate-500">
                  <Wallet size={15} /> You started with
                </p>
                <p className="tnum mt-1 text-3xl font-semibold text-slate-700">
                  {money(c.opening)}
                </p>
              </Card>

              <Card className="p-5">
                <p className="flex items-center gap-1.5 text-sm text-slate-500">
                  {earned < 0 ? <TrendingDown size={15} /> : <TrendingUp size={15} />} Earned since
                </p>
                <p
                  className={cx(
                    'tnum mt-1 text-3xl font-semibold',
                    earned < 0 ? 'text-red-600' : 'text-brand-700',
                  )}
                >
                  {earned >= 0 ? '+' : ''}
                  {money(earned)}
                </p>
                {c.opening > 0 && (
                  <p className="mt-1 text-xs text-slate-500">
                    {Math.round((earned / c.opening) * 100)}% on what you put in
                  </p>
                )}
              </Card>
            </div>

            {/*
              * The month in hand, kept out of the total on purpose. Counting it
              * would make the headline fall every time somebody wrote down an
              * expense, which is the one thing that would stop anybody
              * trusting it.
              */}
            {c.thisMonth && (
              <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
                <p className="text-sm text-slate-600">
                  <span className="font-medium text-slate-900">
                    {monthName(c.thisMonth.month)}
                  </span>{' '}
                  is still going — not counted yet
                </p>
                <p className="tnum text-sm text-slate-600">
                  Made so far{' '}
                  <span
                    className={cx(
                      'font-semibold',
                      c.thisMonth.netProfit < 0 ? 'text-red-600' : 'text-brand-700',
                    )}
                  >
                    {money(c.thisMonth.netProfit)}
                  </span>
                </p>
                <p className="tnum text-sm text-slate-500">
                  Would stand at {money(c.thisMonth.wouldBe)} if it ended today
                </p>
              </Card>
            )}

            <Card>
              <div className="border-b border-slate-100 px-5 py-3">
                <h2 className="text-sm font-medium text-slate-800">Every month since</h2>
              </div>

              {c.months.length === 0 ? (
                <p className="px-5 py-6 text-sm text-slate-500">
                  No month has finished yet. The first one will be added on the 1st.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                      <tr>
                        <th className="px-5 py-2.5 font-medium">Month</th>
                        <th className="px-3 py-2.5 text-right font-medium">Sold</th>
                        <th className="px-3 py-2.5 text-right font-medium">Spent</th>
                        <th className="px-3 py-2.5 text-right font-medium">Made</th>
                        <th className="px-5 py-2.5 text-right font-medium">Capital after</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {c.months.map((m) => (
                        <tr key={m.month}>
                          <td className="px-5 py-2.5 font-medium text-slate-800">
                            {monthName(m.month)}
                          </td>
                          <td className="tnum px-3 py-2.5 text-right text-slate-600">
                            {money(m.revenue)}
                          </td>
                          <td className="tnum px-3 py-2.5 text-right text-slate-600">
                            {money(m.expenses)}
                          </td>
                          <td
                            className={cx(
                              'tnum px-3 py-2.5 text-right font-medium',
                              m.netProfit < 0 ? 'text-red-600' : 'text-brand-700',
                            )}
                          >
                            {m.netProfit >= 0 ? '+' : ''}
                            {money(m.netProfit)}
                          </td>
                          <td className="px-5 py-2.5">
                            {/* The shape of the thing, beside the figure: a
                                column of numbers does not show a climb. */}
                            <div className="flex items-center justify-end gap-2">
                              <span
                                className="h-1.5 rounded-full bg-brand-500"
                                style={{ width: `${Math.max(4, (m.capital / peak) * 90)}px` }}
                                aria-hidden="true"
                              />
                              <span className="tnum w-24 text-right font-semibold text-slate-900">
                                {money(m.capital)}
                              </span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <p className="text-xs text-slate-500">
              Capital moves only with what the shop earns. Buying stock does not raise it and
              paying a supplier does not lower it — the money changed shape rather than the shop
              getting richer or poorer.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

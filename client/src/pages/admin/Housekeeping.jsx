import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Hash, Lock } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { Button, Card, Input, Select, cx, money, useToast } from '../../components/ui';

/**
 * Two things a bookkeeper does to books that are already written.
 *
 * Everywhere else this app refuses to touch a posted entry — a mistake is
 * undone by its opposite. These two earn the exception because neither changes
 * a figure: one changes what a voucher is *called*, the other changes which
 * shelf a posting is filed on. The debits, the credits, the dates and the
 * totals come out identical.
 *
 * Both are shown before they are done. A shop should read what will happen, in
 * its own numbers, and then decide — which is also the only honest way to
 * offer an operation that rewrites part of a ledger.
 */
export default function Housekeeping() {
  const toast = useToast();
  const [accounts, setAccounts] = useState([]);

  useEffect(() => {
    api.get('/ledger/accounts').then((res) => setAccounts(res.data.accounts));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Housekeeping"
        subtitle="Tidying the books without changing what they say"
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-4xl space-y-5">
          <Renumber toast={toast} />
          <MoveAccount accounts={accounts} toast={toast} />
        </div>
      </div>
    </div>
  );
}

/** A red line that is a refusal, not a warning. */
function Refusal({ children }) {
  if (!children) return null;
  return (
    <p className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-800">
      <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {children}
    </p>
  );
}

function Renumber({ toast }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [startAt, setStartAt] = useState('1');
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const look = useCallback(async () => {
    setError('');
    try {
      const res = await api.get('/ledger/renumber/preview', { params: { from, to, startAt } });
      setPlan(res.data);
    } catch (err) {
      setPlan(null);
      setError(err.response?.data?.error || 'Could not read those dates');
    }
  }, [from, to, startAt]);

  useEffect(() => {
    if (from && to) look();
    else setPlan(null);
  }, [from, to, startAt, look]);

  async function run() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/ledger/renumber', { from, to, startAt: Number(startAt) || 1 });
      toast(`${res.data.renumbered} vouchers renumbered`);
      look();
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  const changing = plan?.entries.filter((e) => e.from !== e.to) ?? [];

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Hash size={16} /> Re-number vouchers
      </h2>
      {/*
        * Why anybody wants this. Vouchers are numbered as they are written,
        * which is not the order things happened in — an entry typed on Friday
        * for Tuesday's delivery lands after Thursday's — and drafts that were
        * never posted leave gaps. Plenty of shops live with both; an accountant
        * handing a numbered book to somebody else generally cannot.
        */}
      <p className="mt-1 text-sm text-slate-500">
        Puts the vouchers in date order and closes the gaps between them. Nothing about the money
        changes — only what each entry is called.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="w-40">
          <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="w-40">
          <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="w-28">
          <Input
            label="Start at"
            type="text"
            inputMode="numeric"
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
          />
        </div>
      </div>

      {plan?.closedThrough && (
        <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">
          <Lock size={13} /> The books are closed through {plan.closedThrough}. Anything on or before
          that date keeps its number.
        </p>
      )}

      <Refusal>{error || plan?.problem}</Refusal>

      {plan && plan.entries.length > 0 && (
        <>
          <p className="mt-4 text-xs font-semibold tracking-wide text-slate-400 uppercase">
            {changing.length} of {plan.entries.length} would change
          </p>
          <ul className="mt-1 max-h-56 overflow-y-auto">
            {plan.entries.map((e) => (
              <li key={e.id} className="flex items-baseline gap-2 py-1 text-sm">
                <span className="w-20 shrink-0 text-xs text-slate-400">{e.entry_date}</span>
                <span className="font-mono text-xs text-slate-500">{e.from}</span>
                {e.from !== e.to ? (
                  <>
                    <ArrowRight size={12} className="shrink-0 text-slate-300" />
                    <span className="font-mono text-xs font-medium text-slate-900">{e.to}</span>
                  </>
                ) : (
                  <span className="text-xs text-slate-300">stays</span>
                )}
                <span className="min-w-0 flex-1 truncate text-slate-600">{e.memo}</span>
              </li>
            ))}
          </ul>

          <Button
            className="mt-4"
            loading={busy}
            disabled={!!plan.problem || changing.length === 0}
            onClick={run}
          >
            Re-number these {plan.entries.length}
          </Button>
        </>
      )}
    </Card>
  );
}

function MoveAccount({ accounts, toast }) {
  const [fromAccountId, setFrom] = useState('');
  const [toAccountId, setTo] = useState('');
  const [from, setDateFrom] = useState('');
  const [to, setDateTo] = useState('');
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /* Headings hold nothing, so neither end of this can be one. */
  const postable = accounts.filter((a) => !a.is_group);

  const look = useCallback(async () => {
    setError('');
    if (!fromAccountId || !toAccountId) return setPlan(null);
    try {
      const res = await api.get('/ledger/transfer/preview', {
        params: { fromAccountId, toAccountId, ...(from ? { from } : {}), ...(to ? { to } : {}) },
      });
      setPlan(res.data);
      return undefined;
    } catch (err) {
      setPlan(null);
      setError(err.response?.data?.error || 'Those two cannot be paired');
      return undefined;
    }
  }, [fromAccountId, toAccountId, from, to]);

  useEffect(() => {
    look();
  }, [look]);

  async function run() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/ledger/transfer', {
        fromAccountId: Number(fromAccountId),
        toAccountId: Number(toAccountId),
        from: from || null,
        to: to || null,
      });
      toast(`${res.data.moved} postings moved to ${res.data.target.name}`);
      look();
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <ArrowRight size={16} /> Move an account’s postings
      </h2>
      {/*
        * For the mistake that is only visible months later: everything a
        * supplier charged went to Other expenses and belongs under Rent. A
        * correcting journal would move the balance and leave every movement
        * sitting in the wrong account's ledger — which is the page somebody
        * actually reads. So the postings themselves move.
        */}
      <p className="mt-1 text-sm text-slate-500">
        For something filed under the wrong account. The entries, dates and amounts stay exactly as
        they are — only the account they hang from changes.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Select label="Move from" value={fromAccountId} onChange={(e) => setFrom(e.target.value)}>
          <option value="">Choose an account…</option>
          {postable.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} · {a.name}
            </option>
          ))}
        </Select>
        <Select label="Move to" value={toAccountId} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose an account…</option>
          {postable.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} · {a.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="w-40">
          <Input
            label="From (optional)"
            type="date"
            value={from}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </div>
        <div className="w-40">
          <Input
            label="To (optional)"
            type="date"
            value={to}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>
        <p className="flex-1 pb-2 text-xs text-slate-400">
          Leave the dates empty to move everything the account holds.
        </p>
      </div>

      <Refusal>{error}</Refusal>

      {plan && (
        <>
          <div className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm">
            <p className="text-slate-800">
              <span className="font-medium">{plan.totals.count}</span> posting
              {plan.totals.count === 1 ? '' : 's'} would move from{' '}
              <span className="font-medium">{plan.source.name}</span> to{' '}
              <span className="font-medium">{plan.target.name}</span>.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {money(plan.totals.debit)} debit · {money(plan.totals.credit)} credit ·{' '}
              {money(plan.totals.balance)} off {plan.source.name} and onto {plan.target.name}
            </p>
          </div>

          <Button
            className={cx('mt-4')}
            loading={busy}
            disabled={plan.totals.count === 0}
            onClick={run}
          >
            Move {plan.totals.count} posting{plan.totals.count === 1 ? '' : 's'}
          </Button>
        </>
      )}
    </Card>
  );
}

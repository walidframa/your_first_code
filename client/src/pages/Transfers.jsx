import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Ban,
  Plus,
  Search,
  Wallet,
} from 'lucide-react';
import api from '../api';
import PageHeader from '../components/PageHeader';
import CashBox from '../components/CashBox';
import AddExpense from '../components/AddExpense';
import { lbp, useSettings } from '../context/SettingsContext';
import { useAuth } from '../context/AuthContext';
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
} from '../components/ui';

const PRESETS = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['', 'Everything'],
];

/**
 * Sending and paying out, in one dialog.
 *
 * The two are the same form with the money going the other way, so they are one
 * dialog with the direction on top rather than two screens that would drift
 * apart. What changes underneath is only the wording — "hands over" against
 * "you pay out" — because that is the sentence the operator is living.
 */
function TransferDialog({ companies, onClose, onSaved }) {
  const toast = useToast();
  const { rate, toLbp } = useSettings();

  const [direction, setDirection] = useState('send');
  const [company, setCompany] = useState(companies[0] || 'OMT');
  const [reference, setReference] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerIdNo, setCustomerIdNo] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [destination, setDestination] = useState('');
  const [amountUsd, setAmountUsd] = useState('');
  const [amountLbp, setAmountLbp] = useState('');
  const [feeUsd, setFeeUsd] = useState('');
  const [feeLbp, setFeeLbp] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const sending = direction === 'send';
  const amounts = {
    amountUsd: Number(amountUsd) || 0,
    amountLbp: Number(amountLbp) || 0,
    feeUsd: Number(feeUsd) || 0,
    feeLbp: Number(feeLbp) || 0,
  };

  // The same arithmetic the server does, shown before it is committed: the
  // operator is about to count this money out of a drawer.
  const drawer = sending
    ? { usd: amounts.amountUsd + amounts.feeUsd, lbp: amounts.amountLbp + amounts.feeLbp }
    : { usd: amounts.feeUsd - amounts.amountUsd, lbp: amounts.feeLbp - amounts.amountLbp };

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/transfers', {
        direction,
        company,
        reference,
        customerName,
        customerPhone,
        customerIdNo,
        counterparty,
        destination,
        ...amounts,
        note,
      });
      toast(sending ? 'Transfer sent' : 'Paid out');
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={sending ? 'Send a transfer' : 'Pay a transfer out'}
      subtitle={
        sending
          ? 'The customer hands the money over and you keep the fee'
          : 'You count the money out to the customer'
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {[
            ['send', 'Sending', 'Money comes in', ArrowDownLeft],
            ['payout', 'Paying out', 'Money goes out', ArrowUpRight],
          ].map(([value, label, hint, Icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => setDirection(value)}
              className={cx(
                'flex items-center gap-3 rounded-xl px-4 py-3 text-left ring-1 transition',
                direction === value
                  ? 'bg-brand-50 ring-2 ring-brand-600'
                  : 'bg-white ring-slate-200 hover:bg-slate-50',
              )}
            >
              <Icon size={18} className={direction === value ? 'text-brand-600' : 'text-slate-400'} />
              <span>
                <span className="block text-sm font-semibold text-slate-900">{label}</span>
                <span className="block text-xs text-slate-500">{hint}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Select label="Company" name="company" value={company} onChange={(e) => setCompany(e.target.value)}>
            {companies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <Input
            label="Reference"
            name="reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="The number on the slip"
            hint="What either side searches by later"
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Input
            label={sending ? 'Sender' : 'Collecting'}
            name="customerName"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            autoFocus
          />
          <Input
            label="Phone"
            name="customerPhone"
            value={customerPhone}
            onChange={(e) => setCustomerPhone(e.target.value)}
          />
          <Input
            label="ID number"
            name="customerIdNo"
            value={customerIdNo}
            onChange={(e) => setCustomerIdNo(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label={sending ? 'Going to' : 'Sent by'}
            name="counterparty"
            value={counterparty}
            onChange={(e) => setCounterparty(e.target.value)}
          />
          <Input
            label="Where"
            name="destination"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="Beirut, Dubai, Accra…"
          />
        </div>

        <div className="rounded-xl bg-slate-50 p-3">
          <p className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">
            {sending ? 'Amount being sent' : 'Amount being paid out'}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Dollars"
              name="amountUsd"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={amountUsd}
              onChange={(e) => setAmountUsd(e.target.value)}
            />
            <Input
              label="Pounds"
              name="amountLbp"
              type="number"
              min="0"
              step="1000"
              placeholder="0"
              value={amountLbp}
              onChange={(e) => setAmountLbp(e.target.value)}
            />
          </div>

          <p className="mt-3 mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">
            Your fee
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Dollars"
              name="feeUsd"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={feeUsd}
              onChange={(e) => setFeeUsd(e.target.value)}
            />
            <Input
              label="Pounds"
              name="feeLbp"
              type="number"
              min="0"
              step="1000"
              placeholder="0"
              value={feeLbp}
              onChange={(e) => setFeeLbp(e.target.value)}
            />
          </div>
        </div>

        <Input label="Note" name="note" value={note} onChange={(e) => setNote(e.target.value)} />

        {/* The one figure that has to be right: what physically moves. */}
        <div className="flex items-baseline justify-between rounded-xl bg-slate-900 px-4 py-3 text-white">
          <span className="text-sm font-medium">
            {drawer.usd >= 0 && drawer.lbp >= 0 ? 'Into the drawer' : 'Out of the drawer'}
          </span>
          <span className="tnum text-right font-semibold">
            <span className="block">{money(Math.abs(drawer.usd))}</span>
            {(drawer.lbp !== 0 || rate > 0) && (
              <span className="block text-sm font-normal text-slate-300">
                {lbp(Math.abs(drawer.lbp))}
              </span>
            )}
          </span>
        </div>
        {rate > 0 && amounts.amountLbp === 0 && amounts.amountUsd > 0 && (
          <p className="-mt-1 text-xs text-slate-500">
            {money(amounts.amountUsd)} is about {lbp(toLbp(amounts.amountUsd))} today.
          </p>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            className="flex-1"
            loading={busy}
            disabled={!amounts.amountUsd && !amounts.amountLbp}
          >
            {sending ? 'Take the money' : 'Pay it out'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** One figure with its pound equivalent underneath, the way the counter reads. */
function Stat({ label, usd, lbpAmount, tone = 'neutral' }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p
        className={cx(
          'tnum mt-1 text-2xl font-semibold',
          tone === 'in' ? 'text-emerald-700' : tone === 'out' ? 'text-red-600' : 'text-slate-900',
        )}
      >
        {money(usd)}
      </p>
      <p className="tnum text-xs text-slate-400">{lbp(lbpAmount)}</p>
    </Card>
  );
}

export default function Transfers() {
  const toast = useToast();
  const { user, can } = useAuth();

  const [data, setData] = useState(null);
  const [companies, setCompanies] = useState(['OMT']);
  const [preset, setPreset] = useState('today');
  const [search, setSearch] = useState('');
  const [mine, setMine] = useState(false);
  const [adding, setAdding] = useState(false);
  const [spending, setSpending] = useState(false);
  // Bumped after anything that touches the till, so the drawer panel follows.
  const [moved, setMoved] = useState(0);

  const load = useCallback(async () => {
    const res = await api.get('/transfers', {
      params: { preset, search: search.trim(), mine: mine ? 'true' : undefined },
    });
    setData(res.data);
  }, [preset, search, mine]);

  useEffect(() => {
    api.get('/transfers/meta').then((res) => setCompanies(res.data.companies));
  }, []);

  useEffect(() => {
    const id = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(id);
  }, [load, search]);

  async function cancel(transfer) {
    try {
      await api.post(`/transfers/${transfer.id}/cancel`);
      toast('Transfer cancelled and the money put back');
      setMoved((n) => n + 1);
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not cancel that', 'error');
    }
  }

  const summary = data?.summary;
  const netUsd = useMemo(
    () => (summary ? Math.round((summary.inUsd - summary.outUsd + summary.feeUsd) * 100) / 100 : 0),
    [summary],
  );
  const netLbp = summary ? summary.inLbp - summary.outLbp + summary.feeLbp : 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Transfers"
        subtitle="Money sent and paid out over the counter, and what it does to the drawer"
        actions={
          <div className="flex items-center gap-2">
            {/* Recording what the shop spends is its own permission. A button
                that always fails is worse than no button. */}
            {can('expenses') && (
              <Button variant="secondary" onClick={() => setSpending(true)}>
                <Wallet size={16} /> Expense
              </Button>
            )}
            <Button onClick={() => setAdding(true)}>
              <Plus size={16} /> New transfer
            </Button>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {!data ? (
            <Skeleton className="h-64" />
          ) : (
            <>
              <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Taken in" usd={summary.inUsd} lbpAmount={summary.inLbp} tone="in" />
                <Stat label="Paid out" usd={summary.outUsd} lbpAmount={summary.outLbp} tone="out" />
                <Stat label="Fees earned" usd={summary.feeUsd} lbpAmount={summary.feeLbp} />
                <Card className="px-4 py-3">
                  <p className="text-xs text-slate-500">Net through the drawer</p>
                  <p
                    className={cx(
                      'tnum mt-1 text-2xl font-semibold',
                      netUsd < 0 ? 'text-red-600' : 'text-slate-900',
                    )}
                  >
                    {money(netUsd)}
                  </p>
                  <p className="tnum text-xs text-slate-400">
                    {lbp(netLbp)} · {summary.sends} sent, {summary.payouts} paid
                  </p>
                </Card>
              </div>

              <div className="mb-3 flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search
                    size={16}
                    className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Reference, name or phone…"
                    aria-label="Find a transfer"
                    className="h-10 w-full rounded-lg bg-white pr-3 pl-9 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                  />
                </div>
                <div className="w-36 shrink-0">
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
                {/* Useful on a counter two people share a login-free shift on. */}
                <label className="flex shrink-0 items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-300">
                  <input
                    type="checkbox"
                    checked={mine}
                    onChange={(e) => setMine(e.target.checked)}
                    className="h-4 w-4 rounded"
                  />
                  Only mine
                </label>
              </div>

              <Card>
                {data.transfers.length === 0 ? (
                  <EmptyState
                    icon={ArrowLeftRight}
                    title="Nothing yet"
                    description="Every transfer recorded here moves the drawer with it, so the count at the end of the day still works."
                  />
                ) : (
                  <table className="w-full text-sm">
                    <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                      <tr>
                        <th className="px-5 py-2.5 font-medium">Time</th>
                        <th className="px-3 py-2.5 font-medium">Company</th>
                        <th className="px-3 py-2.5 font-medium">Reference</th>
                        <th className="px-3 py-2.5 font-medium">Customer</th>
                        <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                        <th className="px-3 py-2.5 text-right font-medium">Fee</th>
                        <th className="px-3 py-2.5 font-medium">By</th>
                        <th className="px-5 py-2.5" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {data.transfers.map((t) => {
                        const cancelled = t.status === 'cancelled';
                        return (
                          <tr key={t.id} className={cx('hover:bg-slate-50/60', cancelled && 'opacity-50')}>
                            <td className="px-5 py-2.5 whitespace-nowrap text-slate-500">
                              {t.created_at.slice(11, 16)}
                              <span className="ml-1 text-xs text-slate-400">
                                {t.created_at.slice(0, 10)}
                              </span>
                            </td>
                            <td className="px-3 py-2.5">
                              <Badge tone={t.direction === 'send' ? 'good' : 'warning'}>
                                {t.direction === 'send' ? 'In' : 'Out'}
                              </Badge>
                              <span className="ml-2 text-slate-700">{t.company}</span>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-xs text-slate-500">
                              {t.reference || '—'}
                            </td>
                            <td className="max-w-[14rem] truncate px-3 py-2.5 text-slate-700">
                              {t.customer_name || '—'}
                              {t.customer_phone && (
                                <span className="ml-1 text-xs text-slate-400">{t.customer_phone}</span>
                              )}
                            </td>
                            <td className="tnum px-3 py-2.5 text-right font-medium text-slate-900">
                              {t.amount_usd > 0 && <span className="block">{money(t.amount_usd)}</span>}
                              {t.amount_lbp > 0 && (
                                <span className="block text-xs font-normal text-slate-500">
                                  {lbp(t.amount_lbp)}
                                </span>
                              )}
                            </td>
                            <td className="tnum px-3 py-2.5 text-right text-emerald-700">
                              {t.fee_usd > 0 && <span className="block">{money(t.fee_usd)}</span>}
                              {t.fee_lbp > 0 && (
                                <span className="block text-xs text-slate-500">{lbp(t.fee_lbp)}</span>
                              )}
                              {!t.fee_usd && !t.fee_lbp && <span className="text-slate-300">—</span>}
                            </td>
                            <td className="px-3 py-2.5 text-slate-500">{t.operator_name || '—'}</td>
                            <td className="px-5 py-2.5 text-right">
                              {cancelled ? (
                                <Badge tone="neutral">Cancelled</Badge>
                              ) : (
                                <button
                                  onClick={() => cancel(t)}
                                  aria-label={`Cancel transfer ${t.reference || t.id}`}
                                  title="Cancel and put the money back"
                                  className="rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                                >
                                  <Ban size={15} />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </Card>
            </>
          )}
        </div>

        {/*
          * The drawer, beside the work that moves it. An operator who has to go
          * and look somewhere else for the till figure will not look, and the
          * one number this screen exists to protect is that one.
          */}
        <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-slate-200 bg-white">
          <CashBox refreshOn={moved} />
          <div className="px-4 py-3">
            <p className="text-xs text-slate-500">
              Signed in as <span className="font-medium text-slate-700">{user.name}</span>. Cash in and
              cash out above are for money that is not a transfer — a float, a run to the bank.
            </p>
          </div>
        </aside>
      </div>

      {adding && (
        <TransferDialog
          companies={companies}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            setMoved((n) => n + 1);
            load();
          }}
        />
      )}

      {spending && (
        <AddExpense
          onClose={() => setSpending(false)}
          onSaved={() => {
            setSpending(false);
            setMoved((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Ban,
  Printer,
  ReceiptText,
  Search,
} from 'lucide-react';
import api from '../api';
import PageHeader from '../components/PageHeader';
import CashBox from '../components/CashBox';
import VoucherSlip from '../components/VoucherSlip';
import { lbp, useSettings } from '../context/SettingsContext';
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

const ACCOUNT_LABELS = {
  customer: 'Customer',
  supplier: 'Supplier',
  wallet: 'Wallet',
  other: 'Someone else',
};

const REASON_LABELS = {
  supplier: 'Paying a supplier',
  wages: 'Wages',
  rent: 'Rent',
  utilities: 'Utilities',
  owner_draw: 'Owner took money out',
  refund: 'Refund',
  wallet_top_up: 'Buying credit',
  other: 'Other',
  customer: 'Customer paying',
  owner_funds: "Owner's money in",
  deposit: 'Deposit',
  wallet_withdrawal: 'Credit taken back',
};

const METHOD_LABELS = {
  cash: 'Cash — from the till',
  bank: 'Bank transfer',
  card: 'Card',
  other: 'Other',
};

const label = (map, value) => map[value] || value;

/**
 * Writing one voucher.
 *
 * Paying and receiving are the same piece of paper with the arrow reversed, so
 * they are one dialog with the direction on top. Everything below it is worded
 * from the operator's side — "who are you paying" against "who paid you" —
 * because that is the question actually being answered.
 */
function VoucherDialog({ meta, onClose, onSaved }) {
  const toast = useToast();
  const { rate, toLbp } = useSettings();

  const [kind, setKind] = useState('payment');
  const [accountType, setAccountType] = useState('supplier');
  const [accountId, setAccountId] = useState('');
  const [accountName, setAccountName] = useState('');
  const [amountUsd, setAmountUsd] = useState('');
  const [amountLbp, setAmountLbp] = useState('');
  const [method, setMethod] = useState('cash');
  const [reason, setReason] = useState('supplier');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [issuedOn, setIssuedOn] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const paying = kind === 'payment';
  const accounts = meta.accounts[accountType] || [];
  const reasons = meta.reasons[kind];

  /* Switching direction changes what the sensible default account is. */
  function switchKind(next) {
    setKind(next);
    setReason(meta.reasons[next][0]);
    const type = next === 'payment' ? 'supplier' : 'customer';
    setAccountType(type);
    setAccountId('');
  }

  const usd = Number(amountUsd) || 0;
  const lbpAmount = Number(amountLbp) || 0;
  const combined = usd + (rate > 0 ? lbpAmount / rate : 0);
  const selected = accounts.find((a) => String(a.id) === String(accountId));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post('/vouchers', {
        kind,
        accountType,
        accountId: accountType === 'other' ? null : Number(accountId) || null,
        accountName: accountType === 'other' ? accountName : null,
        amountUsd: usd,
        amountLbp: lbpAmount,
        method,
        reason,
        reference,
        note,
        issuedOn,
      });
      toast(`${res.data.voucher.voucher_number} recorded`);
      onSaved(res.data.voucher);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record that');
    } finally {
      setBusy(false);
    }
  }

  const ready =
    (usd > 0 || lbpAmount > 0) &&
    (accountType === 'other' ? accountName.trim().length > 0 : Boolean(accountId));

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={paying ? 'Payment voucher' : 'Receipt voucher'}
      subtitle={
        paying ? 'Money leaving the shop, and who it went to' : 'Money coming in, and who it came from'
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {[
            ['payment', 'Paying out', 'Money leaves the shop', ArrowUpRight],
            ['receipt', 'Receiving', 'Money comes in', ArrowDownLeft],
          ].map(([value, text, hint, Icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => switchKind(value)}
              className={cx(
                'flex items-center gap-3 rounded-xl px-4 py-3 text-left ring-1 transition',
                kind === value
                  ? 'bg-brand-50 ring-2 ring-brand-600'
                  : 'bg-white ring-slate-200 hover:bg-slate-50',
              )}
            >
              <Icon size={18} className={kind === value ? 'text-brand-600' : 'text-slate-400'} />
              <span>
                <span className="block text-sm font-semibold text-slate-900">{text}</span>
                <span className="block text-xs text-slate-500">{hint}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Select
            label={paying ? 'Paying what kind of account' : 'Received from'}
            name="accountType"
            value={accountType}
            onChange={(e) => {
              setAccountType(e.target.value);
              setAccountId('');
            }}
          >
            {meta.accountTypes.map((t) => (
              <option key={t} value={t}>
                {ACCOUNT_LABELS[t]}
              </option>
            ))}
          </Select>

          {accountType === 'other' ? (
            <Input
              label="Name"
              name="accountName"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder="The landlord, the electrician…"
            />
          ) : (
            <Select
              label="Which one"
              name="accountId"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Choose…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          )}
        </div>

        {/* What this does to the account, before it is done. */}
        {selected && accountType === 'wallet' && (
          <p className="-mt-1 text-xs text-slate-500">
            {selected.name} holds{' '}
            {selected.currency === 'LBP' ? lbp(selected.balance) : money(selected.balance)} —{' '}
            {paying ? 'this buys more credit' : 'this takes credit back out'}.
          </p>
        )}

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
            autoFocus
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

        <div className="grid grid-cols-3 gap-3">
          <Select label="What for" name="reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {label(REASON_LABELS, r)}
              </option>
            ))}
          </Select>
          <Select label="Paid with" name="method" value={method} onChange={(e) => setMethod(e.target.value)}>
            {meta.methods.map((m) => (
              <option key={m} value={m}>
                {label(METHOD_LABELS, m)}
              </option>
            ))}
          </Select>
          <Input
            label="Date"
            name="issuedOn"
            type="date"
            value={issuedOn}
            onChange={(e) => setIssuedOn(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Reference"
            name="reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Invoice or cheque number"
          />
          <Input
            label="Note"
            name="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. August rent"
          />
        </div>

        {/* The drawer figure, because that is what has to be counted after. */}
        <div className="flex items-baseline justify-between rounded-xl bg-slate-900 px-4 py-3 text-white">
          <span className="text-sm font-medium">
            {method === 'cash'
              ? paying
                ? 'Out of the drawer'
                : 'Into the drawer'
              : `${paying ? 'Paid' : 'Received'} by ${method}`}
          </span>
          <span className="tnum text-right font-semibold">
            <span className="block">{money(usd)}</span>
            {lbpAmount > 0 && (
              <span className="block text-sm font-normal text-slate-300">{lbp(lbpAmount)}</span>
            )}
          </span>
        </div>
        {rate > 0 && lbpAmount > 0 && usd > 0 && (
          <p className="-mt-1 text-xs text-slate-500">
            {money(combined)} altogether at today's rate.
          </p>
        )}
        {rate > 0 && usd > 0 && lbpAmount === 0 && (
          <p className="-mt-1 text-xs text-slate-500">{money(usd)} is about {lbp(toLbp(usd))} today.</p>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={busy} disabled={!ready}>
            {paying ? 'Pay it out' : 'Take it in'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Stat({ label: text, usd, lbpAmount, count, tone }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs text-slate-500">{text}</p>
      <p
        className={cx(
          'tnum mt-1 text-2xl font-semibold',
          tone === 'out' ? 'text-red-600' : tone === 'in' ? 'text-emerald-700' : 'text-slate-900',
        )}
      >
        {money(usd)}
      </p>
      <p className="tnum text-xs text-slate-400">
        {lbp(lbpAmount)}
        {count !== undefined && ` · ${count} voucher${count === 1 ? '' : 's'}`}
      </p>
    </Card>
  );
}

export default function Vouchers() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [preset, setPreset] = useState('month');
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [writing, setWriting] = useState(false);
  const [printing, setPrinting] = useState(null);
  const [moved, setMoved] = useState(0);

  const load = useCallback(async () => {
    const res = await api.get('/vouchers', {
      params: { preset, kind: kind || undefined, search: search.trim() || undefined },
    });
    setData(res.data);
  }, [preset, kind, search]);

  const loadMeta = useCallback(async () => {
    const res = await api.get('/vouchers/meta');
    setMeta(res.data);
  }, []);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    const id = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(id);
  }, [load, search]);

  async function cancel(voucher) {
    try {
      await api.post(`/vouchers/${voucher.id}/cancel`);
      toast(`${voucher.voucher_number} cancelled and the money put back`);
      setMoved((n) => n + 1);
      load();
      loadMeta();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not cancel that', 'error');
    }
  }

  const summary = data?.summary;
  const empty = useMemo(() => data && data.vouchers.length === 0, [data]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Vouchers"
        subtitle="Money paid out and taken in — who it went to, what for, and what the drawer did"
        actions={
          <Button onClick={() => setWriting(true)} disabled={!meta}>
            <ReceiptText size={16} /> New voucher
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {!data ? (
            <Skeleton className="h-64" />
          ) : (
            <>
              <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Stat
                  label="Paid out"
                  usd={summary.paidUsd}
                  lbpAmount={summary.paidLbp}
                  count={summary.payments}
                  tone="out"
                />
                <Stat
                  label="Taken in"
                  usd={summary.receivedUsd}
                  lbpAmount={summary.receivedLbp}
                  count={summary.receipts}
                  tone="in"
                />
                <Stat label="Net" usd={summary.netUsd} lbpAmount={summary.netLbp} />
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
                    placeholder="Number, name, reference or note…"
                    aria-label="Find a voucher"
                    className="h-10 w-full rounded-lg bg-white pr-3 pl-9 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                  />
                </div>
                <div className="w-36 shrink-0">
                  <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
                    <option value="">Both kinds</option>
                    <option value="payment">Payments</option>
                    <option value="receipt">Receipts</option>
                  </Select>
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
              </div>

              <Card>
                {empty ? (
                  <EmptyState
                    icon={ReceiptText}
                    title="No vouchers here"
                    description="Rent, wages, a supplier settled in cash, a customer paying off what they owe — each one written here moves the drawer with it."
                  />
                ) : (
                  <table className="w-full text-sm">
                    <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                      <tr>
                        <th className="px-5 py-2.5 font-medium">Number</th>
                        <th className="px-3 py-2.5 font-medium">Date</th>
                        <th className="px-3 py-2.5 font-medium">Account</th>
                        <th className="px-3 py-2.5 font-medium">What for</th>
                        <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                        <th className="hidden px-3 py-2.5 font-medium lg:table-cell">By</th>
                        <th className="px-5 py-2.5" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {data.vouchers.map((v) => {
                        const cancelled = v.status === 'cancelled';
                        const out = v.kind === 'payment';
                        return (
                          <tr key={v.id} className={cx('hover:bg-slate-50/60', cancelled && 'opacity-50')}>
                            {/* A number that wraps stops being a number you can
                                read across a counter. */}
                            <td className="px-5 py-2.5 font-mono text-xs font-medium whitespace-nowrap text-slate-700">
                              {v.voucher_number}
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap text-slate-500">{v.issued_on}</td>
                            <td className="max-w-[16rem] truncate px-3 py-2.5">
                              <Badge tone={out ? 'warning' : 'good'}>{out ? 'Out' : 'In'}</Badge>
                              <span className="ml-2 text-slate-800">{v.account_name}</span>
                              <span className="ml-1 text-xs text-slate-400">
                                {ACCOUNT_LABELS[v.account_type]}
                              </span>
                            </td>
                            <td className="max-w-[12rem] truncate px-3 py-2.5 text-slate-600">
                              {label(REASON_LABELS, v.reason) || '—'}
                              {v.note && <span className="ml-1 text-xs text-slate-400">{v.note}</span>}
                            </td>
                            <td
                              className={cx(
                                'tnum px-3 py-2.5 text-right font-semibold',
                                out ? 'text-red-600' : 'text-emerald-700',
                              )}
                            >
                              {v.amount_usd > 0 && <span className="block">{money(v.amount_usd)}</span>}
                              {v.amount_lbp > 0 && (
                                <span className="block text-xs font-normal text-slate-500">
                                  {lbp(v.amount_lbp)}
                                </span>
                              )}
                              {v.method !== 'cash' && (
                                <span className="block text-[11px] font-normal text-slate-400">
                                  {v.method}
                                </span>
                              )}
                            </td>
                            <td className="hidden px-3 py-2.5 whitespace-nowrap text-slate-500 lg:table-cell">
                              {v.user_name || '—'}
                            </td>
                            <td className="px-5 py-2.5 text-right whitespace-nowrap">
                              <button
                                onClick={() => setPrinting(v)}
                                aria-label={`Print ${v.voucher_number}`}
                                title="Print the slip"
                                className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                              >
                                <Printer size={15} />
                              </button>
                              {cancelled ? (
                                <Badge tone="neutral" className="ml-1">
                                  Cancelled
                                </Badge>
                              ) : (
                                <button
                                  onClick={() => cancel(v)}
                                  aria-label={`Cancel ${v.voucher_number}`}
                                  title="Cancel and put the money back"
                                  className="ml-1 rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
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
          * The drawer, beside the thing that empties it. Writing a voucher for
          * money you do not have is a mistake best caught before the money is
          * counted out, not at closing.
          */}
        <aside className="no-print w-[340px] shrink-0 overflow-y-auto border-l border-slate-200 bg-white">
          <CashBox refreshOn={moved} />
        </aside>
      </div>

      {writing && meta && (
        <VoucherDialog
          meta={meta}
          onClose={() => setWriting(false)}
          onSaved={(voucher) => {
            setWriting(false);
            setMoved((n) => n + 1);
            load();
            loadMeta();
            // Straight to the slip: a voucher exists to be signed.
            setPrinting(voucher);
          }}
        />
      )}

      {printing && <VoucherSlip voucher={printing} onClose={() => setPrinting(null)} />}
    </div>
  );
}

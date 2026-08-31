import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowLeftRight, Ban, Printer, ReceiptText, Search } from 'lucide-react';
import api from '../api';
import PageHeader from '../components/PageHeader';
import CashBox from '../components/CashBox';
import { useConfirm } from '../components/ConfirmProvider';
import VoucherSlip from '../components/VoucherSlip';
import { lbp, useSettings } from '../context/SettingsContext';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  ModalActions,
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
const TYPE_LABELS = {
  cash: 'Cash account',
  wallet: 'Wallet',
  customer: 'Customer',
  supplier: 'Supplier',
  transfer_company: 'Transfer agency',
  other: 'Someone else',
};

const REASON_LABELS = {
  supplier: 'Paying a supplier',
  customer: 'Customer paying',
  transfer_agency: 'Settling with a transfer agency',
  wages: 'Wages',
  rent: 'Rent',
  utilities: 'Utilities',
  owner_draw: 'Owner took money out',
  owner_funds: "Owner's money in",
  refund: 'Refund',
  deposit: 'Deposit',
  wallet_top_up: 'Buying credit',
  bank_drop: 'Moved to another till',
  other: 'Other',
};

const KIND_LABELS = { payment: 'Paid out', receipt: 'Taken in', transfer: 'Moved' };

const SIDE_TYPES = ['cash', 'wallet', 'customer', 'supplier', 'transfer_company', 'other'];

const label = (map, value) => map[value] || value;

/** The chosen account's name, for the running summary. */
function accountName(accounts, side) {
  if (side.type === 'other') return side.name.trim() || 'someone';
  const found = (accounts[side.type] || []).find((a) => String(a.id) === String(side.id));
  return found?.name || 'choose one';
}

/**
 * One end of a voucher.
 *
 * Two controls in the same order every time: what kind of account, then which
 * one. Naming somebody who is on no list is a kind too — the landlord and the
 * electrician are not each worth a contact record.
 */
function SidePicker({ legend, hint, accounts, value, onChange }) {
  const options = accounts[value.type] || [];

  return (
    <fieldset className="rounded-xl bg-slate-50 p-3">
      <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        {legend}
      </legend>
      <p className="mb-2 text-xs text-slate-500">{hint}</p>

      <div className="space-y-2">
        <Select
          aria-label={`${legend} — what kind`}
          value={value.type}
          onChange={(e) => onChange({ type: e.target.value, id: '', name: '' })}
        >
          {SIDE_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </Select>

        {value.type === 'other' ? (
          <Input
            aria-label={`${legend} — name`}
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            placeholder="The landlord, the electrician…"
          />
        ) : (
          <Select
            aria-label={`${legend} — which one`}
            value={value.id}
            onChange={(e) => onChange({ ...value, id: e.target.value })}
          >
            <option value="">Choose…</option>
            {options.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.balance === undefined
                  ? ''
                  : ` — ${a.currency === 'LBP' ? lbp(a.balance) : money(a.balance)}`}
              </option>
            ))}
          </Select>
        )}
      </div>
    </fieldset>
  );
}

/**
 * Writing one voucher.
 *
 * Both ends are named and the kind falls out of them: out of one of the shop's
 * own accounts into somebody else's is a payment, the reverse is a receipt, and
 * between two of its own it is neither — the money never left.
 */
function VoucherDialog({ meta, onClose, onSaved, prefill = null }) {
  const toast = useToast();
  const { rate, toLbp } = useSettings();

  const tills = meta.accounts.cash || [];
  const defaultTill = tills.find((t) => t.isDefault) || tills[0];

  /*
   * Arrived here from somewhere that already knows the answer.
   *
   * Settling with a transfer agency is the case: the balance says which way the
   * money goes and how much, and asking somebody to key all of that again — off
   * a figure that is on the screen behind this one — is how it gets keyed
   * wrong. Every field stays editable; they are filled in, not decided.
   */
  const till = { type: 'cash', id: defaultTill?.id ?? '', name: '' };
  const party = prefill ? { type: prefill.partyType, id: prefill.partyId, name: '' } : null;
  const paying = prefill?.direction === 'pay';

  const [from, setFrom] = useState(prefill ? (paying ? till : party) : till);
  const [to, setTo] = useState(prefill ? (paying ? party : till) : { type: 'other', id: '', name: '' });
  const [amountUsd, setAmountUsd] = useState(prefill?.amount || '');
  const [amountLbp, setAmountLbp] = useState('');
  const [reason, setReason] = useState(prefill ? 'transfer_agency' : 'rent');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [issuedOn, setIssuedOn] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const usd = Number(amountUsd) || 0;
  const lbpAmount = Number(amountLbp) || 0;

  const ours = (type) => type === 'cash' || type === 'wallet';
  const kind =
    ours(from.type) && ours(to.type)
      ? 'transfer'
      : ours(from.type)
        ? 'payment'
        : ours(to.type)
          ? 'receipt'
          : null;

  const named = (side) => (side.type === 'other' ? side.name.trim() : String(side.id || ''));
  const ready = Boolean((usd > 0 || lbpAmount > 0) && named(from) && named(to) && kind);

  /* Swapping is one press: half of these get written the wrong way round first,
     and retyping both ends is how a queue forms. */
  function swap() {
    setFrom(to);
    setTo(from);
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post('/vouchers', {
        fromType: from.type,
        fromId: from.type === 'other' ? null : Number(from.id) || null,
        fromName: from.type === 'other' ? from.name : null,
        toType: to.type,
        toId: to.type === 'other' ? null : Number(to.id) || null,
        toName: to.type === 'other' ? to.name : null,
        amountUsd: usd,
        amountLbp: lbpAmount,
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

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="New voucher"
      subtitle="Money never appears or vanishes — name the account it left and the one it reached"
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2">
          <SidePicker
            legend="From"
            hint="Where the money left"
            accounts={meta.accounts}
            value={from}
            onChange={setFrom}
          />
          <button
            type="button"
            onClick={swap}
            aria-label="Swap the two accounts"
            title="Swap"
            className="mt-12 rounded-lg p-2 text-slate-400 ring-1 ring-slate-200 transition hover:bg-slate-50 hover:text-slate-700"
          >
            <ArrowLeftRight size={16} />
          </button>
          <SidePicker
            legend="To"
            hint="Where it arrived"
            accounts={meta.accounts}
            value={to}
            onChange={setTo}
          />
        </div>

        {!kind && (
          <p className="text-xs text-amber-700">
            One end has to be the shop — a cash account or a wallet.
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
            label="Lebanese pounds (LBP)"
            name="amountLbp"
            type="number"
            min="0"
            step="1000"
            placeholder="0"
            value={amountLbp}
            onChange={(e) => setAmountLbp(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select label="What for" name="reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            {meta.reasons.map((r) => (
              <option key={r} value={r}>
                {label(REASON_LABELS, r)}
              </option>
            ))}
          </Select>
          <Input
            label="Reference"
            name="reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Invoice or cheque no."
          />
          <Input
            label="Date"
            name="issuedOn"
            type="date"
            value={issuedOn}
            onChange={(e) => setIssuedOn(e.target.value)}
          />
        </div>

        <Input
          label="Note"
          name="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. August rent"
        />

        {/* The sentence the voucher amounts to, before it is written. */}
        <div className="flex items-baseline justify-between gap-3 rounded-xl bg-slate-900 px-4 py-3 text-white">
          <span className="min-w-0 text-sm font-medium">
            {kind ? KIND_LABELS[kind] : 'Nowhere yet'}
            {kind && (
              <span className="block truncate text-xs font-normal text-slate-300">
                {accountName(meta.accounts, from)} → {accountName(meta.accounts, to)}
              </span>
            )}
          </span>
          <span className="tnum shrink-0 text-right font-semibold">
            <span className="block">{money(usd)}</span>
            {lbpAmount > 0 && (
              <span className="block text-sm font-normal text-slate-300">{lbp(lbpAmount)}</span>
            )}
          </span>
        </div>
        {rate > 0 && usd > 0 && lbpAmount === 0 && (
          <p className="-mt-1 text-xs text-slate-500">
            {money(usd)} is about {lbp(toLbp(usd))} today.
          </p>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={busy} disabled={!ready}>
            Record it
          </Button>
        </ModalActions>
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
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [preset, setPreset] = useState('month');
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [writing, setWriting] = useState(false);
  const [printing, setPrinting] = useState(null);
  const [moved, setMoved] = useState(0);
  const confirm = useConfirm();

  /*
   * "Settle up" on the transfers screen sends the whole thing here rather than
   * putting a second voucher form on that page. One desk writes the vouchers,
   * and it is this one.
   */
  const settle = params.get('settle');
  const prefill = settle
    ? {
        partyType: settle,
        partyId: params.get('partyId') || '',
        amount: params.get('amount') || '',
        direction: params.get('direction') || 'pay',
      }
    : null;

  useEffect(() => {
    if (prefill) setWriting(true);
    // Only when the link changes: reopening it on every render would make the
    // dialog impossible to close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settle, params.get('partyId')]);

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
    const agreed = await confirm({
      title: `Cancel ${voucher.voucher_number}?`,
      body: (
        <>
          The money goes back where it came from: {money(voucher.amount_usd)}
          {voucher.amount_lbp > 0 ? ` and ${lbp(voucher.amount_lbp)}` : ''} returns to{' '}
          <strong>{voucher.from_name}</strong>. The slip keeps its number and stays on the list,
          marked cancelled.
        </>
      ),
      confirmLabel: 'Cancel it and put the money back',
      cancelLabel: 'Leave it',
    });
    if (!agreed) return;

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

      {/*
        * A column on a monitor, stacked on a phone.
        *
        * The drawer panel used to be hidden outright below `lg`, which on a
        * handset meant a desk whose every action needs an open cashbox with no
        * way to open one. Stacked, it goes above the work instead of beside it.
        */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/*
         * `min-w-0` is doing real work here, and its absence was a bug.
         *
         * A flex child will not shrink below the width of its own content
         * unless it is told it may, so on a narrow window this column refused
         * to give way, the row grew wider than the screen and the table was
         * clipped off the left-hand edge with no way to scroll to it. The
         * table now scrolls inside its own column instead.
         */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
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
                    className="h-10 w-full rounded-lg bg-white pr-3 pl-9 text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none"
                  />
                </div>
                <div className="w-36 shrink-0">
                  <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
                    <option value="">Every kind</option>
                    <option value="payment">Payments</option>
                    <option value="receipt">Receipts</option>
                    <option value="transfer">Between own accounts</option>
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
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                    <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                      <tr>
                        <th className="px-5 py-2.5 font-medium">Number</th>
                        <th className="px-3 py-2.5 font-medium">Date</th>
                        <th className="px-3 py-2.5 font-medium">From → to</th>
                        <th className="px-3 py-2.5 font-medium">What for</th>
                        <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                        <th className="hidden px-3 py-2.5 font-medium lg:table-cell">By</th>
                        <th className="px-5 py-2.5" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-rule">
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
                            <td className="max-w-[20rem] truncate px-3 py-2.5">
                              <Badge tone={v.kind === 'payment' ? 'warning' : v.kind === 'receipt' ? 'good' : 'neutral'}>
                                {KIND_LABELS[v.kind]}
                              </Badge>
                              <span className="ml-2 text-slate-800">{v.from_name}</span>
                              <span className="mx-1 text-slate-300">→</span>
                              <span className="text-slate-800">{v.to_name}</span>
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
                  </div>
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
        <aside className="no-print order-first w-full shrink-0 overflow-y-auto border-b border-slate-200 bg-white lg:order-none lg:w-[300px] lg:border-b-0 lg:border-l xl:w-[340px]">
          <CashBox refreshOn={moved} />
        </aside>
      </div>

      {writing && meta && (
        <VoucherDialog
          meta={meta}
          prefill={prefill}
          onClose={() => {
            setWriting(false);
            setParams({});
          }}
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

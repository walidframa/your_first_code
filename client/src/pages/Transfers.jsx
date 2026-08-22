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
import TransferAgencies from '../components/TransferAgencies';
import { useConfirm } from '../components/ConfirmProvider';
import CashBox from '../components/CashBox';
import AddExpense from '../components/AddExpense';
import { lbp, useSettings } from '../context/SettingsContext';
import { useAuth } from '../context/AuthContext';
import { atTime, onDate } from '../lib/when';
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

/**
 * Sending and paying out, in one dialog.
 *
 * The two are the same form with the money going the other way, so they are one
 * dialog with the direction on top rather than two screens that would drift
 * apart. What changes underneath is only the wording — "hands over" against
 * "you pay out" — because that is the sentence the operator is living.
 */
function TransferDialog({ companies, tillId, tillName, onClose, onSaved }) {
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
        accountId: tillId,
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
      subtitle={`${
        sending
          ? 'The customer hands the money over and you keep the fee'
          : 'You count the money out to the customer'
      } · ${tillName}`}
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

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
              label="Lebanese pounds (LBP)"
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

        <ModalActions>
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
        </ModalActions>
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

/**
 * Which drawer this counter works out of.
 *
 * A transfer desk sharing the register's till is two people putting money in
 * one box: the cashier's float, the operator's sends and both of their payouts
 * land together, and at closing neither count means anything. Naming a drawer
 * here is what separates them, and it is the shop's decision rather than the
 * browser's — the money physically goes into one box or the other.
 */
function DeskTillDialog({ tills, deskTillId, onClose, onSaved }) {
  const toast = useToast();
  // A shop with one till is choosing to create a second; a shop with several is
  // choosing between them, and starts on the one it already uses.
  const [mode, setMode] = useState(tills.length > 1 ? 'pick' : 'new');
  const [pick, setPick] = useState(deskTillId ?? tills.find((t) => t.is_default)?.id ?? '');
  const [name, setName] = useState('Transfer desk');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = mode === 'new' ? { name } : { accountId: Number(pick) };
      const res = await api.put('/transfers/till', body);
      toast('The desk has its own drawer');
      onSaved(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not set that');
      setBusy(false);
    }
  }

  async function share() {
    setBusy(true);
    try {
      const res = await api.put('/transfers/till', { accountId: null });
      toast('The desk is back on the register’s drawer');
      onSaved(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not set that');
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="sm" title="The desk’s drawer">
      <form onSubmit={submit}>
        <p className="text-sm text-slate-600">
          Money the counter takes and pays out goes into this till. Give it one of its own and the
          register’s drawer stops carrying transfers — each is counted on its own at the end of the
          day.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          {[
            ['new', 'A new drawer', 'Opened for this desk'],
            ['pick', 'One that exists', 'Choose from the tills'],
          ].map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={cx(
                'rounded-xl px-3 py-2.5 text-left ring-1 transition',
                mode === value
                  ? 'bg-brand-50 ring-2 ring-brand-600'
                  : 'bg-white ring-slate-200 hover:bg-slate-50',
              )}
            >
              <span className="block text-sm font-semibold text-slate-900">{label}</span>
              <span className="block text-xs text-slate-500">{hint}</span>
            </button>
          ))}
        </div>

        <div className="mt-3">
          {mode === 'new' ? (
            <Input
              label="Call it"
              name="tillName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              hint="It appears wherever tills are listed, and is counted on its own"
              autoFocus
            />
          ) : (
            <Select
              label="Which till"
              name="deskTill"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
            >
              {tills.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          )}
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <ModalActions>
          {deskTillId && (
            <Button type="button" variant="ghost" onClick={share} disabled={busy}>
              Share the register’s
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Use it
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

export default function Transfers() {
  const toast = useToast();
  const { user, can } = useAuth();

  const [data, setData] = useState(null);
  const [companies, setCompanies] = useState(['OMT']);
  /*
   * The desk's own till. A transfer counter with its own float is why tills are
   * named at all, so the choice is on the screen rather than buried in settings.
   */
  const [tills, setTills] = useState([]);
  const [tillId, setTillId] = useState(() => Number(localStorage.getItem('pos_transfer_till')) || null);
  // The drawer the shop has given this desk, if it has given it one.
  const [deskTillId, setDeskTillId] = useState(null);
  const [choosingTill, setChoosingTill] = useState(false);
  const [preset, setPreset] = useState('today');
  const [search, setSearch] = useState('');
  const [mine, setMine] = useState(false);
  const [adding, setAdding] = useState(false);
  const [spending, setSpending] = useState(false);
  const confirm = useConfirm();
  // Bumped after anything that touches the till, so the drawer panel follows.
  const [moved, setMoved] = useState(0);

  const load = useCallback(async () => {
    const res = await api.get('/transfers', {
      params: { preset, search: search.trim(), mine: mine ? 'true' : undefined },
    });
    setData(res.data);
  }, [preset, search, mine]);

  useEffect(() => {
    api.get('/transfers/meta').then((res) => {
      setCompanies(res.data.companies);
      setTills(res.data.tills);
      setDeskTillId(res.data.deskTillId ?? null);
      /*
       * The shop's answer beats the browser's.
       *
       * Which drawer the money goes into is a fact about the counter, not a
       * preference of whoever last sat at it — so a desk with a till of its own
       * uses it everywhere. Without one, this falls back to what this browser
       * remembered and then to the default till, which is how it worked before
       * and is right for a shop with a single counter.
       */
      setTillId((current) => {
        if (res.data.deskTillId) return res.data.deskTillId;
        const known = res.data.tills.some((t) => t.id === current);
        return known ? current : (res.data.tills.find((t) => t.is_default) ?? res.data.tills[0])?.id ?? null;
      });
    });
  }, []);

  useEffect(() => {
    if (tillId) localStorage.setItem('pos_transfer_till', String(tillId));
  }, [tillId]);

  useEffect(() => {
    const id = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(id);
  }, [load, search]);

  async function cancel(transfer) {
    const agreed = await confirm({
      title: `Cancel this ${transfer.direction}?`,
      body: (
        <>
          The drawer goes back to where it was, and {transfer.company} stops carrying it. The
          transfer stays on the list marked cancelled — which is the row somebody will be asked
          about.
          {transfer.reference ? <span className="block mt-1">Reference {transfer.reference}.</span> : null}
        </>
      ),
      confirmLabel: 'Cancel the transfer',
      cancelLabel: 'Leave it',
    });
    if (!agreed) return;

    try {
      await api.post(`/transfers/${transfer.id}/cancel`);
      toast('Transfer cancelled and the money put back');
      setMoved((n) => n + 1);
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not cancel that', 'error');
    }
  }

  const tillName = tills.find((t) => t.id === tillId)?.name || 'the drawer';
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
            {/*
              * A desk with a drawer of its own says so and does not offer to
              * change it — that is the owner's to set. Without one, the old
              * per-browser picker stands, for a shop that runs two counters off
              * whichever till is free.
              */}
            {deskTillId ? (
              <span className="flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-slate-600">
                <Wallet size={13} className="text-slate-400" />
                {tillName}
              </span>
            ) : (
              tills.length > 1 && (
                <div className="w-44 shrink-0">
                  <Select
                    name="till"
                    aria-label="Which till"
                    value={tillId ?? ''}
                    onChange={(e) => setTillId(Number(e.target.value))}
                  >
                    {tills.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )
            )}
            {user?.role === 'admin' && (
              <Button variant="secondary" onClick={() => setChoosingTill(true)}>
                <Wallet size={16} /> {deskTillId ? 'Change the drawer' : 'Its own drawer'}
              </Button>
            )}

            {/*
              * The drawer, on the header rather than down a column of its own.
              *
              * It used to have a third of the screen to say one figure in, with
              * a paragraph under it explaining what the two buttons above were
              * for and a great deal of white space under that. On the shop's
              * laptop the whole right-hand side of this page was empty. The
              * same strip the register carries says it in a line, opens the
              * same cashbox, and gives the counter back its width.
              */}
            <CashBox refreshOn={moved} accountId={tillId} compact />
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

              {/*
               * What the shop stands at with each agency, above the day's own
               * list — because the balance is the thing somebody came to this
               * screen to check, and the transfers are how it got there.
               */}
              <TransferAgencies
                refreshKey={moved}
                tillId={tillId}
                tillName={tillName}
                onSettled={() => {
                  setMoved((n) => n + 1);
                  load();
                }}
              />

              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="relative min-w-[12rem] flex-1">
                  <Search
                    size={16}
                    className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Reference, name or phone…"
                    aria-label="Find a transfer"
                    className="h-10 w-full rounded-lg bg-white pr-3 pl-9 text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none"
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
                <label className="flex shrink-0 items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm text-slate-600 ring-1 ring-edge">
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
                  <div className="overflow-x-auto">
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
                              {atTime(t.created_at)}
                              <span className="ml-1 text-xs text-slate-400">
                                {onDate(t.created_at)}
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
                  </div>
                )}
              </Card>
            </>
          )}
        </div>

      </div>

      {choosingTill && (
        <DeskTillDialog
          tills={tills}
          deskTillId={deskTillId}
          onClose={() => setChoosingTill(false)}
          onSaved={({ tills: next, deskTillId: id }) => {
            setTills(next);
            setDeskTillId(id ?? null);
            setTillId(id ?? next.find((t) => t.is_default)?.id ?? null);
            setChoosingTill(false);
            setMoved((n) => n + 1);
          }}
        />
      )}

      {adding && (
        <TransferDialog
          companies={companies}
          tillId={tillId}
          tillName={tillName}
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

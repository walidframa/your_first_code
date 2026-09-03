import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, HandCoins, Plus, Wallet } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import CustomerPicker from '../../components/CustomerPicker';
import MoneyInput from '../../components/MoneyInput';
import WhatsAppButton from '../../components/WhatsAppButton';
import { lbp, useSettings } from '../../context/SettingsContext';
import { isoDay } from '../../lib/when';
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
} from '../../components/ui';
import { useConfirm } from '../../components/ConfirmProvider';

/* This device's calendar rather than UTC's, which is a different day for the
   first hours of every morning in Beirut — see lib/when.js. */
const today = () => isoDay();

/** A month from today, which is when a first instalment usually falls. */
function nextMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return isoDay(d);
}

/* ------------------------------------------------------------- new plan */

/**
 * Setting one up.
 *
 * The figure asked for is **what is left to pay**, not the price of the phone.
 * A deposit is taken at the counter as an ordinary sale, so by the time anybody
 * is here the down payment has already happened and scheduling it again would
 * be scheduling money that is in the till.
 */
function NewPlan({ onClose, onSaved }) {
  const toast = useToast();
  const { rate } = useSettings();
  const [customer, setCustomer] = useState(null);
  const [total, setTotal] = useState('');
  const [count, setCount] = useState('4');
  const [startDate, setStartDate] = useState(nextMonth);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const each = Number(total) > 0 && Number(count) > 0 ? Number(total) / Number(count) : 0;

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.post('/installments', {
        customerId: customer.id,
        total: Number(total),
        count: Number(count),
        startDate,
        note: note || null,
      });
      toast(`${customer.name} — ${count} payments set up`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not set that up');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="New plan" subtitle="Paying off what is already owed, month by month">
      <div className="space-y-3">
        <div>
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Customer</span>
          <CustomerPicker customer={customer} onChange={setCustomer} />
        </div>

        <MoneyInput
          label="Left to pay"
          name="total"
          value={total}
          onChange={setTotal}
          hint="What is still owed — the deposit was taken at the counter"
        />

        <div className="grid grid-cols-2 gap-3">
          <Select label="Payments" name="count" value={count} onChange={(e) => setCount(e.target.value)}>
            {[2, 3, 4, 5, 6, 8, 10, 12, 18, 24].map((n) => (
              <option key={n} value={n}>
                {n} months
              </option>
            ))}
          </Select>
          <Input
            label="First one due"
            name="startDate"
            type="date"
            value={startDate}
            min={today()}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>

        <Input
          label="What for (optional)"
          name="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. iPhone 13, 128GB"
        />

        {each > 0 && (
          <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-600">
            About <strong>{money(each)}</strong>
            {rate > 0 && <> ({lbp(Math.round(each * rate))})</>} a month for {count} months, starting{' '}
            {startDate}. The odd cents go on the first payment so every later one is the same.
          </p>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      <ModalActions>
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button
          className="flex-1"
          loading={busy}
          disabled={!customer || !(Number(total) > 0)}
          onClick={save}
        >
          Set it up
        </Button>
      </ModalActions>
    </Modal>
  );
}

/* --------------------------------------------------------------- payment */

function TakePayment({ plan, onClose, onDone }) {
  const toast = useToast();
  const suggested = plan.nextDue ? String(plan.nextDue.amount) : '';
  const [amount, setAmount] = useState(suggested);
  const [inCash, setInCash] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/installments/${plan.id}/payments`, {
        payments: [{ currency: 'USD', amount: Number(amount) }],
        inCash,
      });
      toast(`${money(res.data.allocated)} taken — ${money(res.data.plan.outstandingUsd)} left`);
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="sm" title={`Payment from ${plan.customer_name}`} subtitle={plan.note || undefined}>
      <MoneyInput label="How much" name="amount" value={amount} onChange={setAmount} />

      {/* Settling an account moves real notes; a transfer does not. */}
      <label className="mt-3 flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={inCash} onChange={(e) => setInCash(e.target.checked)} />
        Cash into the drawer
      </label>

      <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
        It comes off what {plan.customer_name} owes, and settles the earliest months first. Paying
        more than one month covers the next as well.
      </p>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <ModalActions>
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button className="flex-1" loading={busy} disabled={!(Number(amount) > 0)} onClick={save}>
          Take it
        </Button>
      </ModalActions>
    </Modal>
  );
}

/* ------------------------------------------------------------------ plan */

function PlanCard({ plan, onPay, onCancel }) {
  const { rate } = useSettings();
  const late = plan.overdueCount > 0;
  const done = plan.status === 'settled';
  const paidShare = plan.paidUsd + plan.outstandingUsd > 0
    ? plan.paidUsd / (plan.paidUsd + plan.outstandingUsd)
    : 0;

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-slate-900">{plan.customer_name}</p>
          <p className="truncate text-xs text-slate-500">
            {plan.note || plan.order_number || 'Instalment plan'}
          </p>
        </div>
        {done ? (
          <Badge tone="good">Paid off</Badge>
        ) : plan.status === 'cancelled' ? (
          <Badge>Stopped</Badge>
        ) : late ? (
          <Badge tone="critical">
            {plan.overdueCount} late
          </Badge>
        ) : (
          <Badge tone="good">On track</Badge>
        )}
      </div>

      <p className="tnum mt-3 text-2xl font-semibold text-slate-900">
        {money(plan.outstandingUsd)}
        <span className="ml-1.5 text-xs font-normal text-slate-400">left of {money(plan.total_usd)}</span>
      </p>
      {rate > 0 && plan.outstandingUsd > 0 && (
        <p className="tnum text-xs text-slate-400">{lbp(Math.round(plan.outstandingUsd * rate))}</p>
      )}

      {/* How far through, at a glance — a dozen plans read as a wall of numbers
          otherwise. */}
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div
          className={cx('h-full rounded-full', late ? 'bg-red-500' : 'bg-brand-600')}
          style={{ width: `${Math.round(paidShare * 100)}%` }}
        />
      </div>

      <p className={cx('mt-2 text-xs', late ? 'font-medium text-red-600' : 'text-slate-500')}>
        {done
          ? 'Nothing outstanding'
          : late
            ? `${money(plan.overdueUsd)} past due`
            : plan.nextDue
              ? `Next ${money(plan.nextDue.amount)} on ${plan.nextDue.date}`
              : 'Nothing scheduled'}
      </p>

      {plan.status === 'active' && (
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" className="flex-1" onClick={() => onPay(plan)}>
            <Wallet size={15} /> Take a payment
          </Button>
          <WhatsAppButton
            path={`/installments/${plan.id}/whatsapp`}
            label="Remind"
            size="sm"
          />
          <button
            onClick={() => onCancel(plan)}
            title="Stop chasing this plan"
            className="rounded-lg px-2 py-1.5 text-xs font-medium text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            Stop
          </button>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ page */

export default function Installments() {
  const toast = useToast();
  const [plans, setPlans] = useState(null);
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState(null);
  const [filter, setFilter] = useState('active');

  const load = useCallback(async () => {
    const res = await api.get('/installments');
    setPlans(res.data.plans);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(() => {
    if (!plans) return null;
    if (filter === 'late') return plans.filter((p) => p.status === 'active' && p.overdueCount > 0);
    if (filter === 'active') return plans.filter((p) => p.status === 'active');
    return plans;
  }, [plans, filter]);

  const owed = (plans || [])
    .filter((p) => p.status === 'active')
    .reduce((sum, p) => sum + p.outstandingUsd, 0);
  const late = (plans || []).filter((p) => p.status === 'active' && p.overdueCount > 0);
  const lateUsd = late.reduce((sum, p) => sum + p.overdueUsd, 0);

  const confirm = useConfirm();

  async function cancel(plan) {
    /*
     * A browser prompt looks like a scam warning on a shop tablet and cannot be
     * read in Arabic. Same question, asked by the app.
     */
    const agreed = await confirm({
      title: `Stop chasing ${plan.customer_name}'s plan?`,
      body: 'The instalments stop being tracked. What they owe does not change — it stays on their account.',
      confirmLabel: 'Stop the plan',
      cancelLabel: 'Keep chasing it',
      tone: 'warning',
    });
    if (!agreed) return;
    await api.post(`/installments/${plan.id}/cancel`);
    toast('Plan stopped');
    load();
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Instalments"
        subtitle="Phones paid off over months, and who is behind"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> New plan
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {/*
          * What is out there, and what is late. The second number is the one
          * worth acting on, so it is the one that goes red.
          */}
        <div className="mb-4 grid max-w-2xl grid-cols-2 gap-4">
          <Card className="p-4">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
              <HandCoins size={13} /> Out on plans
            </p>
            <p className="tnum mt-1 text-2xl font-semibold text-slate-900">{money(owed)}</p>
          </Card>
          <Card className="p-4">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
              <CalendarClock size={13} /> Past due
            </p>
            <p
              className={cx(
                'tnum mt-1 text-2xl font-semibold',
                lateUsd > 0 ? 'text-red-600' : 'text-slate-900',
              )}
            >
              {money(lateUsd)}
            </p>
            {late.length > 0 && (
              <p className="text-xs text-red-600">
                {late.length} customer{late.length === 1 ? '' : 's'} behind
              </p>
            )}
          </Card>
        </div>

        <div className="mb-4 flex gap-2">
          {[
            ['active', 'Running'],
            ['late', 'Behind'],
            ['all', 'Everything'],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              className={cx(
                'rounded-lg px-3 py-1.5 text-sm font-medium transition',
                filter === id ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {!shown ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-44" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title={filter === 'late' ? 'Nobody is behind' : 'No plans yet'}
            description={
              filter === 'late'
                ? 'Every running plan is up to date.'
                : 'Set one up when a customer takes a phone and pays for it over months.'
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((plan) => (
              <PlanCard key={plan.id} plan={plan} onPay={setPaying} onCancel={cancel} />
            ))}
          </div>
        )}
      </div>

      {creating && (
        <NewPlan
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
          }}
        />
      )}
      {paying && (
        <TakePayment
          plan={paying}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            load();
          }}
        />
      )}
    </div>
  );
}

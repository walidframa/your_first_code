import { useCallback, useEffect, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Building2,
  Pencil,
  Plus,
  Search,
  Users as UsersIcon,
} from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { useSettings, lbp } from '../../context/SettingsContext';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  Skeleton,
  cx,
  money,
  useToast,
} from '../../components/ui';

const KIND_LABELS = {
  sale: 'Sale on account',
  payment: 'Payment',
  refund: 'Refund',
  bill: 'Bill',
  adjustment: 'Charge',
  opening: 'Opening balance',
};

/** Config for the two flavours of this page. */
const CONFIG = {
  customer: {
    path: 'customers',
    title: 'Customers',
    subtitle: 'Balances, credit limits and payments received',
    single: 'customer',
    icon: UsersIcon,
    hasCreditLimit: true,
    owesLabel: 'Owes you',
    creditLabel: 'In credit',
    paymentTitle: 'Record payment received',
    chargeTitle: 'Add a charge',
    totalLabel: 'Total owed to you',
  },
  supplier: {
    path: 'suppliers',
    title: 'Suppliers',
    subtitle: 'What you owe, bills and payments made',
    single: 'supplier',
    icon: Building2,
    hasCreditLimit: false,
    owesLabel: 'You owe',
    creditLabel: 'In credit',
    paymentTitle: 'Record payment made',
    chargeTitle: 'Add a bill',
    totalLabel: 'Total you owe',
  },
};

function BalanceBadge({ balance, config }) {
  if (Math.abs(balance) < 0.005) return <Badge tone="neutral">Settled</Badge>;
  if (balance > 0) return <Badge tone="warning">{config.owesLabel} {money(balance)}</Badge>;
  return <Badge tone="good">{config.creditLabel} {money(-balance)}</Badge>;
}

function PartyForm({ party, config, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: party?.name || '',
    phone: party?.phone || '',
    email: party?.email || '',
    address: party?.address || '',
    notes: party?.notes || '',
    credit_limit: party?.credit_limit ?? 0,
    opening_balance: 0,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    const payload = {
      ...form,
      credit_limit: Number(form.credit_limit) || 0,
      opening_balance: Number(form.opening_balance) || 0,
    };
    try {
      if (party) await api.put(`/${config.path}/${party.id}`, payload);
      else await api.post(`/${config.path}`, payload);
      toast(party ? 'Saved' : `${config.single === 'customer' ? 'Customer' : 'Supplier'} added`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={party ? `Edit ${config.single}` : `New ${config.single}`} size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Name" value={form.name} onChange={set('name')} required autoFocus className="col-span-2" />
          <Input label="Phone" value={form.phone} onChange={set('phone')} />
          <Input label="Email" type="email" value={form.email} onChange={set('email')} />
          <Input label="Address" value={form.address} onChange={set('address')} className="col-span-2" />
          {config.hasCreditLimit && (
            <Input
              label="Credit limit (USD)"
              type="number"
              min="0"
              step="0.01"
              value={form.credit_limit}
              onChange={set('credit_limit')}
              hint="0 means no credit — account sales will be refused"
            />
          )}
          {!party && (
            <Input
              label="Opening balance (USD)"
              type="number"
              step="0.01"
              value={form.opening_balance}
              onChange={set('opening_balance')}
              hint="Carry over an existing balance, if any"
            />
          )}
          <Input label="Notes" value={form.notes} onChange={set('notes')} className="col-span-2" />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            {party ? 'Save changes' : 'Add'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function MoneyModal({ party, config, mode, onClose, onSaved }) {
  const toast = useToast();
  const { rate, toLbp } = useSettings();
  const [usd, setUsd] = useState('');
  const [lbpAmount, setLbpAmount] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isPayment = mode === 'payment';
  const totalUsd = isPayment ? Number(usd || 0) + (rate ? Number(lbpAmount || 0) / rate : 0) : Number(amount || 0);
  const valid = totalUsd > 0;

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      if (isPayment) {
        const payments = [];
        if (Number(usd) > 0) payments.push({ currency: 'USD', amount: Number(usd) });
        if (Number(lbpAmount) > 0) payments.push({ currency: 'LBP', amount: Number(lbpAmount) });
        await api.post(`/${config.path}/${party.id}/payments`, { payments, note: note || null });
      } else {
        await api.post(`/${config.path}/${party.id}/charges`, {
          amount: Number(amount),
          note: note || null,
        });
      }
      toast(isPayment ? 'Payment recorded' : 'Charge recorded');
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isPayment ? config.paymentTitle : config.chargeTitle}
      subtitle={party.name}
    >
      <form onSubmit={submit} className="space-y-4">
        {isPayment ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Input label="US dollars" type="number" min="0" step="0.01" value={usd} onChange={(e) => setUsd(e.target.value)} />
              <Input label="Lebanese pounds" type="number" min="0" step="1000" value={lbpAmount} onChange={(e) => setLbpAmount(e.target.value)} />
            </div>
            {totalUsd > 0 && (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
                Total <span className="font-medium text-slate-900">{money(totalUsd)}</span>
                {rate > 0 && <> · {lbp(toLbp(totalUsd))}</>}
              </p>
            )}
          </>
        ) : (
          <>
            <Input label="Amount (USD)" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus />
            {totalUsd > 0 && rate > 0 && (
              <p className="text-sm text-slate-500">≈ {lbp(toLbp(totalUsd))}</p>
            )}
          </>
        )}

        <Input label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Invoice 88" />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={!valid} loading={saving}>
            Record {money(totalUsd)}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PartyDetail({ partyId, config, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [money_, setMoneyModal] = useState(null);

  const load = useCallback(() => {
    api.get(`/${config.path}/${partyId}`).then((res) => setData(res.data));
  }, [config.path, partyId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) {
    return (
      <Modal open onClose={onClose} title="Loading…">
        <Skeleton className="h-40" />
      </Modal>
    );
  }

  const { party, entries } = data;

  return (
    <>
      <Modal open onClose={onClose} title={party.name} subtitle={party.phone || party.email || ''} size="lg">
        <div className="mb-4 flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3">
          <div>
            <p className="text-xs text-slate-500">Balance</p>
            <p
              className={cx(
                'text-2xl font-semibold',
                party.balance > 0.005 ? 'text-amber-700' : party.balance < -0.005 ? 'text-brand-700' : 'text-slate-900',
              )}
            >
              {money(Math.abs(party.balance))}
            </p>
            <p className="text-xs text-slate-500">
              {party.balance > 0.005 ? config.owesLabel : party.balance < -0.005 ? config.creditLabel : 'Settled'}
              {config.hasCreditLimit && ` · limit ${money(party.credit_limit)}`}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setMoneyModal('charge')}>
              <Plus size={13} /> {config.single === 'customer' ? 'Charge' : 'Bill'}
            </Button>
            <Button size="sm" onClick={() => setMoneyModal('payment')}>
              <Banknote size={14} /> Payment
            </Button>
          </div>
        </div>

        {entries.length === 0 ? (
          <EmptyState title="No activity yet" description="Sales, bills and payments will appear here." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {entries.map((e) => (
              <li key={e.id} className="flex items-start gap-3 py-2.5">
                <div
                  className={cx(
                    'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
                    e.amount_usd > 0 ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700',
                  )}
                >
                  {e.amount_usd > 0 ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-800">
                    {KIND_LABELS[e.kind] || e.kind}
                    <span className="tnum ml-2 font-normal text-slate-500">
                      {e.amount_usd > 0 ? '+' : ''}
                      {money(e.amount_usd)}
                    </span>
                  </p>
                  <p className="text-xs text-slate-400">
                    {e.created_at}
                    {e.order_number ? ` · ${e.order_number}` : ''}
                    {e.paid_lbp > 0 ? ` · ${lbp(e.paid_lbp)}` : ''}
                    {e.note && !e.order_number ? ` · ${e.note}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      {money_ && (
        <MoneyModal
          party={party}
          config={config}
          mode={money_}
          onClose={() => setMoneyModal(null)}
          onSaved={() => {
            setMoneyModal(null);
            load();
            onChanged();
          }}
        />
      )}
    </>
  );
}

export default function Parties({ type }) {
  const config = CONFIG[type];
  const [parties, setParties] = useState(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(undefined);
  const [viewing, setViewing] = useState(null);

  const load = useCallback(() => {
    api.get(`/${config.path}`).then((res) => setParties(res.data.parties));
  }, [config.path]);

  useEffect(() => {
    setParties(null);
    load();
  }, [load]);

  const term = search.trim().toLowerCase();
  const visible = (parties || []).filter(
    (p) =>
      !term ||
      p.name.toLowerCase().includes(term) ||
      (p.phone || '').includes(term) ||
      (p.email || '').toLowerCase().includes(term),
  );

  const outstanding = (parties || []).reduce((sum, p) => sum + Math.max(0, p.balance), 0);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={config.title}
        subtitle={config.subtitle}
        actions={
          <Button onClick={() => setEditing(null)}>
            <Plus size={16} /> New {config.single}
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <Card className="mb-4 px-5 py-4">
          <p className="text-xs text-slate-500">{config.totalLabel}</p>
          <p className="mt-1 text-3xl font-semibold text-slate-900">{money(outstanding)}</p>
          <p className="mt-0.5 text-xs text-slate-400">
            {(() => {
              const owing = (parties || []).filter((p) => p.balance > 0.005).length;
              const all = (parties || []).length;
              if (all === 0) return `No ${config.single}s yet`;
              if (owing === 0) return `Every ${config.single} is square`;
              return `across ${owing} of ${all} ${all === 1 ? config.single : `${config.single}s`}`;
            })()}
          </p>
        </Card>

        <Card>
          <div className="border-b border-slate-100 px-5 py-3">
            <div className="relative">
              <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, phone or email…"
                className="h-9 w-full rounded-lg bg-slate-100 pr-3 pl-9 text-sm ring-1 ring-transparent transition focus:bg-white focus:ring-brand-600 focus:outline-none"
              />
            </div>
          </div>

          {!parties ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={config.icon}
              title={`No ${config.path}`}
              description={term ? 'Nothing matches your search.' : `Add your first ${config.single}.`}
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Name</th>
                  <th className="px-3 py-2.5 font-medium">Contact</th>
                  {config.hasCreditLimit && <th className="px-3 py-2.5 text-right font-medium">Limit</th>}
                  <th className="px-3 py-2.5 font-medium">Balance</th>
                  <th className="px-5 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {visible.map((p) => (
                  <tr key={p.id} className="cursor-pointer hover:bg-slate-50/60" onClick={() => setViewing(p.id)}>
                    <td className="px-5 py-2.5 font-medium text-slate-800">{p.name}</td>
                    <td className="px-3 py-2.5 text-slate-500">{p.phone || p.email || '—'}</td>
                    {config.hasCreditLimit && (
                      <td className="tnum px-3 py-2.5 text-right text-slate-500">{money(p.credit_limit)}</td>
                    )}
                    <td className="px-3 py-2.5">
                      <BalanceBadge balance={p.balance} config={config} />
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(p);
                        }}
                        aria-label={`Edit ${p.name}`}
                      >
                        <Pencil size={14} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {editing !== undefined && (
        <PartyForm
          party={editing}
          config={config}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
        />
      )}

      {viewing && (
        <PartyDetail partyId={viewing} config={config} onClose={() => setViewing(null)} onChanged={load} />
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Building2,
  FileText,
  Pencil,
  Plus,
  Search,
  Trash2,
  Undo2,
  Users as UsersIcon,
} from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import AccountStatement from '../../components/AccountStatement';
import { useSettings, lbp } from '../../context/SettingsContext';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  ModalActions,
  Skeleton,
  cx,
  money,
  useToast,
} from '../../components/ui';

/** What each kind of dealing is called, in the shop's own words. */
const DEALING_LABELS = {
  order: 'Sale',
  quotation: 'Quotation',
  sales_invoice: 'Sales invoice',
  purchase_invoice: 'Purchase invoice',
  sales_order: 'Sales order',
  repair: 'Repair',
};

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

        <ModalActions>
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            {party ? 'Save changes' : 'Add'}
          </Button>
        </ModalActions>
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

        <ModalActions>
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={!valid} loading={saving}>
            Record {money(totalUsd)}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/**
 * The invoice or sale a ledger line came out of, if there is one.
 *
 * Entries carry `order_id` for a register sale, and for a document they carry
 * its number in the note — "Edited SI-0001", "SI-0001 — paid cash". So the
 * dealings already fetched are the lookup table: match on the order, or on a
 * reference appearing in the note.
 *
 * An opening balance or a hand-typed charge belongs to nothing, and gets no
 * pointer rather than a dead one.
 */
function sourceOf(entry, dealings) {
  if (entry.order_id) {
    const order = dealings.find((d) => d.kind === 'order' && d.id === entry.order_id);
    if (order) return order;
  }
  const note = String(entry.note || '');
  return dealings.find((d) => d.reference && note.includes(d.reference)) || null;
}

/**
 * What was actually on an invoice or a sale.
 *
 * A ledger line says a hundred and twenty-eight dollars changed hands. The
 * question that follows is always the same — *on what?* — and until now the
 * answer meant leaving this screen, remembering a document number, and finding
 * it on another one.
 *
 * Fetched when it is opened rather than with the list: a customer with two
 * years of history would otherwise pull every line of every invoice down to
 * show ten rows, and nobody opens more than one of these at a time.
 */
function DealingItems({ dealing, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const url = dealing.kind === 'order' ? `/orders/${dealing.id}` : `/documents/${dealing.id}`;
    api
      .get(url)
      .then((res) => setData(res.data))
      .catch((err) => {
        /*
         * Two quite different 403s reach here, and the server already words the
         * one worth repeating — "Quotes and invoices is not part of this shop's
         * plan." The other is a cashier opening a sale one of their colleagues
         * rang up, where "Insufficient permissions" says nothing about what
         * actually happened.
         */
        const said = err.response?.data?.error;
        setError(
          err.response?.status === 403 && said === 'Insufficient permissions'
            ? 'This was rung up by somebody else. Only the cashier who sold it, or an admin, can see what was on it.'
            : said || 'Could not open it',
        );
      });
  }, [dealing]);

  const items = data?.items || [];

  return (
    <Modal
      open
      onClose={onClose}
      title={`${DEALING_LABELS[dealing.kind] || dealing.kind} ${dealing.reference || ''}`}
      subtitle={String(dealing.at || '').slice(0, 16).replace('T', ' ')}
      size="lg"
    >
      {error ? (
        <p className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</p>
      ) : !data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
              <tr>
                <th className="py-2 font-medium">Item</th>
                <th className="w-16 py-2 text-right font-medium">Qty</th>
                <th className="w-24 py-2 text-right font-medium">Price</th>
                <th className="w-24 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {items.map((i) => (
                <tr key={i.id}>
                  <td className="py-2">
                    <span className="text-slate-800">{i.name}</span>
                    {i.sku && <span className="ml-2 text-xs text-slate-400">{i.sku}</span>}
                    {/* A line sent back is not the same as a line that never
                        happened, so it is shown rather than removed. */}
                    {i.returned_qty > 0 && (
                      <span className="ml-2 text-xs text-amber-700">
                        {i.returned_qty} returned
                      </span>
                    )}
                  </td>
                  <td className="tnum py-2 text-right text-slate-600">{i.quantity}</td>
                  <td className="tnum py-2 text-right text-slate-600">{money(i.price)}</td>
                  <td className="tnum py-2 text-right font-medium text-slate-800">
                    {money(i.line_total ?? i.lineTotal ?? i.price * i.quantity)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && (
            <EmptyState title="Nothing on it" description="This one carries no lines." />
          )}
        </>
      )}
    </Modal>
  );
}

function PartyDetail({ partyId, config, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [money_, setMoneyModal] = useState(null);
  // The invoice or sale somebody has asked to look inside.
  const [opening, setOpening] = useState(null);
  const [statement, setStatement] = useState(false);

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

  const { party, entries, dealings = [] } = data;

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
            {/*
              * The page somebody can be handed. Everything below is on it —
              * this screen answers "what has happened?", and the statement is
              * the same facts arranged so the person they are about can check
              * them line by line and disagree with one.
              */}
            <Button size="sm" variant="secondary" onClick={() => setStatement(true)}>
              <FileText size={14} /> Statement
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setMoneyModal('charge')}>
              <Plus size={13} /> {config.single === 'customer' ? 'Charge' : 'Bill'}
            </Button>
            <Button size="sm" onClick={() => setMoneyModal('payment')}>
              <Banknote size={14} /> Payment
            </Button>
          </div>
        </div>

        {/*
          * What was done with them, and what is owed, are two different
          * questions and both get asked. The ledger below only ever holds
          * money that was *owed* or settled, so a customer who paid cash at
          * the counter appears nowhere in it — which is why "show me
          * everything I have done with this customer" needed its own list.
          */}
        {dealings.length > 0 && (
          <div className="mb-4">
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Sales, invoices, quotations and repairs
            </h3>
            <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-xl ring-1 ring-slate-200">
              {dealings.map((d) => (
                <li key={`${d.kind}-${d.id}`}>
                  {/*
                    * A repair is not a document with lines on it, so it opens
                    * on the repairs board rather than in the what-was-on-it
                    * dialog. Searching by the ticket number lands on the one
                    * ticket whatever the board is filtered to.
                    */}
                  <Link
                    to={
                      d.kind === 'repair'
                        ? `/admin/repairs?q=${encodeURIComponent(d.reference)}`
                        : ''
                    }
                    onClick={(e) => {
                      if (d.kind === 'repair') return;
                      e.preventDefault();
                      setOpening(d);
                    }}
                    title={
                      d.kind === 'repair'
                        ? `Open ${d.reference} on the repairs board`
                        : `Show what was on ${d.reference || 'this'}`
                    }
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50"
                  >
                    <span className="w-28 shrink-0 truncate font-medium text-slate-700">
                      {DEALING_LABELS[d.kind] || d.kind}
                    </span>
                    <span className="w-24 shrink-0 truncate text-xs text-slate-500">{d.reference}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
                      {String(d.at).slice(0, 16).replace('T', ' ')}
                      {d.who ? ` · ${d.who}` : ''}
                      {/* A refunded sale still happened; saying so is the point
                          of a history. */}
                      {d.status && d.status !== 'confirmed' && d.status !== 'completed'
                        ? ` · ${d.status}`
                        : ''}
                      {d.onAccount ? ' · on account' : ''}
                    </span>
                    <span className="tnum shrink-0 font-medium text-slate-800">{money(d.total)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
          Money owed and paid
        </h3>
        {entries.length === 0 ? (
          <EmptyState title="Nothing on account" description="Charges and payments will appear here." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {entries.map((e) => {
              const source = sourceOf(e, dealings);
              /*
               * Only the rows that lead somewhere become buttons. A row that
               * looks clickable and does nothing is worse than a row that
               * looks like text — and an opening balance leads nowhere, so it
               * stays a plain row rather than a button that shrugs.
               */
              const Row = source ? 'button' : 'div';
              const rowProps = source
                ? {
                    type: 'button',
                    onClick: () => setOpening(source),
                    title: `Show what was on ${source.reference}`,
                  }
                : {};
              return (
                <li key={e.id}>
                  <Row
                    {...rowProps}
                    className={cx(
                      'flex w-full items-start gap-3 py-2.5 text-left',
                      source && 'cursor-pointer rounded-lg hover:bg-slate-50',
                    )}
                  >
                    <div
                      className={cx(
                        'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
                        e.amount_usd > 0
                          ? 'bg-amber-50 text-amber-700'
                          : 'bg-emerald-50 text-emerald-700',
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
                  </Row>
                </li>
              );
            })}
          </ul>
        )}
      </Modal>

      {opening && <DealingItems dealing={opening} onClose={() => setOpening(null)} />}

      {statement && (
        <AccountStatement
          partyType={config.single}
          partyId={party.id}
          name={party.name}
          onClose={() => setStatement(false)}
        />
      )}

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


/**
 * Removing somebody, and putting them back.
 *
 * "Delete" is archiving, and the difference matters: their name is on invoices
 * and on ledger entries that have to keep adding up. Wiping the row would take
 * the name off a sale that happened and leave a hole in the books.
 *
 * The server refuses outright while there is money outstanding either way,
 * which is the case where filing somebody away is how a debt gets quietly
 * forgotten. That message is shown as it comes back rather than translated
 * into something vaguer.
 */
function RemoveParty({ party, restore, config, onClose, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function go() {
    setError('');
    setBusy(true);
    try {
      if (restore) await api.put(`/${config.path}/${party.id}`, { active: true });
      else await api.delete(`/${config.path}/${party.id}`);
      toast(restore ? `${party.name} is back` : `${party.name} removed`);
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not do that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={restore ? `Bring back ${party.name}?` : `Remove ${party.name}?`}
      subtitle={config.single === 'customer' ? 'Customer' : 'Supplier'}
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          {restore
            ? `They will show in the list again and can be picked at the counter.`
            : `They will be taken out of the list and can no longer be picked at the counter. Nothing is deleted — every sale, bill and payment keeps their name, and you can bring them back at any time.`}
        </p>

        {!restore && Math.abs(party.balance) > 0.005 && (
          <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
            This {config.single} is not settled — {config.owesLabel.toLowerCase()}{' '}
            {money(Math.abs(party.balance))}. Settle it first; the shop will refuse otherwise.
          </p>
        )}

        {error && (
          <p className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}

        <ModalActions>
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button
            type="button"
            onClick={go}
            loading={busy}
            variant={restore ? 'primary' : 'danger'}
            className="flex-1"
          >
            {restore ? 'Bring back' : 'Remove'}
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}

export default function Parties({ type }) {
  const config = CONFIG[type];
  /*
   * Arrived here from somewhere else in the app, pointing at one person.
   *
   * An employee's screen links to their account, and a link that lands on a
   * list of two hundred names and leaves you to find the one you clicked is not
   * a link. The id is read once, on arrival, and cleared from the address so
   * closing the card does not reopen it.
   */
  const [params, setParams] = useSearchParams();
  const [parties, setParties] = useState(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(undefined);
  const [viewing, setViewing] = useState(() => {
    const id = Number(params.get('id'));
    return Number.isFinite(id) && id > 0 ? id : null;
  });

  useEffect(() => {
    if (params.get('id')) {
      const next = new URLSearchParams(params);
      next.delete('id');
      setParams(next, { replace: true });
    }
    // Once, on arrival — a later change of `params` is this effect's own doing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The one being removed or brought back, waiting on an answer.
  const [removing, setRemoving] = useState(null);
  /*
   * Archived ones are out of the way by default.
   *
   * A shop that has been open two years has a list of people who bought one
   * charger in 2024, and the list is meant to be the ones you deal with. They
   * are one toggle away rather than gone, because "removed" here means filed,
   * not deleted — their invoices still name them.
   */
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(() => {
    api
      .get(`/${config.path}`, { params: showArchived ? { includeArchived: 'true' } : {} })
      .then((res) => setParties(res.data.parties));
  }, [config.path, showArchived]);

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
          <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-3">
            <div className="relative flex-1">
              <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, phone or email…"
                className="h-9 w-full rounded-lg bg-slate-100 pr-3 pl-9 text-sm ring-1 ring-transparent transition focus:bg-white focus:ring-brand-600 focus:outline-none"
              />
            </div>
            {/* Off by default: this list is the people you deal with, not
                everyone who ever bought a charger. */}
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-slate-500">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Show removed
            </label>
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
                  <tr
                    key={p.id}
                    className={cx(
                      'cursor-pointer hover:bg-slate-50/60',
                      p.active === false && 'bg-slate-50/70 text-slate-400',
                    )}
                    onClick={() => setViewing(p.id)}
                  >
                    <td className="px-5 py-2.5 font-medium text-slate-800">
                      <span className={cx(p.active === false && 'text-slate-400 line-through')}>
                        {p.name}
                      </span>
                      {p.active === false && (
                        <Badge tone="neutral" className="ml-2">
                          Removed
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-slate-500">{p.phone || p.email || '—'}</td>
                    {config.hasCreditLimit && (
                      <td className="tnum px-3 py-2.5 text-right text-slate-500">{money(p.credit_limit)}</td>
                    )}
                    <td className="px-3 py-2.5">
                      <BalanceBadge balance={p.balance} config={config} />
                    </td>
                    <td className="px-5 py-2.5 text-right whitespace-nowrap">
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
                      {p.active === false ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRemoving({ party: p, restore: true });
                          }}
                          aria-label={`Bring ${p.name} back`}
                        >
                          <Undo2 size={14} />
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRemoving({ party: p, restore: false });
                          }}
                          aria-label={`Remove ${p.name}`}
                        >
                          <Trash2 size={14} className="text-red-600" />
                        </Button>
                      )}
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

      {removing && (
        <RemoveParty
          party={removing.party}
          restore={removing.restore}
          config={config}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null);
            load();
          }}
        />
      )}
    </div>
  );
}

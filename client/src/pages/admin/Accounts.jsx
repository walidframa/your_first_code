import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Banknote,
  Building2,
  Contact,
  CreditCard,
  Pencil,
  Plus,
  Star,
  Trash2,
  Wallet as WalletIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { lbp, useSettings } from '../../context/SettingsContext';
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

/*
 * Four kinds of account, and what a balance means is different for each. Saying
 * so on the screen is the difference between a list of numbers and a list
 * somebody can act on.
 */
const SECTIONS = [
  {
    type: 'cash',
    title: 'Cash accounts',
    blurb: 'Money the shop physically has — a drawer, a desk float, the safe',
    icon: Banknote,
    manageHere: true,
  },
  {
    type: 'wallet',
    title: 'Wallets',
    blurb: 'Credit held with a supplier, spent whenever one of its cards sells',
    icon: CreditCard,
    to: '/admin/cards',
  },
  {
    type: 'customer',
    title: 'Customers',
    blurb: 'A positive balance is what they owe the shop',
    icon: Contact,
    to: '/admin/customers',
  },
  {
    type: 'supplier',
    title: 'Suppliers',
    blurb: 'A positive balance is what the shop owes them',
    icon: Building2,
    to: '/admin/suppliers',
  },
];

const WALLET_KIND_LABELS = {
  recharge: 'Mobile recharge',
  gift_card: 'Gift cards',
  app: 'Mobile app',
  other: 'Other',
};

const CASH_KIND_LABELS = {
  drawer: 'Register drawer',
  desk: 'Counter float',
  safe: 'Safe',
  bank: 'Bank',
  other: 'Other',
};

function TillDialog({ till, kinds, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(till);
  const [name, setName] = useState(till?.name || '');
  const [kind, setKind] = useState(till?.kind || 'drawer');
  const [note, setNote] = useState(till?.note || '');
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (editing) {
        await api.put(`/accounts/cash/${till.id}`, { name, kind, note, isDefault: makeDefault });
      } else {
        await api.post('/accounts/cash', { name, kind, note });
      }
      toast(editing ? 'Till updated' : `${name} added`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? `Edit ${till.name}` : 'New cash account'}
      subtitle="A pile of the shop's own money that gets counted on its own"
    >
      <form onSubmit={submit} className="space-y-3">
        <Input
          label="Name"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Transfer desk"
          autoFocus
        />
        <Select label="What it is" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {CASH_KIND_LABELS[k] || k}
            </option>
          ))}
        </Select>
        <Input label="Note" name="note" value={note} onChange={(e) => setNote(e.target.value)} />

        {editing && !till.isDefault && (
          <label className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded"
            />
            <span>
              <span className="block font-medium text-slate-800">Make this the default</span>
              <span className="block text-xs text-slate-500">
                Sales and anything that does not name a till go here.
              </span>
            </span>
          </label>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={busy} disabled={!name.trim()}>
            {editing ? 'Save' : 'Add account'}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/** One account, whatever kind it is. */
function AccountRow({ account, onEdit, onRemove }) {
  const negative = account.balance < 0;
  const isCash = account.type === 'cash';

  return (
    <tr className={cx('hover:bg-slate-50/60', !account.active && 'opacity-50')}>
      <td className="px-5 py-2.5 font-medium text-slate-800">
        {account.name}
        {account.isDefault && (
          <Badge tone="brand" icon={Star} className="ml-2">
            Default
          </Badge>
        )}
        {isCash && account.openSession && (
          <Badge tone="good" className="ml-2">
            Open
          </Badge>
        )}
        {!account.active && (
          <Badge tone="neutral" className="ml-2">
            Closed
          </Badge>
        )}
      </td>
      {/* The middle column says what the account is: what kind of till, what
          kind of wallet, or how to reach the person. */}
      <td className="px-3 py-2.5 text-slate-500">
        {isCash
          ? CASH_KIND_LABELS[account.kind] || account.kind
          : account.type === 'wallet'
            ? WALLET_KIND_LABELS[account.kind] || account.kind
            : account.phone || '—'}
      </td>
      <td className="tnum px-3 py-2.5 text-right">
        <span
          className={cx(
            'font-semibold',
            negative ? 'text-red-600' : account.balance > 0 ? 'text-slate-900' : 'text-slate-400',
          )}
        >
          {account.currency === 'LBP' ? lbp(account.balance) : money(account.balance)}
        </span>
        {isCash && account.balanceLbp !== 0 && (
          <span className="block text-xs font-normal text-slate-500">{lbp(account.balanceLbp)}</span>
        )}
      </td>
      <td className="px-5 py-2.5 text-right whitespace-nowrap">
        {onEdit && (
          <button
            onClick={() => onEdit(account)}
            aria-label={`Edit ${account.name}`}
            className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <Pencil size={15} />
          </button>
        )}
        {onRemove && account.active && (
          <button
            onClick={() => onRemove(account)}
            aria-label={`Close ${account.name}`}
            className="ml-1 rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 size={15} />
          </button>
        )}
      </td>
    </tr>
  );
}

export default function Accounts() {
  const toast = useToast();
  const { rate } = useSettings();
  const [data, setData] = useState(null);
  const [editingTill, setEditingTill] = useState(null);
  const [newTill, setNewTill] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get('/accounts/registry');
    setData(res.data);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const confirm = useConfirm();

  async function removeTill(till) {
    const agreed = await confirm({
      title: `Put ${till.name} away?`,
      body: 'It stops being a till anybody can open. Every sitting it ever had stays on the books.',
      confirmLabel: 'Put it away',
      cancelLabel: 'Keep it',
    });
    if (!agreed) return;

    try {
      await api.delete(`/accounts/cash/${till.id}`);
      toast(`${till.name} put away`);
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not close that', 'error');
    }
  }

  const summary = data?.summary;

  /* Who owes the shop, most first — the list a shopkeeper actually chases. */
  const debtors = useMemo(
    () => (data?.registry.customer || []).filter((c) => c.balance > 0).sort((a, b) => b.balance - a.balance),
    [data],
  );
  const creditors = useMemo(
    () => (data?.registry.supplier || []).filter((s) => s.balance > 0).sort((a, b) => b.balance - a.balance),
    [data],
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Accounts"
        subtitle="Everything the shop has, everything it owes, and everything owed to it"
        actions={
          <Button onClick={() => setNewTill(true)} disabled={!data}>
            <Plus size={16} /> New cash account
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {!data ? (
          <Skeleton className="h-64" />
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Card className="px-4 py-3">
                <p className="text-xs text-slate-500">In the tills</p>
                <p className="tnum mt-1 text-2xl font-semibold text-slate-900">{money(summary.cashUsd)}</p>
                <p className="tnum text-xs text-slate-400">{lbp(summary.cashLbp)}</p>
              </Card>
              <Card className="px-4 py-3">
                <p className="text-xs text-slate-500">Credit held</p>
                <p className="tnum mt-1 text-2xl font-semibold text-slate-900">{money(summary.walletUsd)}</p>
                <p className="tnum text-xs text-slate-400">
                  {summary.walletLbp > 0 ? lbp(summary.walletLbp) : 'in wallets'}
                </p>
              </Card>
              <Card className="px-4 py-3">
                <p className="text-xs text-slate-500">Owed to you</p>
                <p className="tnum mt-1 text-2xl font-semibold text-emerald-700">
                  {money(summary.receivable)}
                </p>
                <p className="text-xs text-slate-400">
                  {summary.receivableCount} customer{summary.receivableCount === 1 ? '' : 's'}
                </p>
              </Card>
              <Card className="px-4 py-3">
                <p className="text-xs text-slate-500">You owe</p>
                <p className="tnum mt-1 text-2xl font-semibold text-red-600">{money(summary.payable)}</p>
                <p className="text-xs text-slate-400">
                  {summary.payableCount} supplier{summary.payableCount === 1 ? '' : 's'}
                </p>
              </Card>
            </div>

            {/* Who to chase, and who to pay. The two questions the balances
                exist to answer, answered without opening anything. */}
            {(debtors.length > 0 || creditors.length > 0) && (
              <div className="mb-5 grid gap-3 lg:grid-cols-2">
                {[
                  ['Who owes you', debtors, '/admin/customers', 'text-emerald-700'],
                  ['Who you owe', creditors, '/admin/suppliers', 'text-red-600'],
                ].map(([title, rows, to, tone]) => (
                  <Card key={title}>
                    <div className="flex items-baseline justify-between border-b border-slate-100 px-5 py-3">
                      <p className="font-medium text-slate-900">{title}</p>
                      <Link to={to} className="text-xs font-medium text-brand-700 hover:underline">
                        Open the ledger
                      </Link>
                    </div>
                    {rows.length === 0 ? (
                      <p className="px-5 py-4 text-sm text-slate-500">Nobody, which is the good answer.</p>
                    ) : (
                      <ul className="divide-y divide-slate-50">
                        {rows.slice(0, 6).map((r) => (
                          <li key={r.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                            <span className="truncate text-slate-700">{r.name}</span>
                            <span className={cx('tnum shrink-0 font-semibold', tone)}>
                              {money(r.balance)}
                              {rate > 0 && (
                                <span className="ml-2 text-xs font-normal text-slate-400">
                                  {lbp(Math.round(r.balance * rate))}
                                </span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                ))}
              </div>
            )}

            <div className="space-y-4">
              {SECTIONS.map((section) => {
                const rows = data.registry[section.type] || [];
                const Icon = section.icon;
                return (
                  <Card key={section.type}>
                    <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-3">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                          <Icon size={17} />
                        </span>
                        <div>
                          <p className="font-medium text-slate-900">
                            {section.title}
                            <span className="ml-2 text-xs font-normal text-slate-400">{rows.length}</span>
                          </p>
                          <p className="text-xs text-slate-500">{section.blurb}</p>
                        </div>
                      </div>
                      {/* Every other kind is added where it is worked with; a
                          till has no screen of its own, so it is added here. */}
                      {section.manageHere ? (
                        <Button size="sm" variant="secondary" onClick={() => setNewTill(true)}>
                          <Plus size={15} /> Add
                        </Button>
                      ) : (
                        <Link
                          to={section.to}
                          className="shrink-0 text-xs font-medium text-brand-700 hover:underline"
                        >
                          Manage
                        </Link>
                      )}
                    </div>

                    {rows.length === 0 ? (
                      <EmptyState
                        icon={section.type === 'wallet' ? WalletIcon : Icon}
                        title={`No ${section.title.toLowerCase()} yet`}
                        description={section.blurb}
                      />
                    ) : (
                      <table className="w-full text-sm">
                        <tbody className="divide-y divide-slate-50">
                          {rows.map((account) => (
                            <AccountRow
                              key={`${account.type}-${account.id}`}
                              account={account}
                              onEdit={section.manageHere ? setEditingTill : undefined}
                              onRemove={
                                section.manageHere && !account.isDefault ? removeTill : undefined
                              }
                            />
                          ))}
                        </tbody>
                      </table>
                    )}
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </div>

      {(newTill || editingTill) && (
        <TillDialog
          till={editingTill}
          kinds={data?.cashKinds || ['drawer']}
          onClose={() => {
            setNewTill(false);
            setEditingTill(null);
          }}
          onSaved={() => {
            setNewTill(false);
            setEditingTill(null);
            load();
          }}
        />
      )}
    </div>
  );
}

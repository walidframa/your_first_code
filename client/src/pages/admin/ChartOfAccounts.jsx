import { useCallback, useEffect, useState } from 'react';
import { Archive, ChevronRight, Plus } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import {
  Button, Card, Input, LoadError, Modal, ModalActions, Select, Skeleton, cx, useToast,
} from '../../components/ui';

/**
 * The chart of accounts: the shop's own list of what it can post to.
 *
 * Shown as the tree it is, rather than as a flat table sorted by code. A chart
 * is read by its shape — "Cash and bank" with the drawer and the safe under it
 * — and a shopkeeper who has never kept books needs to see that shape before
 * the codes mean anything. The indentation is the explanation.
 *
 * Headings are drawn differently and cannot be posted to. That is the one rule
 * on this screen somebody has to absorb, so it is visible rather than only
 * enforced when they try.
 */
const TYPE_LABELS = {
  asset: 'What the shop owns',
  liability: 'What it owes',
  equity: 'The owner’s share',
  income: 'What it earns',
  expense: 'What it spends',
};

const TYPE_TINT = {
  asset: 'bg-sky-50 text-sky-700 ring-sky-200',
  liability: 'bg-amber-50 text-amber-800 ring-amber-200',
  equity: 'bg-violet-50 text-violet-700 ring-violet-200',
  income: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  expense: 'bg-rose-50 text-rose-700 ring-rose-200',
};

export default function ChartOfAccounts() {
  const toast = useToast();
  const [accounts, setAccounts] = useState(null);
  const [failed, setFailed] = useState(null);
  const [adding, setAdding] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/ledger/accounts');
      setAccounts(res.data.accounts);
      setFailed(null);
    } catch (err) {
      setFailed(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function archive(account) {
    try {
      await api.delete(`/ledger/accounts/${account.id}`);
      toast(`${account.name} put away`);
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not put it away', 'error');
    }
  }

  if (failed) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Chart of accounts" />
        <Card className="m-4">
          <LoadError error={failed} what="the chart of accounts" onRetry={load} />
        </Card>
      </div>
    );
  }

  /* Depth from the parent chain rather than from the code, because a shop is
     free to number its own accounts however it likes. */
  const depthOf = (account) => {
    let depth = 0;
    let cursor = account;
    while (cursor?.parent_id) {
      cursor = accounts.find((a) => a.id === cursor.parent_id);
      depth += 1;
      if (depth > 8) break;
    }
    return depth;
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Chart of accounts"
        subtitle="Everything the books can post to, and how it adds up"
        actions={
          <Button onClick={() => setAdding({ type: 'asset', parentId: '' })}>
            <Plus size={16} /> New account
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <Card className="max-w-4xl overflow-hidden">
          {!accounts ? (
            <div className="p-5">
              <Skeleton className="h-64 w-full" />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Account</th>
                  <th className="w-40 px-2 py-2 font-medium">Kind</th>
                  <th className="w-20 px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {accounts.map((a) => (
                  <tr
                    key={a.id}
                    className={cx(
                      'border-t border-slate-100',
                      !a.active && 'opacity-40',
                      a.is_group && 'bg-slate-50/70',
                    )}
                  >
                    <td className="px-3 py-2">
                      <span
                        className="flex items-center gap-2"
                        style={{ paddingInlineStart: `${depthOf(a) * 18}px` }}
                      >
                        {a.is_group ? (
                          <ChevronRight size={13} className="shrink-0 text-slate-400" />
                        ) : (
                          <span className="w-[13px] shrink-0" />
                        )}
                        <span className="tnum shrink-0 font-mono text-xs text-slate-400">{a.code}</span>
                        <button
                          type="button"
                          onClick={() => setEditing(a)}
                          className={cx(
                            'truncate text-left hover:underline',
                            a.is_group ? 'font-semibold text-slate-800' : 'text-slate-700',
                          )}
                        >
                          {a.name}
                        </button>
                        {/* Said out loud, because it is the rule on this screen
                            somebody has to absorb before they can use it. */}
                        {a.is_group && (
                          <span className="shrink-0 text-[11px] text-slate-400">heading</span>
                        )}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <span
                        className={cx(
                          'rounded px-1.5 py-0.5 text-[11px] ring-1',
                          TYPE_TINT[a.type],
                        )}
                      >
                        {TYPE_LABELS[a.type]}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right">
                      {a.is_group && a.active && (
                        <button
                          type="button"
                          onClick={() => setAdding({ type: a.type, parentId: String(a.id) })}
                          title={`Add an account under ${a.name}`}
                          aria-label={`Add an account under ${a.name}`}
                          className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                        >
                          <Plus size={14} />
                        </button>
                      )}
                      {a.active && (
                        <button
                          type="button"
                          onClick={() => archive(a)}
                          title={`Put ${a.name} away`}
                          aria-label={`Put ${a.name} away`}
                          className="rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                        >
                          <Archive size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {adding && (
        <AccountDialog
          accounts={accounts}
          start={adding}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            load();
          }}
        />
      )}
      {editing && (
        <AccountDialog
          accounts={accounts}
          account={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function AccountDialog({ accounts, account = null, start = null, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    code: account?.code ?? '',
    name: account?.name ?? '',
    type: account?.type ?? start?.type ?? 'asset',
    parentId: account ? String(account.parent_id ?? '') : (start?.parentId ?? ''),
    isGroup: account?.is_group ?? false,
    note: account?.note ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      if (account) {
        await api.put(`/ledger/accounts/${account.id}`, {
          code: form.code, name: form.name, note: form.note, isGroup: form.isGroup,
        });
      } else {
        await api.post('/ledger/accounts', {
          code: form.code,
          name: form.name,
          type: form.type,
          parentId: form.parentId ? Number(form.parentId) : null,
          isGroup: form.isGroup,
          note: form.note,
        });
      }
      toast(account ? 'Account saved' : 'Account added');
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  // Only headings of the same kind, because that is the only thing the server
  // will accept — offering the rest is offering a refusal.
  const parents = (accounts || []).filter((a) => a.is_group && a.active && a.type === form.type);

  return (
    <Modal
      open
      onClose={onClose}
      title={account ? 'Edit account' : 'New account'}
      subtitle={account ? account.code : 'It joins the chart of accounts'}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Code" name="code" value={form.code} onChange={set('code')} required
                 hint="Sorted as text: 1100 before 1200" />
          <Input label="Name" name="name" value={form.name} onChange={set('name')} required autoFocus />
        </div>

        {account ? (
          /*
           * The kind is not editable, and that is deliberate rather than
           * unfinished: changing it re-signs everything already posted, so a
           * year of expenses would silently become a year of income. The way
           * to correct it is a new account and a transfer.
           */
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            This is {TYPE_LABELS[account.type].toLowerCase()}. That cannot be changed once the account
            exists — it would re-sign everything already posted to it. Make a new account and move the
            entries across instead.
          </p>
        ) : (
          <>
            <Select label="Kind" name="type" value={form.type}
                    onChange={(e) => setForm((f) => ({ ...f, type: e.target.value, parentId: '' }))}>
              {Object.entries(TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
            <Select label="Under" name="parentId" value={form.parentId} onChange={set('parentId')}>
              <option value="">Nothing — it sits at the top</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
              ))}
            </Select>
          </>
        )}

        <label className="flex items-start gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
          <input
            type="checkbox"
            name="isGroup"
            checked={form.isGroup}
            onChange={(e) => setForm((f) => ({ ...f, isGroup: e.target.checked }))}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand-600"
          />
          <span>
            <span className="block text-sm font-medium text-slate-800">This is a heading</span>
            <span className="block text-xs text-slate-500">
              Headings hold other accounts and add them up. Nothing can be posted to one directly.
            </span>
          </span>
        </label>

        <Input label="Note (optional)" name="note" value={form.note} onChange={set('note')} />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
          <Button type="submit" className="flex-1" loading={saving}>Save</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

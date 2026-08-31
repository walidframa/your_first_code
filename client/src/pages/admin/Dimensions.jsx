import { useCallback, useEffect, useState } from 'react';
import { Archive, Plus } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import {
  Button, Card, EmptyState, Input, LoadError, Modal, ModalActions, Skeleton, cx, money, useToast,
} from '../../components/ui';

/**
 * Cost centres, and areas — one screen, twice.
 *
 * They are the same idea pointed at two questions: a cost centre is a *part*
 * of the business, an area is *where*. Both hang on a journal line, both are
 * reported the same way, and writing the screen twice would be two sets of
 * behaviour to keep in step for nothing.
 *
 * The list and the report are on one page rather than two, because they are
 * the same thought: a centre nobody can see the profit of is a label, and the
 * moment somebody looks at the report is the moment they want to add the one
 * that is missing.
 */
export function CostCentres() {
  return (
    <Dimensions
      path="cost-centres"
      title="Cost centres"
      subtitle="Which part of the shop earned it, and which part spent it"
      one="cost centre"
      hint="A part of the business — the counter, the repair bench, deliveries. An account says what the money was; this says whose it was."
    />
  );
}

export function Areas() {
  return (
    <Dimensions
      path="areas"
      title="Areas"
      subtitle="Where the money was earned and spent"
      one="area"
      hint="A town, a district, a delivery round. Set one on a branch and everything rung up there carries it without anybody ticking a box."
    />
  );
}

function Dimensions({ path, title, subtitle, one, hint }) {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [report, setReport] = useState(null);
  const [failed, setFailed] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      const [list, performance] = await Promise.all([
        api.get(`/ledger/${path}`),
        api.get(`/ledger/${path}/performance`),
      ]);
      setItems(list.data.items);
      setReport(performance.data);
      setFailed(null);
    } catch (err) {
      setFailed(err);
    }
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);

  async function archive(item) {
    try {
      await api.delete(`/ledger/${path}/${item.id}`);
      toast(`${item.name} put away`);
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not put it away', 'error');
    }
  }

  if (failed) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title={title} />
        <Card className="m-4">
          <LoadError error={failed} what={title.toLowerCase()} onRetry={load} />
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus size={16} /> New {one}
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <p className="mb-4 max-w-4xl rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">{hint}</p>

        {/* The report first: it is the reason any of these exist. */}
        <Card className="mb-4 max-w-4xl overflow-hidden">
          {!report ? (
            <div className="p-5"><Skeleton className="h-40 w-full" /></div>
          ) : report.lines.length === 0 ? (
            <EmptyState
              title="Nothing to report yet"
              hint={`Put a ${one} on a journal line, or set one on a branch, and what it earned and spent appears here.`}
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">{title.replace(/s$/, '')}</th>
                  <th className="w-32 px-2 py-2 text-right font-medium">Earned</th>
                  <th className="w-32 px-2 py-2 text-right font-medium">Spent</th>
                  <th className="w-32 px-2 py-2 text-right font-medium">Left</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {report.lines.map((l) => (
                  <tr
                    key={l.id ?? 'loose'}
                    className={cx('border-t border-slate-100', l.id === null && 'bg-amber-50/50')}
                  >
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs text-slate-400">{l.code}</span>{' '}
                      <span className={cx(l.id === null ? 'text-amber-800' : 'text-slate-800')}>{l.name}</span>
                    </td>
                    <td className="tnum px-2 py-2 text-right text-slate-700">{money(l.income)}</td>
                    <td className="tnum px-2 py-2 text-right text-slate-700">{money(l.expense)}</td>
                    {/* The figure the screen exists for, so it is the one that
                        is coloured and the only one in bold. */}
                    <td
                      className={cx(
                        'tnum px-2 py-2 text-right font-semibold',
                        l.profit < 0 ? 'text-red-600' : 'text-emerald-700',
                      )}
                    >
                      {money(l.profit)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-slate-300 bg-slate-50">
                <tr>
                  <td className="px-3 py-2.5 text-sm font-semibold text-slate-800">Altogether</td>
                  <td className="tnum px-2 py-2.5 text-right font-semibold">{money(report.totals.income)}</td>
                  <td className="tnum px-2 py-2.5 text-right font-semibold">{money(report.totals.expense)}</td>
                  <td
                    className={cx(
                      'tnum px-2 py-2.5 text-right font-semibold',
                      report.totals.profit < 0 ? 'text-red-600' : 'text-emerald-700',
                    )}
                  >
                    {money(report.totals.profit)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </Card>

        <Card className="max-w-4xl overflow-hidden">
          {!items ? (
            <div className="p-5"><Skeleton className="h-24 w-full" /></div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="w-24 px-3 py-2 font-medium">Code</th>
                  <th className="px-2 py-2 font-medium">Name</th>
                  <th className="w-16 px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {items.map((c) => (
                  <tr key={c.id} className={cx('border-t border-slate-100', !c.active && 'opacity-40')}>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{c.code}</td>
                    <td className="px-2 py-2">
                      <button type="button" onClick={() => setEditing(c)} className="text-slate-800 hover:underline">
                        {c.name}
                      </button>
                      {!c.active && <span className="ms-1.5 text-[11px] text-slate-400">put away</span>}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {c.active && (
                        <button
                          type="button"
                          onClick={() => archive(c)}
                          aria-label={`Put ${c.name} away`}
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

      {(adding || editing) && (
        <DimensionDialog
          path={path}
          one={one}
          item={editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function DimensionDialog({ path, one, item = null, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ code: item?.code ?? '', name: item?.name ?? '', note: item?.note ?? '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      if (item) await api.put(`/ledger/${path}/${item.id}`, form);
      else await api.post(`/ledger/${path}`, form);
      toast(item ? 'Saved' : `${form.name} added`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={item ? `Edit ${one}` : `New ${one}`}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Input label="Code" name="code" value={form.code} onChange={set('code')} required autoFocus />
          <Input label="Name" name="name" value={form.name} onChange={set('name')} required className="col-span-2" />
        </div>
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

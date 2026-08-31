import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Store, Undo2, X } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { useBranch } from '../../context/BranchContext';
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
  useToast,
} from '../../components/ui';

function BranchForm({ branch, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: branch?.name || '',
    code: branch?.code || '',
    phone: branch?.phone || '',
    address: branch?.address || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      if (branch) {
        await api.put(`/branches/${branch.id}`, form);
        toast(`${form.name} saved`);
      } else {
        await api.post('/branches', form);
        toast(`${form.name} is open — it has a drawer of its own`);
      }
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the branch');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={branch ? `Edit ${branch.name}` : 'Open a branch'}
      subtitle={branch ? undefined : 'Same company, same catalogue, its own shelf and drawer'}
    >
      <form onSubmit={submit} className="space-y-4">
        <Input label="Name" name="name" value={form.name} onChange={set('name')} required autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Short code"
            name="code"
            value={form.code}
            onChange={set('code')}
            placeholder="e.g. SAI"
            hint="For column headings"
          />
          <Input label="Phone" name="phone" value={form.phone} onChange={set('phone')} />
        </div>
        <Input label="Address" name="address" value={form.address} onChange={set('address')} />

        {!branch && (
          <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
            The catalogue, prices, barcodes, customers and suppliers are shared with the rest of the
            company. What this branch gets of its own is the stock on its shelf, its cashbox, and its own
            sales and profit. Move stock to it with <strong>Move stock</strong> — nothing needs entering twice.
          </p>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            {branch ? 'Save changes' : 'Open the branch'}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

export default function Branches() {
  const toast = useToast();
  const { refresh: refreshBranches, branchId } = useBranch();
  const [branches, setBranches] = useState(null);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get('/branches');
    setBranches(res.data.branches);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function close(branch) {
    try {
      await api.delete(`/branches/${branch.id}`);
      toast(`${branch.name} closed`);
      await load();
      await refreshBranches();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not close that branch', 'error');
    }
  }

  async function reopen(branch) {
    await api.post(`/branches/${branch.id}/reopen`);
    toast(`${branch.name} is open again`);
    await load();
    await refreshBranches();
  }

  const saved = async () => {
    setEditing(null);
    setCreating(false);
    await load();
    await refreshBranches();
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Branches"
        subtitle="One company, one catalogue — a shelf and a drawer at each shop"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> Open a branch
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <Card>
          {!branches ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : branches.length === 0 ? (
            <EmptyState icon={Store} title="No branches yet" />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Branch</th>
                  <th className="px-3 py-2.5 font-medium">Contact</th>
                  <th className="px-3 py-2.5 text-right font-medium">On the shelf</th>
                  <th className="px-3 py-2.5 text-right font-medium">Staff</th>
                  <th className="px-5 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {branches.map((b) => (
                  <tr key={b.id} className={cx(!b.active && 'opacity-55')}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-800">{b.name}</span>
                        {b.is_main && <Badge tone="info">main</Badge>}
                        {b.id === branchId && <Badge tone="good">you are here</Badge>}
                        {!b.active && <Badge tone="neutral">closed</Badge>}
                      </div>
                      {b.address && <p className="text-xs text-slate-400">{b.address}</p>}
                    </td>
                    <td className="px-3 py-3 text-slate-500">{b.phone || '—'}</td>
                    <td className="tnum px-3 py-3 text-right text-slate-700">{b.units_on_hand}</td>
                    <td className="tnum px-3 py-3 text-right text-slate-500">{b.staff_count}</td>
                    <td className="px-5 py-3">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="secondary" onClick={() => setEditing(b)}>
                          <Pencil size={14} /> Edit
                        </Button>
                        {!b.is_main &&
                          (b.active ? (
                            <Button size="sm" variant="secondary" onClick={() => close(b)}>
                              <X size={14} /> Close
                            </Button>
                          ) : (
                            <Button size="sm" variant="secondary" onClick={() => reopen(b)}>
                              <Undo2 size={14} /> Reopen
                            </Button>
                          ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <p className="mt-3 max-w-2xl text-xs text-slate-500">
          A branch cannot be closed while it still holds stock, has a cashbox open, or has goods on the way
          to it — those things are physically somewhere, and closing the branch would only make them vanish
          from the count. Its past sales are kept either way.
        </p>
      </div>

      {creating && <BranchForm onClose={() => setCreating(false)} onSaved={saved} />}
      {editing && <BranchForm branch={editing} onClose={() => setEditing(null)} onSaved={saved} />}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Trash2, UserPlus } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { useAuth } from '../../context/AuthContext';
import { Badge, Button, Card, Input, Modal, Select, Skeleton, useToast } from '../../components/ui';

const emptyForm = { name: '', username: '', password: '', role: 'cashier' };

function StaffModal({ onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.post('/users', form);
      toast(`${form.name} added`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create user');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Add staff member">
      <form onSubmit={submit} className="space-y-4">
        <Input label="Full name" value={form.name} onChange={set('name')} required autoFocus />
        <Input label="Username" value={form.username} onChange={set('username')} required />
        <Input
          label="Password"
          type="password"
          value={form.password}
          onChange={set('password')}
          required
          hint="At least 6 characters"
        />
        <Select label="Role" value={form.role} onChange={set('role')}>
          <option value="cashier">Cashier — register and own sales</option>
          <option value="admin">Admin — full access</option>
        </Select>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            Add staff member
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function Users() {
  const { user: currentUser } = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api.get('/users').then((res) => setUsers(res.data.users));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(user) {
    try {
      await api.delete(`/users/${user.id}`);
      toast(`${user.name} removed`);
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not delete user', 'error');
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Staff"
        subtitle="Who can access the register and back office"
        actions={
          <Button onClick={() => setAdding(true)}>
            <UserPlus size={16} /> Add staff
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <Card>
          {!users ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Name</th>
                  <th className="px-3 py-2.5 font-medium">Username</th>
                  <th className="px-3 py-2.5 font-medium">Role</th>
                  <th className="px-3 py-2.5 font-medium">Added</th>
                  <th className="px-5 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-2.5 font-medium text-slate-800">
                      {u.name}
                      {u.id === currentUser.id && <span className="ml-2 text-xs text-slate-400">You</span>}
                    </td>
                    <td className="px-3 py-2.5 text-slate-500">{u.username}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={u.role === 'admin' ? 'brand' : 'neutral'}>{u.role}</Badge>
                    </td>
                    <td className="px-3 py-2.5 text-slate-500">{u.created_at}</td>
                    <td className="px-5 py-2.5 text-right">
                      {u.id !== currentUser.id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => remove(u)}
                          aria-label={`Remove ${u.name}`}
                        >
                          <Trash2 size={14} />
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

      {adding && (
        <StaffModal
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </div>
  );
}

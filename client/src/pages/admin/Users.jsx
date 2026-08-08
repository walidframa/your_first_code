import { useCallback, useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { useAuth } from '../../context/AuthContext';
import { Badge, Button, Card, Input, Modal, Select, Skeleton, cx, useToast } from '../../components/ui';

const emptyForm = { name: '', username: '', password: '', role: 'cashier' };

/**
 * A permission, as a row you can tick.
 *
 * The description is not decoration. "Documents" means nothing to whoever is
 * deciding; "quotations, sales orders and invoices" is the sentence that lets
 * them say yes or no without asking anyone.
 */
function PermissionRow({ permission, label, description, checked, disabled, onChange }) {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 transition',
        disabled ? 'cursor-default opacity-60' : 'hover:bg-slate-50',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(permission, e.target.checked)}
        aria-label={label}
        className="mt-0.5 h-4 w-4 shrink-0 rounded"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        <span className="block text-xs text-slate-500">{description}</span>
      </span>
    </label>
  );
}

/** Tick boxes for one person, grouped the way the work is. */
function PermissionPicker({ groups, value, onChange, disabled }) {
  const toggle = (permission, on) =>
    onChange(on ? [...new Set([...value, permission])] : value.filter((p) => p !== permission));

  const setGroup = (items, on) => {
    const keys = items.map(([key]) => key);
    onChange(on ? [...new Set([...value, ...keys])] : value.filter((p) => !keys.includes(p)));
  };

  return (
    <div className="space-y-3">
      {groups.map(({ group, items }) => {
        const all = items.every(([key]) => value.includes(key));
        return (
          <div key={group} className="rounded-xl ring-1 ring-slate-200">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
              <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{group}</p>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => setGroup(items, !all)}
                  className="text-xs font-medium text-brand-700 hover:underline"
                >
                  {all ? 'None' : 'All'}
                </button>
              )}
            </div>
            <div className="p-1">
              {items.map(([key, label, description]) => (
                <PermissionRow
                  key={key}
                  permission={key}
                  label={label}
                  description={description}
                  checked={value.includes(key)}
                  disabled={disabled}
                  onChange={toggle}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StaffModal({ groups, defaults, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(emptyForm);
  const [permissions, setPermissions] = useState(defaults?.cashier || ['register']);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (key) => (e) => {
    const { value } = e.target;
    setForm((f) => ({ ...f, [key]: value }));
    // Switching to admin makes the tick boxes moot, and back again should not
    // leave the form claiming the whole shop.
    if (key === 'role') setPermissions(defaults?.[value] || []);
  };

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.post('/users', { ...form, permissions });
      toast(`${form.name} added`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create user');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="lg" title="Add staff member">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Full name" value={form.name} onChange={set('name')} required autoFocus />
          <Input label="Username" value={form.username} onChange={set('username')} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Password"
            type="password"
            value={form.password}
            onChange={set('password')}
            required
            hint="At least 6 characters"
          />
          <Select label="Role" value={form.role} onChange={set('role')}>
            <option value="cashier">Staff — only what you tick below</option>
            <option value="admin">Admin — the whole shop</option>
          </Select>
        </div>

        {form.role === 'admin' ? (
          <p className="rounded-xl bg-brand-50 px-4 py-3 text-sm text-brand-800">
            An admin can do everything, including adding staff and changing what everyone else may do.
          </p>
        ) : (
          <div>
            <p className="mb-2 text-sm font-medium text-slate-700">What they can do</p>
            <PermissionPicker groups={groups} value={permissions} onChange={setPermissions} />
          </div>
        )}

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

function PermissionsModal({ user, groups, onClose, onSaved }) {
  const toast = useToast();
  const isAdmin = user.role === 'admin';
  const [permissions, setPermissions] = useState(user.permissions || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setError('');
    setSaving(true);
    try {
      await api.put(`/users/${user.id}/permissions`, { permissions });
      toast(`${user.name}'s access updated`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`What ${user.name} can do`}
      subtitle={isAdmin ? 'An admin has every permission by definition' : user.username}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            {isAdmin ? 'Close' : 'Cancel'}
          </Button>
          {!isAdmin && (
            <Button className="flex-1" loading={saving} onClick={save}>
              Save access
            </Button>
          )}
        </div>
      }
    >
      {isAdmin && (
        <p className="mb-3 rounded-xl bg-brand-50 px-4 py-3 text-sm text-brand-800">
          To narrow what {user.name} can reach, change their role to staff first.
        </p>
      )}
      <PermissionPicker
        groups={groups}
        value={isAdmin ? groups.flatMap((g) => g.items.map(([k]) => k)) : permissions}
        onChange={setPermissions}
        disabled={isAdmin}
      />
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </Modal>
  );
}

export default function Users() {
  const { user: currentUser } = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState(null);
  const [catalogue, setCatalogue] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => {
    api.get('/users').then((res) => setUsers(res.data.users));
  }, []);

  useEffect(() => {
    load();
    api.get('/users/permissions').then((res) => setCatalogue(res.data));
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

  /* Two or three names read better than a count; a dozen does not. */
  function summarise(user) {
    if (user.role === 'admin') return 'Everything';
    const list = user.permissions || [];
    if (list.length === 0) return 'Nothing yet';
    const labels = (catalogue?.groups || [])
      .flatMap((g) => g.items)
      .filter(([key]) => list.includes(key))
      .map(([, label]) => label);
    if (labels.length <= 3) return labels.join(', ');
    return `${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more`;
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Staff"
        subtitle="Who works here, and what each of them can reach"
        actions={
          <Button onClick={() => setAdding(true)} disabled={!catalogue}>
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
                  <th className="px-3 py-2.5 font-medium">Can reach</th>
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
                      <Badge tone={u.role === 'admin' ? 'brand' : 'neutral'} icon={u.role === 'admin' ? ShieldCheck : undefined}>
                        {u.role === 'admin' ? 'Admin' : 'Staff'}
                      </Badge>
                    </td>
                    <td className="max-w-xs truncate px-3 py-2.5 text-slate-600">{summarise(u)}</td>
                    <td className="px-5 py-2.5 text-right whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(u)}
                        disabled={!catalogue}
                        aria-label={`Permissions for ${u.name}`}
                      >
                        <KeyRound size={14} /> Access
                      </Button>
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

        <p className="mt-3 text-xs text-slate-500">
          An admin can do everything. Everyone else can reach exactly what is ticked — the rail only
          shows them those sections, and the server refuses the rest whether or not they find the address.
        </p>
      </div>

      {adding && catalogue && (
        <StaffModal
          groups={catalogue.groups}
          defaults={catalogue.defaults}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}

      {editing && catalogue && (
        <PermissionsModal
          user={editing}
          groups={catalogue.groups}
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

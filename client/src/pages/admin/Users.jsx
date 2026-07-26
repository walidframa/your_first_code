import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext';

const emptyForm = { username: '', password: '', name: '', role: 'cashier' };

export default function Users() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');

  async function load() {
    const res = await api.get('/users');
    setUsers(res.data.users);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/users', form);
      setForm(emptyForm);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create user');
    }
  }

  async function remove(id) {
    setError('');
    try {
      await api.delete(`/users/${id}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not delete user');
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-semibold text-slate-800">Staff Accounts</h1>

      <form onSubmit={handleSubmit} className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-medium text-slate-700">Add staff member</h2>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Full name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <input
            className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Username"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            required
          />
          <input
            type="password"
            className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Password (min 6)"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
          <select
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          >
            <option value="cashier">Cashier</option>
            <option value="admin">Admin</option>
          </select>
          <button type="submit" className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
            Add
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </form>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Username</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-slate-100">
                <td className="px-4 py-2.5 font-medium text-slate-700">{u.name}</td>
                <td className="px-4 py-2.5 text-slate-500">{u.username}</td>
                <td className="px-4 py-2.5">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      u.role === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-slate-500">{u.created_at}</td>
                <td className="px-4 py-2.5 text-right">
                  {u.id !== currentUser.id && (
                    <button onClick={() => remove(u.id)} className="text-xs text-red-600 hover:underline">
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

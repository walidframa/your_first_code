import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { ScanLine } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Button, Input } from '../components/ui';

const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'admin123', label: 'Store owner', hint: 'Full back office' },
  { username: 'cashier', password: 'cashier123', label: 'Cashier', hint: 'Register only' },
];

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function signIn(user, pass) {
    setError('');
    setSubmitting(true);
    try {
      await login(user, pass);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-white">
            <ScanLine size={24} />
          </div>
          <h1 className="text-xl font-semibold text-white">Front Desk POS</h1>
          <p className="mt-1 text-sm text-slate-400">Sign in to open the register</p>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-xl">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              signIn(username, password);
            }}
            className="space-y-4"
          >
            <Input
              label="Username"
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              required
            />
            <Input
              label="Password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />

            {error && <p className="text-sm text-red-600">{error}</p>}

            <Button type="submit" size="lg" className="w-full" loading={submitting}>
              Sign in
            </Button>
          </form>
        </div>

        <div className="mt-4 rounded-xl bg-slate-800/60 p-3">
          <p className="mb-2 px-1 text-xs font-medium tracking-wide text-slate-400 uppercase">
            Demo accounts
          </p>
          <div className="space-y-1">
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.username}
                onClick={() => signIn(a.username, a.password)}
                disabled={submitting}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition hover:bg-slate-700/60 disabled:opacity-50"
              >
                <span>
                  <span className="block text-sm font-medium text-white">{a.label}</span>
                  <span className="block text-xs text-slate-400">{a.hint}</span>
                </span>
                <span className="font-mono text-xs text-slate-400">{a.username}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

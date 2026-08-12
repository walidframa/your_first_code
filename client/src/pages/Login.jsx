import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { ScanLine } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { Button, Input, cx } from '../components/ui';

const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'admin123', label: 'Store owner', hint: 'Full back office' },
  { username: 'cashier', password: 'cashier123', label: 'Cashier', hint: 'Register only' },
];

export default function Login() {
  const { login } = useAuth();
  const { language, choose, languages, t } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /*
   * Sent here by a dead session rather than by choosing to sign out. Worth
   * saying, because otherwise the login screen appearing mid-job looks like the
   * app threw the work away — and in development it happens on every restart,
   * since the dev signing key is generated per process.
   */
  const expired = new URLSearchParams(location.search).get('expired') === '1';

  async function signIn(user, pass) {
    setError('');
    setSubmitting(true);
    try {
      await login(user, pass);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || t('Login failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-sm">
        {/*
          * Chosen before signing in, because the person who needs it in Arabic
          * cannot read the screen that would otherwise be asking them to.
          * Takes effect on the press — the page turns round underneath the
          * button, which is the only demonstration anybody needs.
          */}
        <div className="mb-4 flex justify-center gap-1 rounded-xl bg-slate-800/60 p-1">
          {languages.map(([id, label]) => (
            <button
              key={id}
              onClick={() => choose(id)}
              lang={id}
              aria-pressed={language === id}
              className={cx(
                'flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition',
                language === id ? 'bg-white text-slate-900' : 'text-slate-300 hover:text-white',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-white">
            <ScanLine size={24} />
          </div>
          <h1 className="text-xl font-semibold text-white">{t('Front Desk')} POS</h1>
          <p className="mt-1 text-sm text-slate-400">{t('Sign in to open the register')}</p>
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
              label={t('Username')}
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              required
            />
            <Input
              label={t('Password')}
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />

            {expired && !error && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {t('Your session ended — sign in again to carry on. Nothing you saved is lost.')}
              </p>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}

            <Button type="submit" size="lg" className="w-full" loading={submitting}>
              {t('Sign in')}
            </Button>
          </form>
        </div>

        <div className="mt-4 rounded-xl bg-slate-800/60 p-3">
          <p className="mb-2 px-1 text-xs font-medium tracking-wide text-slate-400 uppercase">
            {t('Demo accounts')}
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
                  <span className="block text-sm font-medium text-white">{t(a.label)}</span>
                  <span className="block text-xs text-slate-400">{t(a.hint)}</span>
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

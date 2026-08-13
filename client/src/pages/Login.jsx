import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { ScanLine } from 'lucide-react';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { Button, Input, PasswordInput, cx } from '../components/ui';

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
   * Whether the shipped logins are still the real ones.
   *
   * Assumed absent until the server says otherwise, so a shop whose server is
   * slow — or away — never flashes `admin/admin123` onto the screen on the way
   * to hiding it.
   */
  const [demoAvailable, setDemoAvailable] = useState(false);
  useEffect(() => {
    api
      .get('/health')
      .then((res) => setDemoAvailable(Boolean(res.data.demoAccounts)))
      .catch(() => setDemoAvailable(false));
  }, []);

  /*
   * Whose shop this is.
   *
   * The first screen a cashier sees every morning said "Front Desk POS", which
   * is the name of the software rather than the name of the shop they work in.
   * Both of these are already printed on every receipt that leaves the counter,
   * so neither is a secret — and a shop that never uploaded a logo simply keeps
   * the icon it had.
   */
  const [branding, setBranding] = useState(null);
  useEffect(() => {
    api
      .get('/branding')
      .then((res) => setBranding(res.data))
      .catch(() => {});
  }, []);

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
          {branding?.logoUrl ? (
            /*
             * Round, and cropped to fill it. A shop's logo arrives at whatever
             * shape the shop had it made in, and a frame that stretched it
             * would make the shop look worse on its own front door than on its
             * receipts.
             */
            <img
              src={branding.logoUrl}
              alt={branding.companyName || ''}
              className="mx-auto mb-3 h-20 w-20 rounded-full bg-white object-cover ring-2 ring-white/20"
            />
          ) : (
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-white">
              <ScanLine size={24} />
            </div>
          )}
          <h1 className="text-xl font-semibold text-white">
            {branding?.companyName || `${t('Front Desk')} POS`}
          </h1>
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
            <PasswordInput
              label={t('Password')}
              name="password"
              autoComplete="current-password"
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

        {/* Only while they are still the real passwords. Printing
            `admin/admin123` on the door of a working shop is worse than not
            having the shortcut at all. */}
        {demoAvailable && (
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
        )}
      </div>
    </div>
  );
}

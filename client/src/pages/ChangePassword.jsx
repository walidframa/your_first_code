import { useState } from 'react';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Button, Input, useToast } from '../components/ui';
import { useT } from '../context/LanguageContext';

/**
 * Setting a password, at the two moments it happens.
 *
 * As a gate, when the account is still on the password this app ships with —
 * `admin/admin123` is in the README and on the sign-in screen, so on anything
 * reachable from the internet it is a doorbell. Sign-in is the right moment to
 * insist: no sale is in progress and nobody is standing at the counter waiting.
 *
 * And as an ordinary panel in Settings the rest of the time.
 */
export default function ChangePassword({ forced = false }) {
  const { user, changePassword, logout } = useAuth();
  const toast = useToast();
  const t = useT();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const mismatch = again.length > 0 && next !== again;

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (next !== again) return setError(t('The two new passwords are not the same'));

    setBusy(true);
    try {
      await changePassword(current, next);
      toast.success(t('Password changed'));
      setCurrent('');
      setNext('');
      setAgain('');
    } catch (err) {
      setError(err.response?.data?.error || t('Could not change the password'));
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form onSubmit={submit} className="space-y-3">
      <Input
        label={t('Your current password')}
        type="password"
        name="currentPassword"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        required
      />
      <Input
        label={t('New password')}
        type="password"
        name="newPassword"
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        hint={t('At least 8 characters')}
        required
      />
      <Input
        label={t('New password again')}
        type="password"
        name="newPasswordAgain"
        autoComplete="new-password"
        value={again}
        onChange={(e) => setAgain(e.target.value)}
        error={mismatch ? t('The two new passwords are not the same') : undefined}
        required
      />

      {error && (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" disabled={busy || mismatch} className="w-full">
        <KeyRound size={16} /> {busy ? t('Saving…') : t('Set the new password')}
      </Button>
    </form>
  );

  if (!forced) return form;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-start gap-3">
          <span className="rounded-xl bg-amber-100 p-2 text-amber-700">
            <ShieldAlert size={20} />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">
              {t('Choose a password before you start')}
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              {t(
                'This account is still using the demo password the app ships with. It is printed in the manual and known to anyone who has seen this app, so it protects nothing.',
              )}
            </p>
          </div>
        </div>

        {form}

        <button
          type="button"
          onClick={logout}
          className="mt-4 w-full text-center text-xs text-slate-500 underline hover:text-slate-700"
        >
          {t('Sign in as somebody else')}
        </button>

        <p className="mt-3 text-center text-xs text-slate-400">
          {t('Signed in as')} {user?.username}
        </p>
      </div>
    </div>
  );
}

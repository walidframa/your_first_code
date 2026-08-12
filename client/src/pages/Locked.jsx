import { useEffect, useState } from 'react';
import { Download, Lock } from 'lucide-react';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import { useLicence } from '../context/LicenceContext';
import { Button } from '../components/ui';

/**
 * The screen a shop sees when its licence has run out.
 *
 * Two jobs, and the second is the one that makes the first defensible.
 *
 * It has to be unmistakable — the till is not coming back until somebody pays,
 * and a cashier standing in front of a customer needs to know that in one
 * glance rather than by trying things.
 *
 * And it has to hand over the shop's own books. A sales history is an
 * accounting record, and in most places the shop is legally required to be able
 * to produce it. A vendor holding one behind an unpaid invoice has a problem of
 * their own rather than leverage — and the pressure to pay is exactly the same
 * either way, because they still cannot trade.
 */
export default function Locked() {
  const { licence, refresh } = useLicence();
  const { user, logout } = useAuth();

  /*
   * Checked more often here than anywhere else in the app: whoever is looking
   * at this screen is the person about to pay, and the till should come back on
   * its own rather than after somebody thinks to reload it.
   */
  useEffect(() => {
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-red-100 p-2 text-red-700">
            <Lock size={20} />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">This till has stopped</h1>
            <p className="mt-1 text-sm text-slate-600">
              {licence?.reason === 'suspended'
                ? 'This shop has been suspended. Please contact whoever supplied the app.'
                : 'The licence for this shop has run out, so no more sales can be rung up. Everything already in it is safe.'}
            </p>
            {licence?.paidThrough && (
              <p className="mt-2 text-sm text-slate-500">
                Paid up to <strong className="text-slate-700">{licence.paidThrough}</strong>.
              </p>
            )}
          </div>
        </div>

        <p className="mt-5 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Pay whoever supplied this app and the till starts working again by itself, within a
          minute. Nothing has been deleted and nothing needs setting up again.
        </p>

        {user ? (
          <TakeYourData />
        ) : (
          <p className="mt-4 text-sm text-slate-500">
            Sign in as the owner to take a copy of the shop’s records.
          </p>
        )}

        <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4">
          <Button variant="secondary" size="sm" onClick={refresh}>
            Check again
          </Button>
          {user && (
            <button
              type="button"
              onClick={logout}
              className="text-xs text-slate-500 underline hover:text-slate-700"
            >
              Sign out
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A copy of the whole shop, downloaded, while the till itself is stopped. */
function TakeYourData() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function download() {
    setBusy(true);
    setError('');
    try {
      // Fresh rather than the newest nightly one: somebody taking their records
      // away wants today's, including this morning's sales.
      const made = await api.post('/backups');
      const name = made.data.backup.name;
      const file = await api.get(`/backups/${name}`, { responseType: 'blob' });

      const url = URL.createObjectURL(file.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not make a copy just now');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-slate-200 p-4">
      <h2 className="text-sm font-semibold text-slate-900">Your records</h2>
      <p className="mt-0.5 mb-3 text-xs text-slate-500">
        Every sale, customer and invoice, in one file you can keep. It stays available whether or
        not the licence is paid.
      </p>
      <Button onClick={download} loading={busy} variant="secondary">
        <Download size={16} /> Download a copy
      </Button>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

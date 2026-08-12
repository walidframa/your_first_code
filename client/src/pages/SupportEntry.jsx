import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { LifeBuoy, TriangleAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

/**
 * Where a support link lands.
 *
 * The vendor arrives here from their console with a ticket in the address bar,
 * and leaves signed into this shop as Support. Nothing is typed and nothing is
 * remembered — the ticket is spent on arrival and will not work twice.
 *
 * Deliberately not silent about it. The page says whose shop this is about to
 * be, that the shop will see a bar naming them, and that everything they change
 * is written into the shop's own log. Somebody who would rather not be seen
 * doing whatever they came to do should find that out here, before they do it.
 */
export default function SupportEntry() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { signInWithTicket } = useAuth();
  const [error, setError] = useState(null);
  // React runs effects twice in development; a ticket is single-use, so the
  // second run would spend a ticket that was already spent and report failure
  // over a sign-in that actually worked.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const ticket = params.get('t');
    if (!ticket) {
      setError('That link has no ticket in it.');
      return;
    }

    signInWithTicket(ticket)
      .then(() => navigate('/', { replace: true }))
      .catch((err) =>
        setError(
          err.response?.data?.error ||
            'That link did not work. Tickets last five minutes and can only be used once.',
        ),
      );
  }, [params, navigate, signInWithTicket]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm">
        {error ? (
          <>
            <TriangleAlert className="mb-4 text-red-600" size={28} />
            <h1 className="mb-2 text-lg font-semibold text-slate-900">That link did not work</h1>
            <p className="text-sm text-slate-600">{error}</p>
            <p className="mt-4 text-sm text-slate-500">
              Ask for a fresh one from the console and open it straight away.
            </p>
          </>
        ) : (
          <>
            <LifeBuoy className="mb-4 animate-pulse text-slate-500" size={28} />
            <h1 className="mb-2 text-lg font-semibold text-slate-900">Signing you in…</h1>
            <p className="text-sm text-slate-600">
              This shop will see a bar naming you for as long as you are here, and everything you
              change is written into their log.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

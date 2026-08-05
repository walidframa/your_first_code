import { useCallback, useEffect, useState } from 'react';
import { Eye, KeyRound, Search } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { useAuth } from '../../context/AuthContext';
import { Button, Card, EmptyState, cx, useToast } from '../../components/ui';

const KIND_STYLE = {
  icloud: 'bg-sky-50 text-sky-700',
  gmail: 'bg-red-50 text-red-600',
  other: 'bg-slate-100 text-slate-600',
};

const KIND_LABEL = { icloud: 'iCloud', gmail: 'Gmail', other: 'Other' };

/**
 * Finding an account a customer has forgotten.
 *
 * One box, because at the counter the customer offers whatever they remember —
 * the phone in their hand, their own name, the number they called from. Which
 * of those it is should not be the counter's problem.
 *
 * Passwords are never in the list. Reading one is a separate, deliberate press,
 * and only an admin can do it: the shop giving somebody their account back is
 * the point of keeping it; a screen of twenty passwords facing the shop floor
 * is not.
 */
export default function HeldAccounts() {
  const toast = useToast();
  const { user } = useAuth();
  const [term, setTerm] = useState('');
  const [accounts, setAccounts] = useState(null);
  const [revealed, setRevealed] = useState({});

  const search = useCallback(async (q) => {
    if (!q.trim()) {
      setAccounts(null);
      return;
    }
    const res = await api.get('/held-accounts', { params: { q } });
    setAccounts(res.data.accounts);
  }, []);

  // Debounced, because this is typed at a counter with somebody waiting.
  useEffect(() => {
    const id = setTimeout(() => search(term), 250);
    return () => clearTimeout(id);
  }, [term, search]);

  async function reveal(account) {
    try {
      const res = await api.get(`/held-accounts/${account.id}/password`);
      setRevealed((r) => ({ ...r, [account.id]: res.data.password ?? '—' }));
    } catch (err) {
      toast(
        err.response?.status === 403
          ? 'Only an admin can read a password'
          : err.response?.data?.error || 'Could not read it',
        'error',
      );
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Customer accounts"
        subtitle="The iCloud and Gmail logins the shop set up, for when they are forgotten"
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="relative mb-4">
          <Search size={18} className="absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            autoFocus
            placeholder="IMEI, account name, customer's name or phone number…"
            aria-label="Find a held account"
            className="h-12 w-full rounded-xl bg-white pr-4 pl-11 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-500 focus:outline-none"
          />
        </div>

        {accounts === null ? (
          <EmptyState
            icon={KeyRound}
            title="Search for a customer"
            description="Whatever they remember will do — the number on the phone, their own name, or the account itself."
          />
        ) : accounts.length === 0 ? (
          <EmptyState
            icon={Search}
            title={`Nothing matches “${term}”`}
            description="Accounts are recorded on the sale, in the Buyer & accounts section at the register."
          />
        ) : (
          <ul className="space-y-2">
            {accounts.map((a) => (
              <li key={a.id}>
                <Card className="p-4">
                  <div className="flex items-start gap-3">
                    <span
                      className={cx(
                        'rounded-full px-2 py-0.5 text-xs font-medium',
                        KIND_STYLE[a.kind],
                      )}
                    >
                      {KIND_LABEL[a.kind]}
                    </span>

                    <div className="min-w-0 flex-1">
                      <p className="font-medium break-all text-slate-900">{a.username}</p>
                      <p className="mt-0.5 text-sm text-slate-500">
                        {a.buyer_name || 'no name recorded'}
                        {a.buyer_phone ? ` · ${a.buyer_phone}` : ''}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {a.product_name ? `${a.product_name} · ` : ''}
                        {a.imei ? <span className="font-mono">{a.imei}</span> : 'no handset linked'}
                        {a.imei2 && <span className="font-mono"> / {a.imei2}</span>}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        Sold {String(a.sold_on ?? '').slice(0, 10)} on {a.order_number}
                      </p>
                      {a.note && <p className="mt-1 text-xs text-slate-500">{a.note}</p>}
                    </div>

                    <div className="shrink-0 text-right">
                      {revealed[a.id] !== undefined ? (
                        <p className="rounded-lg bg-slate-900 px-3 py-1.5 font-mono text-sm text-white select-all">
                          {revealed[a.id]}
                        </p>
                      ) : user?.role === 'admin' ? (
                        <Button size="sm" variant="secondary" onClick={() => reveal(a)}>
                          <Eye size={14} /> Show password
                        </Button>
                      ) : (
                        <p className="text-xs text-slate-400">Ask an admin for the password</p>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Plus, Search, UserPlus, UserRound, X } from 'lucide-react';
import api from '../api';
import { Badge, Button, EmptyState, Modal, cx, money } from './ui';
import { useT } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import PartyQuickCreate from './PartyQuickCreate';
import { matchesSearch } from '../lib/search';

/**
 * Attaches a customer to the sale in progress. Optional for cash and card;
 * required before a sale can go on account.
 */
export default function CustomerPicker({ customer, onChange }) {
  const t = useT();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [customers, setCustomers] = useState(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  /*
   * Adding a contact is its own permission — the same one the Customers screen
   * sits behind. A button that always came back 403 would be worse than no
   * button, so a cashier without it picks from the list as before.
   */
  const canAdd = can('parties');

  useEffect(() => {
    if (!open) return;
    api.get('/customers').then((res) => setCustomers(res.data.parties));
  }, [open]);

  const term = search.trim().toLowerCase();
  const visible = (customers || []).filter(
    (c) => matchesSearch(term, c.name, c.phone),
  );

  return (
    <>
      {customer ? (
        <div className="flex items-center gap-2 rounded-lg bg-brand-50 px-2.5 py-1.5">
          <UserRound size={14} className="shrink-0 text-brand-700" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-brand-900">{customer.name}</p>
            {customer.balance > 0.005 && (
              <p className="tnum text-[11px] text-brand-700">{t('owes')} {money(customer.balance)}</p>
            )}
          </div>
          <button
            onClick={() => onChange(null)}
            aria-label="Remove customer"
            className="rounded p-0.5 text-brand-700 transition hover:bg-brand-100"
          >
            <X size={13} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100"
        >
          <UserPlus size={14} /> {t('Add customer')}
        </button>
      )}

      {customer && (
        <button
          onClick={() => setOpen(true)}
          className="mt-1 w-full text-left text-[11px] text-slate-400 transition hover:text-slate-600"
        >
          {t('Change customer')}
        </button>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={t('Choose a customer')} size="md">
        <div className="relative mb-3">
          <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('Search by name or phone…')}
            autoFocus
            className="h-10 w-full rounded-lg bg-slate-100 pr-3 pl-9 text-sm ring-1 ring-transparent transition focus:bg-white focus:ring-brand-600 focus:outline-none"
          />
        </div>

        {!customers ? (
          <p className="py-6 text-center text-sm text-slate-400">Loading…</p>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={UserRound}
            title="No customers found"
            description={
              canAdd
                ? 'Nobody by that name yet — add them without leaving the sale.'
                : 'Add customers from the back office to sell on account.'
            }
            action={
              canAdd ? (
                <Button onClick={() => setCreating(true)}>
                  <Plus size={15} /> {t('New customer')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="max-h-80 divide-y divide-rule overflow-y-auto">
            {visible.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => {
                    onChange(c);
                    setOpen(false);
                    setSearch('');
                  }}
                  className="flex w-full items-center justify-between gap-3 px-1 py-2.5 text-left transition hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">{c.name}</p>
                    <p className="text-xs text-slate-400">{c.phone || c.email || '—'}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    {c.balance > 0.005 ? (
                      <Badge tone="warning">owes {money(c.balance)}</Badge>
                    ) : (
                      <Badge tone="neutral">settled</Badge>
                    )}
                    <p className={cx('tnum mt-0.5 text-[11px] text-slate-400')}>
                      limit {money(c.credit_limit)}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex items-center justify-between gap-2">
          {/*
            * A walk-in who wants it on the slate is standing at the counter
            * while this is open. Sending the cashier to the back office to
            * create them means abandoning the sale and ringing it up again.
            */}
          {canAdd ? (
            <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
              <Plus size={15} /> {t('New customer')}
            </Button>
          ) : (
            <span />
          )}
          <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </Modal>

      {/* Straight onto the sale once they exist — creating them was never the
          point, selling to them was. */}
      <PartyQuickCreate
        open={creating}
        partyType="customer"
        onClose={() => setCreating(false)}
        onCreated={(party) => {
          setCreating(false);
          setOpen(false);
          setSearch('');
          setCustomers(null);
          onChange({ ...party, balance: party.balance ?? 0 });
        }}
      />
    </>
  );
}

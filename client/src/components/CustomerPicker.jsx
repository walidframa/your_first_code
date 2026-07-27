import { useEffect, useState } from 'react';
import { Search, UserPlus, UserRound, X } from 'lucide-react';
import api from '../api';
import { Badge, Button, EmptyState, Modal, cx, money } from './ui';

/**
 * Attaches a customer to the sale in progress. Optional for cash and card;
 * required before a sale can go on account.
 */
export default function CustomerPicker({ customer, onChange }) {
  const [open, setOpen] = useState(false);
  const [customers, setCustomers] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    api.get('/customers').then((res) => setCustomers(res.data.parties));
  }, [open]);

  const term = search.trim().toLowerCase();
  const visible = (customers || []).filter(
    (c) => !term || c.name.toLowerCase().includes(term) || (c.phone || '').includes(term),
  );

  return (
    <>
      {customer ? (
        <div className="flex items-center gap-2 rounded-lg bg-brand-50 px-2.5 py-1.5">
          <UserRound size={14} className="shrink-0 text-brand-700" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-brand-900">{customer.name}</p>
            {customer.balance > 0.005 && (
              <p className="tnum text-[11px] text-brand-700">owes {money(customer.balance)}</p>
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
          <UserPlus size={14} /> Add customer
        </button>
      )}

      {customer && (
        <button
          onClick={() => setOpen(true)}
          className="mt-1 w-full text-left text-[11px] text-slate-400 transition hover:text-slate-600"
        >
          Change customer
        </button>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Choose a customer" size="md">
        <div className="relative mb-3">
          <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or phone…"
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
            description="Add customers from the back office to sell on account."
          />
        ) : (
          <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
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

        <div className="mt-3 flex justify-end">
          <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </Modal>
    </>
  );
}

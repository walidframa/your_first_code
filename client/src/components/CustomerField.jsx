import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, UserRound, X } from 'lucide-react';
import api from '../api';
import PartyQuickCreate from './PartyQuickCreate';
import { money } from './ui';
import { matchesSearch } from '../lib/search';

/**
 * Whose phone it is — chosen off the customer list, or simply typed.
 *
 * A repair had a name and nothing else, which meant the shop's best customer
 * and a stranger who walked in once looked identical on the ticket. Their
 * balance, their other repairs and everything the shop had ever done with them
 * were one screen away and joined to the ticket by nothing but a string.
 *
 * But a picker on its own would be worse than the string. Most repairs really
 * are strangers, and a form that insists on creating an account before it will
 * accept a cracked screen is a form the counter works around by creating
 * accounts called "man with iPhone".
 *
 * So this is one field that does both. Type, and matching customers appear —
 * choose one and the ticket is joined to their account. Choose nobody and the
 * name is taken as typed, which is what a walk-in is. And when the walk-in
 * turns out to be worth keeping, "New customer" makes the account from the name
 * already in the box, without losing the half-filled form around it.
 *
 * `value` is `{ customerId, customerName, customerPhone }` — the shape the
 * ticket is created with, so the caller holds no extra state.
 */
export default function CustomerField({ value, onChange, autoFocus = false, required = true }) {
  const [customers, setCustomers] = useState(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    api
      .get('/customers')
      .then((res) => setCustomers(res.data.parties))
      // A picker that cannot load its list must not stop the phone being taken
      // in — the typed name still works, which is what it did before there was
      // a list at all.
      .catch(() => setCustomers([]));
  }, []);

  /* Clicking anywhere else means "I meant what I typed". */
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (box.current && !box.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const term = (value.customerName || '').trim().toLowerCase();
  const matches = useMemo(() => {
    if (!customers) return [];
    return customers
      .filter(
        (c) =>
          matchesSearch(term, c.name, c.phone),
      )
      .slice(0, 8);
  }, [customers, term]);

  const chosen = value.customerId
    ? (customers || []).find((c) => c.id === value.customerId)
    : null;

  function pick(customer) {
    onChange({
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone || '',
    });
    setOpen(false);
  }

  function type(name) {
    // Typing over a chosen customer detaches the account: the name in the box
    // is no longer theirs, and a ticket silently still joined to them would be
    // charged to the wrong balance.
    onChange({ customerId: null, customerName: name, customerPhone: value.customerPhone });
    setOpen(true);
  }

  return (
    <div ref={box} className="relative">
      <div className="mb-1.5 flex items-center gap-3">
        <label htmlFor="repair-customer" className="block text-sm font-medium text-slate-700">
          Customer
        </label>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="-my-1 flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm font-medium text-brand-700 transition hover:bg-brand-50"
        >
          <Plus size={14} /> New customer
        </button>
      </div>

      <div className="relative">
        <input
          id="repair-customer"
          // Still `customerName`: it is the field it always was, and the thing
          // it posts has not changed — only that it now offers the list too.
          name="customerName"
          value={value.customerName || ''}
          onChange={(e) => type(e.target.value)}
          onFocus={() => setOpen(true)}
          autoFocus={autoFocus}
          required={required}
          autoComplete="off"
          placeholder="Search the customer list, or type a name"
          className="h-10 w-full rounded-lg bg-white px-3 pr-9 text-sm ring-1 ring-edge transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
        />
        {chosen && (
          <button
            type="button"
            onClick={() => onChange({ ...value, customerId: null })}
            aria-label="Take the account off this ticket"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {chosen ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-brand-700">
          <UserRound size={12} />
          On {chosen.name}&apos;s account
          {Math.abs(chosen.balance) > 0.005 && (
            <span className="text-slate-500">
              · {chosen.balance > 0 ? 'owes' : 'in credit'} {money(Math.abs(chosen.balance))}
            </span>
          )}
        </p>
      ) : (
        value.customerName?.trim() && (
          <p className="mt-1 text-xs text-slate-400">Walk-in — not joined to an account</p>
        )
      )}

      {open && matches.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg bg-white py-1 shadow-lg ring-1 ring-slate-200">
          {matches.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => pick(c)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition hover:bg-slate-50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-slate-800">{c.name}</span>
                  <span className="block text-xs text-slate-400">{c.phone || '—'}</span>
                </span>
                {Math.abs(c.balance) > 0.005 && (
                  <span className="tnum shrink-0 text-xs text-slate-500">
                    {c.balance > 0 ? 'owes' : 'credit'} {money(Math.abs(c.balance))}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <PartyQuickCreate
        open={creating}
        partyType="customer"
        onClose={() => setCreating(false)}
        onCreated={(party) => {
          setCustomers((list) => [...(list || []), { ...party, balance: party.balance ?? 0 }]);
          pick(party);
          setCreating(false);
        }}
      />
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { cx } from './ui';
import { matchesSearch } from '../lib/search';

/**
 * Choosing a customer or a supplier by typing some of their name.
 *
 * A plain drop-down is fine for forty names and useless for four hundred: the
 * person writing the invoice knows who it is for and has to scroll past
 * everybody else to reach them. So the box is typed into, and the list under
 * it narrows as they type — words in any order, name or phone, the same
 * search every other screen has.
 *
 * `groups` is `[{ kind, heading, list }]`, in the order they should appear —
 * the document's own side first. `value` is `{ kind, id }` or null, and
 * `onChange` gets the same shape, because customer 12 and supplier 12 are two
 * different people.
 */
export default function PartyCombobox({ id, value, groups, onChange, placeholder, autoFocus = false }) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const box = useRef(null);
  const input = useRef(null);

  const chosen = useMemo(() => {
    if (!value?.id) return null;
    const group = groups.find((g) => g.kind === value.kind);
    return group?.list.find((p) => String(p.id) === String(value.id)) || null;
  }, [groups, value]);

  /* Closing means "I meant what I picked": the text goes back to the name. */
  useEffect(() => {
    if (!open) setTerm(chosen ? chosen.name : '');
  }, [open, chosen]);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (box.current && !box.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  /* The list narrowed to the words typed, flattened so the keyboard can walk it. */
  const rows = useMemo(() => {
    const query = open && term !== (chosen?.name ?? '') ? term : '';
    const out = [];
    for (const g of groups) {
      const hits = g.list.filter((p) => matchesSearch(query, p.name, p.phone)).slice(0, query ? 12 : 40);
      if (hits.length) out.push({ heading: g.heading, kind: g.kind, hits });
    }
    return out;
  }, [groups, term, open, chosen]);
  const flat = useMemo(() => rows.flatMap((r) => r.hits.map((p) => ({ kind: r.kind, party: p }))), [rows]);

  useEffect(() => {
    setHighlight(0);
  }, [term]);

  function pick(kind, party) {
    onChange({ kind, id: String(party.id) });
    setOpen(false);
    setTerm(party.name);
  }

  function clear() {
    onChange(null);
    setTerm('');
    setOpen(true);
    input.current?.focus();
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(0, flat.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault();
      const hit = flat[highlight];
      if (hit) pick(hit.kind, hit.party);
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    }
  }

  return (
    <div ref={box} className="relative">
      <div className="relative">
        <input
          ref={input}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          autoComplete="off"
          autoFocus={autoFocus}
          value={term}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setTerm(e.target.value);
            setOpen(true);
            /* Typing over a chosen name un-chooses them until a new one is picked. */
            if (chosen && e.target.value !== chosen.name) onChange(null);
          }}
          onKeyDown={onKey}
          className={cx(
            'h-10 w-full rounded-lg bg-white pl-3 pr-16 text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none',
            chosen ? 'text-slate-900' : 'text-slate-700',
          )}
        />
        <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
          {chosen && (
            <button
              type="button"
              onClick={clear}
              aria-label="Clear"
              className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            >
              <X size={14} />
            </button>
          )}
          <button
            type="button"
            tabIndex={-1}
            aria-label="Show the list"
            onClick={() => {
              setOpen((o) => !o);
              input.current?.focus();
            }}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <ChevronDown size={16} />
          </button>
        </div>
      </div>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-y-auto rounded-xl bg-white py-1 shadow-lg ring-1 ring-slate-200"
        >
          {flat.length === 0 && (
            <p className="px-3 py-2 text-sm text-slate-500">Nobody called that. Add them with the button above.</p>
          )}
          {rows.map((r) => (
            <div key={r.kind}>
              <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
                {r.heading}
              </p>
              {r.hits.map((p) => {
                const index = flat.findIndex((f) => f.kind === r.kind && f.party.id === p.id);
                const active = index === highlight;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-party-option={`${r.kind}:${p.id}`}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => pick(r.kind, p)}
                    className={cx(
                      'flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm',
                      active ? 'bg-brand-50 text-brand-900' : 'text-slate-800 hover:bg-slate-50',
                    )}
                  >
                    <span className="truncate">{p.name}</span>
                    {p.phone && <span className="shrink-0 text-xs text-slate-400">{p.phone}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

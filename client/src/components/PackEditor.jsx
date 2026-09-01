import { useMemo, useState } from 'react';
import { Minus, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import { Button, Modal, ModalActions, cx, money } from './ui';
import { matchesSearch } from '../lib/search';

/**
 * Changing what goes in a pack, for this sale only.
 *
 * The reason a shop sells packs at all is that most of what is in one is the
 * same every time and one thing is not: the customer wants the blue case. Until
 * this existed the counter had two answers, and both were bad — refuse them, or
 * sell the pack and correct the shelves by hand afterwards, which nobody does
 * on a Saturday and which is how a stock count stops being worth taking.
 *
 * Deliberately **not** editing the product. A cashier swapping a case for one
 * customer must not redefine the pack for every customer after them, and the
 * back office is where a definition changes. What comes out of here belongs to
 * this line of this sale, and the server freezes it against the sold line so a
 * refund puts back what actually went out.
 *
 * The price does not move. A pack is one line at one price agreed with the
 * person standing there — that is what a pack *is* — and a swap that silently
 * repriced it would produce a total nobody had agreed to. If the blue case is
 * worth more, the price beside it is already editable on the line.
 */
export default function PackEditor({ item, products, onClose, onSave }) {
  /* What the line currently carries, which is the definition until it is not. */
  const [parts, setParts] = useState(() =>
    (item.components || item.bundleOf || []).map((p) => ({
      productId: p.productId,
      name: p.name,
      quantity: Number(p.quantity) || 1,
    })),
  );
  const [search, setSearch] = useState('');

  /*
   * What may go in: anything on the shelf that is not itself a pack, and not
   * something already in this one. Packs of packs are refused by the server for
   * the same reason they are refused in the back office — a tree somebody has
   * to hold in their head at a counter — so they are not offered here either,
   * rather than offered and then rejected.
   */
  const chosen = new Set(parts.map((p) => p.productId));
  const term = search.trim().toLowerCase();
  const candidates = useMemo(
    () =>
      (products || [])
        .filter(
          (p) =>
            !p.isBundle &&
            p.id !== item.productId &&
            !chosen.has(p.id) &&
            (!term ||
              matchesSearch(term, p.name, p.sku)),
        )
        .slice(0, 8),
    // `chosen` is derived from `parts` and changes with it.
    [products, term, parts, item.productId],
  );

  const stockOf = (productId) => products.find((p) => p.id === productId)?.stock ?? 0;

  /*
   * How many of this pack the shelves still allow, worked out here as well as on
   * the server. Not as a security check — the server does that — but so the
   * cashier finds out while they are still choosing, rather than by a refusal
   * after the customer has been told a price.
   */
  const canMake = parts.length
    ? Math.min(...parts.map((p) => Math.floor(stockOf(p.productId) / (p.quantity || 1))))
    : 0;
  const short = parts.filter((p) => stockOf(p.productId) < p.quantity * item.quantity);

  const setQuantity = (productId, quantity) =>
    setParts((list) =>
      list.map((p) => (p.productId === productId ? { ...p, quantity: Math.max(1, quantity) } : p)),
    );

  const original = item.bundleOf || [];
  const changed =
    parts.length !== original.length ||
    parts.some(
      (p) => (original.find((o) => o.productId === p.productId)?.quantity ?? null) !== p.quantity,
    );

  return (
    <Modal
      open
      onClose={onClose}
      title={`What goes in ${item.name}`}
      subtitle="For this sale only — the pack itself is not changed"
      size="lg"
    >
      <ul className="divide-y divide-rule rounded-xl ring-1 ring-slate-200">
        {parts.length === 0 ? (
          <li className="px-3 py-6 text-center text-sm text-slate-400">
            Nothing in it. Add at least one thing, or cancel to leave the pack as it was.
          </li>
        ) : (
          parts.map((part) => {
            const have = stockOf(part.productId);
            const need = part.quantity * item.quantity;
            return (
              <li key={part.productId} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-800">{part.name}</p>
                  <p className={cx('text-xs', have < need ? 'text-red-600' : 'text-slate-400')}>
                    {have} on the shelf
                    {item.quantity > 1 && ` · ${need} needed for ${item.quantity}`}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setQuantity(part.productId, part.quantity - 1)}
                    disabled={part.quantity <= 1}
                    aria-label={`One fewer ${part.name}`}
                    className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-slate-600 transition hover:bg-slate-200 disabled:opacity-40"
                  >
                    <Minus size={13} />
                  </button>
                  <span className="tnum w-6 text-center text-sm font-medium">{part.quantity}</span>
                  <button
                    type="button"
                    onClick={() => setQuantity(part.productId, part.quantity + 1)}
                    aria-label={`One more ${part.name}`}
                    className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-slate-600 transition hover:bg-slate-200"
                  >
                    <Plus size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setParts((list) => list.filter((p) => p.productId !== part.productId))
                    }
                    aria-label={`Take ${part.name} out`}
                    className="ml-1 rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            );
          })
        )}
      </ul>

      <div className="mt-4">
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Put something else in…"
            aria-label="Search for something to put in the pack"
            className="h-10 w-full rounded-lg bg-slate-100 pr-3 pl-9 text-sm ring-1 ring-transparent transition focus:bg-white focus:ring-brand-600 focus:outline-none"
          />
        </div>

        {candidates.length > 0 && (
          <ul className="mt-2 max-h-48 divide-y divide-rule overflow-y-auto rounded-lg ring-1 ring-slate-200">
            {candidates.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    setParts((list) => [...list, { productId: p.id, name: p.name, quantity: 1 }]);
                    setSearch('');
                  }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition hover:bg-slate-50"
                >
                  <span className="min-w-0 truncate text-slate-700">{p.name}</span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {p.stock} left · {money(p.price)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        * Said before the sale rather than after it. The server refuses a pack
        * the shelves cannot make up, and a cashier who finds that out at the
        * payment screen has already told the customer a price.
        */}
      {short.length > 0 && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          Not enough {short.map((p) => p.name).join(', ')} — {canMake} of these can be made up.
        </p>
      )}

      <ModalActions>
        {changed && (
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              setParts(original.map((p) => ({ ...p, quantity: Number(p.quantity) || 1 })))
            }
          >
            <RotateCcw size={14} /> Back to normal
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          className="flex-1"
          disabled={parts.length === 0 || short.length > 0}
          onClick={() => onSave(parts)}
        >
          Put it in the bag
        </Button>
      </ModalActions>
    </Modal>
  );
}

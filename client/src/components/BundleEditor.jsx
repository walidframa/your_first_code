import { useEffect, useMemo, useState } from 'react';
import { Minus, Package, Plus, Search, Trash2 } from 'lucide-react';
import api from '../api';
import { Button, cx, money } from './ui';

/**
 * What a product is made of, when it is made of other products.
 *
 * A starter pack is a phone, a case and a screen protector at one price.
 * Nothing sits on a shelf called "starter pack" — so this screen is not
 * describing stock, it is describing a recipe, and the stock question becomes
 * "how many could we make up right now", answered by whichever shelf runs out
 * first.
 *
 * Saved with the product rather than on its own button, so a half-finished
 * recipe is never live: what is on this screen is what the product will be
 * when the form is saved.
 */
export default function BundleEditor({ productId, value, onChange, products }) {
  const [loaded, setLoaded] = useState(!productId);
  const [search, setSearch] = useState('');

  /*
   * Bundles cannot contain bundles, and nothing can contain itself. Both are
   * refused by the server; leaving them out of the list here means nobody has
   * to find that out by pressing Save.
   */
  const candidates = useMemo(
    () =>
      (products || [])
        .filter((p) => p.id !== productId && !p.isBundle && p.active !== false)
        .filter((p) => !value.some((c) => c.productId === p.id)),
    [products, productId, value],
  );

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return [];
    return candidates
      .filter(
        (p) => p.name.toLowerCase().includes(term) || (p.sku || '').toLowerCase().includes(term),
      )
      .slice(0, 20);
  }, [candidates, search]);

  useEffect(() => {
    if (!productId) return;
    let cancelled = false;
    api
      .get(`/products/${productId}/bundle`)
      .then((res) => {
        if (cancelled) return;
        /*
         * The name comes with it and is kept.
         *
         * It was being thrown away and looked up again against the catalogue
         * this screen happens to hold — which is one request that can be slow,
         * short, or missing an archived part, and any of those turned a row
         * into "#412". The server already said what it is called.
         */
        onChange(
          res.data.components.map((c) => ({
            productId: c.productId,
            quantity: c.quantity,
            name: c.name,
          })),
        );
        setLoaded(true);
      })
      // A product that has never been a bundle answers with nothing, which is
      // not an error — it is the ordinary case.
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
    // Only when the product changes: `onChange` is a new function every render
    // and depending on it would refetch for ever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  /*
   * How many of a part go into one of these.
   *
   * Kept as what was typed rather than coerced, so a box being cleared to
   * retype it does not snap back to 1 under the cursor; empty reads as nothing
   * everywhere it is used, and the stepper never goes below one.
   */
  const setQuantity = (productId, quantity) =>
    onChange(
      value.map((x) =>
        x.productId === productId
          ? { ...x, quantity: quantity === '' ? '' : Math.max(1, Number(quantity) || 1) }
          : x,
      ),
    );

  /* What the row itself carries first; the catalogue only as a fallback. */
  const nameOf = (id, carried) =>
    carried || (products || []).find((p) => p.id === id)?.name || `#${id}`;
  const productOf = (id) => (products || []).find((p) => p.id === id);

  /*
   * How many the shop could make up, worked out from the shelves in front of
   * us rather than asked of the server — so the number moves as the recipe is
   * edited and there is no round trip to wait on.
   */
  const canMake = value.length
    ? Math.max(
        0,
        Math.min(
          ...value.map((c) => {
            const stock = Number(productOf(c.productId)?.stock ?? 0);
            const per = Number(c.quantity) || 0;
            return per > 0 ? Math.floor(stock / per) : 0;
          }),
        ),
      )
    : null;

  const totalCost = value.reduce(
    (sum, c) => sum + (Number(productOf(c.productId)?.cost) || 0) * (Number(c.quantity) || 0),
    0,
  );

  if (!loaded) return null;

  return (
    <div className="col-span-2 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200 ring-inset">
      <div className="mb-1 flex items-center gap-2">
        <Package size={16} className="text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-800">Made of other products</h3>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        Leave this empty for an ordinary product. Add items and this becomes a bundle: selling one
        takes each of these off its own shelf, and its stock is however many can be made up.
      </p>

      {value.length > 0 && (
        <div className="mb-3 space-y-2">
          {value.map((c) => {
            const part = productOf(c.productId);
            const per = Number(c.quantity) || 0;
            const stock = Number(part?.stock ?? 0);
            return (
              <div
                key={c.productId}
                className="flex flex-wrap items-center gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">
                    {nameOf(c.productId, c.name)}
                  </p>
                  <p className="truncate text-xs text-slate-400">
                    {part?.sku ? `${part.sku} · ` : ''}
                    {stock} in stock
                    {part?.cost ? ` · ${money(part.cost)} each` : ''}
                  </p>
                </div>

                {/*
                  * How many of it go in one, as a stepper.
                  *
                  * It was a bare number box, and a wide one: `Input` puts the
                  * class it is handed on its own wrapper, which already carries
                  * `w-full`, and `w-full` wins — so the box took the whole row
                  * and squeezed the product's name down to nothing. A pack that
                  * does not say what is in it is a pack nobody can check.
                  */}
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setQuantity(c.productId, per - 1)}
                    disabled={per <= 1}
                    aria-label={`One fewer ${nameOf(c.productId, c.name)}`}
                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-600 transition hover:bg-slate-200 disabled:opacity-40"
                  >
                    <Minus size={14} />
                  </button>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={c.quantity}
                    onChange={(e) => setQuantity(c.productId, e.target.value)}
                    aria-label={`How many ${nameOf(c.productId, c.name)} in one`}
                    className="tnum h-8 w-14 rounded-lg bg-white px-2 text-center text-sm ring-1 ring-slate-300 transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setQuantity(c.productId, per + 1)}
                    aria-label={`One more ${nameOf(c.productId, c.name)}`}
                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-600 transition hover:bg-slate-200"
                  >
                    <Plus size={14} />
                  </button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onChange(value.filter((x) => x.productId !== c.productId))}
                    aria-label={`Take ${nameOf(c.productId, c.name)} out`}
                  >
                    <Trash2 size={14} className="text-red-600" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/*
        * Typed, not scrolled.
        *
        * This was a dropdown of the whole catalogue. That is fine for the
        * sixteen products a demo ships with and useless at the two thousand a
        * real shop has: the parts of a pack are three specific things somebody
        * already has in mind, and finding each of them meant scrolling an
        * alphabetical list past everything else the shop sells.
        *
        * The same shape as the search on the register, because it is the same
        * question — which product do you mean — and a shopkeeper should not
        * have to learn it twice.
        */}
      <div className="relative">
        <Search
          size={16}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
        />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search for something to put in it…"
          aria-label="Search for something to put in it"
          autoComplete="off"
          className="h-9 w-full rounded-lg bg-white pr-3 pl-9 text-sm ring-1 ring-slate-200 transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
        />
      </div>

      {search.trim() && (
        <ul className="mt-2 max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg bg-white ring-1 ring-slate-200">
          {matches.length === 0 ? (
            <li className="px-3 py-3 text-center text-sm text-slate-400">
              Nothing matches “{search.trim()}”.
            </li>
          ) : (
            matches.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    // The name is carried onto the row rather than looked up
                    // later — see nameOf above.
                    onChange([...value, { productId: p.id, quantity: 1, name: p.name }]);
                    setSearch('');
                  }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition hover:bg-slate-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-slate-800">{p.name}</span>
                    {p.sku && <span className="block text-xs text-slate-400">{p.sku}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {Number(p.stock ?? 0)} in stock
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}

      {value.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-200 pt-3 text-xs">
          <span className={cx('font-medium', canMake === 0 ? 'text-red-700' : 'text-slate-700')}>
            {canMake === 0 ? 'None can be made up right now' : `${canMake} can be made up`}
          </span>
          <span className="text-slate-500">Parts cost {money(totalCost)}</span>
        </div>
      )}
    </div>
  );
}

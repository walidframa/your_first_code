import { useEffect, useMemo, useState } from 'react';
import { Package, Plus, Trash2 } from 'lucide-react';
import api from '../api';
import { Button, Input, cx, money } from './ui';

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
  const [picking, setPicking] = useState('');

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

  useEffect(() => {
    if (!productId) return;
    let cancelled = false;
    api
      .get(`/products/${productId}/bundle`)
      .then((res) => {
        if (cancelled) return;
        onChange(
          res.data.components.map((c) => ({ productId: c.productId, quantity: c.quantity })),
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

  const nameOf = (id) => (products || []).find((p) => p.id === id)?.name || `#${id}`;
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
          {value.map((c) => (
            <div key={c.productId} className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200">
              <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                {nameOf(c.productId)}
                <span className="ml-2 text-xs text-slate-400">
                  {Number(productOf(c.productId)?.stock ?? 0)} in stock
                </span>
              </span>
              <Input
                type="number"
                min="1"
                step="1"
                value={c.quantity}
                onChange={(e) =>
                  onChange(
                    value.map((x) =>
                      x.productId === c.productId ? { ...x, quantity: e.target.value } : x,
                    ),
                  )
                }
                className="w-20"
                aria-label={`How many ${nameOf(c.productId)} in one`}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onChange(value.filter((x) => x.productId !== c.productId))}
                aria-label={`Take ${nameOf(c.productId)} out`}
              >
                <Trash2 size={14} className="text-red-600" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <select
          value={picking}
          onChange={(e) => setPicking(e.target.value)}
          className="h-9 min-w-0 flex-1 rounded-lg bg-white px-3 text-sm ring-1 ring-slate-200 focus:ring-brand-600 focus:outline-none"
        >
          <option value="">Add an item…</option>
          {candidates.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!picking}
          onClick={() => {
            onChange([...value, { productId: Number(picking), quantity: 1 }]);
            setPicking('');
          }}
        >
          <Plus size={14} /> Add
        </Button>
      </div>

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

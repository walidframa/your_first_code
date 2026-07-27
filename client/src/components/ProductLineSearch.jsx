import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Plus, Search, Sparkles } from 'lucide-react';
import { ProductThumb, cx, money } from './ui';

const MAX_RESULTS = 8;

/**
 * Type-to-find product picker for building a document line by line.
 *
 * Matches on name, SKU and barcode, so a scanner works here too. Enter picks
 * the highlighted result; when nothing matches, the same box offers to create
 * the product instead of sending you elsewhere.
 */
export default function ProductLineSearch({ products, onPick, onCreateNew, priceField = 'price' }) {
  const [term, setTerm] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);
  const blurTimer = useRef(null);

  const query = term.trim().toLowerCase();

  const results = useMemo(() => {
    if (!query) return [];
    return products
      .filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.sku.toLowerCase().includes(query) ||
          (p.barcode || '').includes(query),
      )
      .slice(0, MAX_RESULTS);
  }, [products, query]);

  useEffect(() => setHighlight(0), [term]);
  useEffect(() => () => clearTimeout(blurTimer.current), []);

  function choose(product) {
    onPick(product);
    setTerm('');
    setHighlight(0);
    inputRef.current?.focus();
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[highlight]) choose(results[highlight]);
      else if (query) onCreateNew(term.trim());
    } else if (e.key === 'Escape') {
      setTerm('');
    }
  }

  const showPanel = focused && query.length > 0;

  return (
    <div className="relative">
      <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
      <input
        ref={inputRef}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        // Delay so a click on a result lands before the panel closes.
        onBlur={() => {
          blurTimer.current = setTimeout(() => setFocused(false), 150);
        }}
        placeholder="Search products by name, SKU or barcode — or type a new name…"
        aria-label="Search products to add"
        className="h-10 w-full rounded-lg bg-white pr-3 pl-9 text-sm ring-1 ring-slate-300 transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
      />

      {showPanel && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-slate-200">
          {results.length > 0 ? (
            <ul className="max-h-72 overflow-y-auto">
              {results.map((p, i) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => choose(p)}
                    className={cx(
                      'flex w-full items-center gap-3 px-3 py-2 text-left transition',
                      i === highlight ? 'bg-brand-50' : 'hover:bg-slate-50',
                    )}
                  >
                    <ProductThumb product={p} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800">{p.name}</p>
                      <p className="text-xs text-slate-400">
                        {p.sku}
                        {p.barcode ? ` · ${p.barcode}` : ''} · {p.stock} in stock
                      </p>
                    </div>
                    <span className="tnum shrink-0 text-sm font-medium text-slate-700">
                      {money(p[priceField] ?? p.price)}
                    </span>
                    {i === highlight && <CornerDownLeft size={13} className="shrink-0 text-brand-600" />}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2.5 text-sm text-slate-500">
              No product matches “{term.trim()}”.
            </p>
          )}

          <button
            type="button"
            onClick={() => onCreateNew(term.trim())}
            className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2.5 text-left text-sm font-medium text-brand-700 transition hover:bg-brand-50"
          >
            <Sparkles size={14} />
            Create “{term.trim()}” as a new product
          </button>
        </div>
      )}
    </div>
  );
}

export function AddFreeTextButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
    >
      <Plus size={14} /> Free-text line
    </button>
  );
}

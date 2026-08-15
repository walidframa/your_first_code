import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, CornerDownLeft, Plus, Search, Sparkles } from 'lucide-react';
import { ProductThumb, cx, money } from './ui';

/*
 * Enough to scroll through, few enough not to build a thousand rows into the
 * page every time somebody puts the cursor in the box.
 */
const MAX_RESULTS = 50;

/**
 * The catalogue, browsable and searchable, for building a document line by line.
 *
 * It opens on focus with everything in it. Typing narrows on name, SKU and
 * barcode, so a scanner works here too; Enter picks the highlighted row; and
 * when nothing matches, the same panel offers to create the product rather
 * than sending anybody to another screen.
 *
 * It used to open only once something had been typed, which meant the shop had
 * to already know what it stocked in order to put it on an invoice — fine for
 * the register, where the stock is in a grid on the left, and no use at all in
 * a dialog where this box is the only way in.
 */
export default function ProductLineSearch({ products, onPick, onCreateNew, priceField = 'price' }) {
  const [term, setTerm] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);
  const blurTimer = useRef(null);

  const query = term.trim().toLowerCase();

  const results = useMemo(() => {
    const matching = query
      ? products.filter(
          (p) =>
            p.name.toLowerCase().includes(query) ||
            p.sku.toLowerCase().includes(query) ||
            (p.barcode || '').includes(query),
        )
      : products;
    return matching.slice(0, MAX_RESULTS);
  }, [products, query]);

  useEffect(() => setHighlight(0), [term]);
  useEffect(() => () => clearTimeout(blurTimer.current), []);

  /* Arrowing past the bottom of a fifty-row list has to bring the row with it. */
  const listRef = useRef(null);
  useEffect(() => {
    listRef.current?.children[highlight]?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

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

  const showPanel = focused;

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
        className="h-10 w-full rounded-lg bg-white pr-9 pl-9 text-sm ring-1 ring-slate-300 transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
      />
      <ChevronDown
        size={16}
        className={cx(
          'pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-slate-400 transition-transform',
          showPanel && 'rotate-180',
        )}
      />

      {showPanel && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-slate-200">
          {results.length > 0 ? (
            <ul ref={listRef} className="max-h-72 overflow-y-auto">
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
              {query ? `No product matches “${term.trim()}”.` : 'There is nothing in the catalogue yet.'}
            </p>
          )}

          {query ? (
            <button
              type="button"
              onClick={() => onCreateNew(term.trim())}
              className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2.5 text-left text-sm font-medium text-brand-700 transition hover:bg-brand-50"
            >
              <Sparkles size={14} />
              Create “{term.trim()}” as a new product
            </button>
          ) : (
            products.length > MAX_RESULTS && (
              <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-400">
                First {MAX_RESULTS} of {products.length} — type to find the rest.
              </p>
            )
          )}
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

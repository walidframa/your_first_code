import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, Search, Smartphone, X } from 'lucide-react';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import { useBranch } from '../context/BranchContext';
import { lbp, useSettings } from '../context/SettingsContext';
import { useLive } from '../lib/live';
import { matchesSearch } from '../lib/search';
import { stockScopeParams } from '../components/StockScope';
import BarcodeScanner, { ScanButton, canScan } from '../components/BarcodeScanner';
import { looksLikeImei, whereIs } from '../components/HandsetFinder';
import { Badge, ProductThumb, StockBadge, cx, money } from '../components/ui';

/**
 * Check an item.
 *
 * A customer holds up a phone case and asks "do you have this, how much".
 * The answer is three figures — how many, the price, the cost — and the
 * register is a till, the products page is a catalogue, and both carry
 * twenty things the question does not need. This page is the question and
 * nothing else: one box, the camera, and the matches as cards big enough
 * to read across a counter.
 *
 * Outside the shell on purpose. No rail, no tab bar, no tabs across the top:
 * on a phone it is a home-screen icon that opens straight on to the box,
 * and on the counter screen it is a window to leave open beside the till.
 */
const LIMIT = 40;

export default function Lookup() {
  const { can } = useAuth();
  const { branch, canSwitch, total } = useBranch();
  const { rate, toLbp } = useSettings();
  const [products, setProducts] = useState(null);
  const [search, setSearch] = useState('');
  const [scanning, setScanning] = useState(false);
  const [open, setOpen] = useState(null);
  const [handset, setHandset] = useState(null);
  const box = useRef(null);

  /* Costs for whoever may open the catalogue — the same gate as the products page. */
  const seesCost = can('catalogue');
  /* Every branch's shelf, side by side, when there is more than one to see. */
  const everyBranch = canSwitch && total > 1;

  const load = useCallback(async () => {
    const res = await api.get('/products', {
      params: { activeOnly: 'true', ...(everyBranch ? stockScopeParams('all') : {}) },
    });
    setProducts(res.data.products.filter((p) => !p.is_service));
  }, [everyBranch]);

  useEffect(() => {
    load();
  }, [load]);
  useLive(load);

  const term = search.trim();
  const matches = useMemo(() => {
    if (!products || !term) return [];
    const q = term.toLowerCase();
    const list = products.filter((p) => matchesSearch(q, p.name, p.sku, p.barcodes));
    /* A code that is exactly one product's barcode goes to the top: that is a
       scan, and the scan wants its product, not the forty that share a word. */
    list.sort((a, b) => Number(hasCode(b, q)) - Number(hasCode(a, q)));
    return list.slice(0, LIMIT);
  }, [products, term]);

  /*
   * A long run of digits that matches nothing is an IMEI, and the handset
   * itself may be on the shelf — see HandsetFinder. Looked up on its own,
   * after the catalogue has had its say, so a barcode never waits on it.
   */
  useEffect(() => {
    setHandset(null);
    if (!products || !term || matches.length > 0 || !looksLikeImei(term)) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      api
        .get('/units/find', { params: { imei: term } })
        .then((res) => live && setHandset(res.data))
        .catch(() => live && setHandset(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [products, term, matches.length]);

  function scanned(code) {
    setScanning(false);
    setSearch(code);
    setOpen(null);
  }

  function clear() {
    setSearch('');
    setOpen(null);
    box.current?.focus();
  }

  const priceLbp = (p) => (p.price_lbp ?? (rate > 0 ? toLbp(p.price) : null));

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50" data-lookup>
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <Link
            to="/"
            aria-label="Back to the app"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
          >
            <ArrowLeft size={18} />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold text-slate-900">Check an item</h1>
            <p className="truncate text-xs text-slate-500">
              {everyBranch ? 'Stock at every branch' : branch?.name ? `Stock at ${branch.name}` : 'Stock on hand'}
              {rate > 0 && ` · 1 USD = ${Number(rate).toLocaleString('en-US')} LL`}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-4">
        <div className="relative">
          <Search size={20} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-slate-400" />
          <input
            ref={box}
            autoFocus
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOpen(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') clear();
            }}
            placeholder="Name, SKU, barcode or IMEI…"
            aria-label="Search products"
            autoComplete="off"
            enterKeyHint="search"
            className="h-14 w-full rounded-2xl bg-white pr-24 pl-12 text-lg shadow-sm ring-1 ring-slate-200 placeholder:text-slate-400 focus:ring-2 focus:ring-brand-600 focus:outline-none"
          />
          <div className="absolute inset-y-0 right-2 flex items-center gap-1">
            {search && (
              <button
                type="button"
                onClick={clear}
                aria-label="Clear"
                className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X size={18} />
              </button>
            )}
            {canScan() && (
              <ScanButton
                onClick={() => setScanning(true)}
                className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700 hover:bg-brand-100"
              />
            )}
          </div>
        </div>

        {products === null ? (
          <p className="mt-10 text-center text-sm text-slate-400">Loading the catalogue…</p>
        ) : !term ? (
          <div className="mt-14 text-center text-slate-400">
            <Search size={40} className="mx-auto mb-3 opacity-40" />
            <p className="text-sm">Type a name, SKU or barcode — or scan one.</p>
            <p className="mt-1 text-xs">{products.length.toLocaleString('en-US')} products on the shelf list</p>
          </div>
        ) : matches.length === 0 && !handset ? (
          <p className="mt-10 text-center text-sm text-slate-500" data-lookup-empty>
            Nothing called “{term}”.
          </p>
        ) : (
          <ul className="mt-4 space-y-2" data-lookup-results>
            {handset && <HandsetCard found={handset} />}
            {matches.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                exact={hasCode(p, term.toLowerCase())}
                open={open === p.id}
                onToggle={() => setOpen((cur) => (cur === p.id ? null : p.id))}
                seesCost={seesCost}
                priceLbp={priceLbp(p)}
              />
            ))}
            {matches.length === LIMIT && (
              <li className="py-2 text-center text-xs text-slate-400">Showing the first {LIMIT} — type more to narrow it.</li>
            )}
          </ul>
        )}
      </main>

      {scanning && <BarcodeScanner onCancel={() => setScanning(false)} onScanned={scanned} />}
    </div>
  );
}

const hasCode = (p, q) => (p.barcodes || []).some((b) => String(b).toLowerCase() === q) || String(p.sku || '').toLowerCase() === q;

function ProductCard({ product: p, exact, open, onToggle, seesCost, priceLbp }) {
  const basis = p.avg_cost ?? p.cost;
  const margin = p.price > 0 && basis > 0 ? Math.round(((p.price - basis) / p.price) * 100) : null;
  const card = p.wallet_id;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-lookup-product={p.id}
        className={cx(
          'flex w-full items-start gap-3 rounded-2xl bg-white p-3 text-left shadow-sm ring-1 transition',
          exact ? 'ring-brand-500 ring-2' : 'ring-slate-200 hover:ring-slate-300',
        )}
      >
        <ProductThumb product={p} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-slate-900">{p.name}</p>
          <p className="truncate text-xs text-slate-500">
            {[p.sku, p.barcode].filter(Boolean).join(' · ') || '—'}
            {p.category_name ? ` · ${p.category_name}` : ''}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {card ? (
              <Badge tone="brand">Card · {p.wallet_name}</Badge>
            ) : (
              <StockBadge stock={p.stock} reorderPoint={p.reorder_point} byBranch={p.stock_by_branch} />
            )}
            {seesCost && !card && (
              <span className="tnum text-xs text-slate-500">
                cost {money(p.cost)}
                {margin !== null && ` · ${margin}%`}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="tnum text-xl font-semibold text-slate-900">{money(p.price)}</p>
          {priceLbp !== null && <p className="tnum text-xs text-slate-500">{lbp(priceLbp)}</p>}
          {p.wholesale_price > 0 && (
            <p className="tnum text-xs text-slate-400">trade {money(p.wholesale_price)}</p>
          )}
        </div>
      </button>
      {open && (
        <dl className="mx-3 -mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-b-2xl bg-slate-100 px-4 pt-4 pb-3 text-xs text-slate-600">
          {(p.barcodes || []).length > 0 && (
            <Row label="Barcodes">{p.barcodes.join(', ')}</Row>
          )}
          {p.supplier && <Row label="Supplier">{p.supplier}</Row>}
          {seesCost && p.avg_cost !== null && p.avg_cost !== undefined && (
            <Row label="Average cost">{money(p.avg_cost)}</Row>
          )}
          {seesCost && p.last_cost !== null && p.last_cost !== undefined && (
            <Row label="Last paid">{money(p.last_cost)}</Row>
          )}
          {p.reorder_point > 0 && <Row label="Reorder at">{p.reorder_point}</Row>}
          {p.tracks_units === 1 || p.tracks_units === true ? <Row label="Tracked">by IMEI</Row> : null}
        </dl>
      )}
    </li>
  );
}

function HandsetCard({ found }) {
  const unit = found.unit;
  return (
    <li className="flex items-start gap-3 rounded-2xl bg-white p-3 shadow-sm ring-2 ring-brand-500" data-lookup-handset>
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
        <Smartphone size={22} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold text-slate-900">{unit?.product_name || 'Handset'}</p>
        <p className="text-sm text-slate-700">{whereIs(found)}</p>
        {unit && (
          <p className="tnum mt-1 text-xs text-slate-500">
            IMEI {unit.imei}
            {unit.imei2 ? ` · ${unit.imei2}` : ''}
            {unit.price > 0 ? ` · sells for ${money(unit.price)}` : ''}
          </p>
        )}
      </div>
    </li>
  );
}

function Row({ label, children }) {
  return (
    <>
      <dt className="text-slate-400">{label}</dt>
      <dd className="truncate text-slate-700">{children}</dd>
    </>
  );
}

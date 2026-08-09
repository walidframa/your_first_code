import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AlertTriangle, Minus, Plus, Printer, Search, Tag, Trash2, Truck } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { useSettings } from '../../context/SettingsContext';
import LabelSheet from '../../components/LabelSheet';
import { CUSTOM_LIMITS, LABEL_SIZES, customSize, perSheet } from '../../lib/labelLayout';
import { codeFor, hasSuspectCheckDigit } from '../../lib/barcode';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  ProductThumb,
  Select,
  Skeleton,
  cx,
  money,
  useToast,
} from '../../components/ui';

export default function Labels() {
  const toast = useToast();
  const { rate } = useSettings();
  const [searchParams, setSearchParams] = useSearchParams();

  const [products, setProducts] = useState(null);
  const [selection, setSelection] = useState([]); // [{ product, quantity }]
  const [search, setSearch] = useState('');
  const [sizeKey, setSizeKey] = useState('tiny');
  const [customW, setCustomW] = useState('40');
  const [customH, setCustomH] = useState('20');
  const [showLbp, setShowLbp] = useState(true);
  const [mode, setMode] = useState('sheet');
  const [sourceLabel, setSourceLabel] = useState('');

  // A custom size falls back to a preset while the typed values are unusable,
  // so the preview never blanks out mid-keystroke.
  const custom = customSize(customW, customH);
  const size = sizeKey === 'custom' ? custom || LABEL_SIZES.tiny : LABEL_SIZES[sizeKey];
  const fromDocument = searchParams.get('fromDocument');

  useEffect(() => {
    api.get('/products').then((res) => setProducts(res.data.products.filter((p) => p.active)));
  }, []);

  /**
   * Arriving from a purchase invoice preloads its lines with the quantities
   * received — the usual reason to print labels is that stock just came in.
   */
  useEffect(() => {
    if (!fromDocument || !products) return;

    api.get(`/documents/${fromDocument}`).then((res) => {
      const { document: doc, items } = res.data;
      const preloaded = items
        .filter((i) => i.product_id)
        .map((i) => ({
          product: products.find((p) => p.id === i.product_id),
          quantity: Math.max(1, Math.round(i.quantity)),
        }))
        .filter((entry) => entry.product);

      setSelection(preloaded);
      setSourceLabel(`${doc.doc_number} · ${doc.party_name || ''}`);
      if (preloaded.length === 0) toast('That document has no stocked products to label', 'warning');
    });
    // Clear the parameter so a later manual change is not overwritten on re-render.
    setSearchParams({}, { replace: true });
  }, [fromDocument, products, setSearchParams, toast]);

  const term = search.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!term || !products) return [];
    return products
      .filter(
        (p) =>
          p.name.toLowerCase().includes(term) ||
          p.sku.toLowerCase().includes(term) ||
          (p.barcode || '').includes(term),
      )
      .slice(0, 8);
  }, [products, term]);

  const addProduct = useCallback((product, quantity = 1) => {
    setSelection((prev) => {
      const i = prev.findIndex((e) => e.product.id === product.id);
      if (i !== -1) {
        return prev.map((e, idx) => (idx === i ? { ...e, quantity: e.quantity + quantity } : e));
      }
      return [...prev, { product, quantity }];
    });
  }, []);

  const setQuantity = (id, quantity) =>
    setSelection((prev) =>
      prev.flatMap((e) =>
        e.product.id === id ? (quantity <= 0 ? [] : [{ ...e, quantity }]) : [e],
      ),
    );

  /** Flatten to one entry per physical label. */
  const labels = useMemo(
    () => selection.flatMap((e) => Array.from({ length: e.quantity }, () => e.product)),
    [selection],
  );

  const suspect = selection.filter((e) => hasSuspectCheckDigit(e.product.barcode));
  const missingCode = selection.filter((e) => !codeFor(e.product));
  // On a label printer every label is its own page; on a sheet, as many as fit.
  const pages = mode === 'roll' ? labels.length : Math.ceil(labels.length / perSheet(size)) || 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Print labels"
        subtitle="Barcode and price labels for shelf edges and stock"
        actions={
          <Button disabled={labels.length === 0} onClick={() => window.print()}>
            <Printer size={16} /> Print {labels.length || ''} label{labels.length === 1 ? '' : 's'}
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-[380px_1fr] gap-6">
          {/* Picker */}
          <div className="no-print space-y-4">
            <Card className="p-4">
              <div className="relative">
                <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && matches[0]) {
                      addProduct(matches[0]);
                      setSearch('');
                    }
                  }}
                  placeholder="Search products to label…"
                  aria-label="Search products to label"
                  className="h-10 w-full rounded-lg bg-white pr-3 pl-9 text-sm ring-1 ring-slate-300 transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
                />
              </div>

              {matches.length > 0 && (
                <ul className="mt-2 divide-y divide-slate-100">
                  {matches.map((p) => (
                    <li key={p.id}>
                      <button
                        onClick={() => {
                          addProduct(p);
                          setSearch('');
                        }}
                        className="flex w-full items-center gap-2 py-2 text-left transition hover:bg-slate-50"
                      >
                        <ProductThumb product={p} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-800">{p.name}</p>
                          <p className="text-xs text-slate-400">{p.barcode || p.sku}</p>
                        </div>
                        <Plus size={14} className="shrink-0 text-brand-600" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {products && (
                <button
                  onClick={() => products.forEach((p) => addProduct(p))}
                  className="mt-3 text-xs font-medium text-brand-700 hover:underline"
                >
                  Add one of every product ({products.length})
                </button>
              )}
            </Card>

            <Card className="p-4">
              <p className="mb-1.5 text-sm font-medium text-slate-700">Printing onto</p>
              <div className="mb-4 grid grid-cols-2 gap-2">
                {[
                  {
                    key: 'roll',
                    title: 'Label printer',
                    hint: 'One label per page — rolls and die-cut labels',
                  },
                  {
                    key: 'sheet',
                    title: 'A4 label sheet',
                    hint: 'Many labels per page — Avery-style sheets',
                  },
                ].map((m) => (
                  <button
                    key={m.key}
                    onClick={() => setMode(m.key)}
                    className={cx(
                      'rounded-xl px-3 py-2.5 text-left ring-1 transition',
                      mode === m.key
                        ? 'bg-brand-600 text-white ring-brand-600'
                        : 'bg-white text-slate-700 ring-slate-300 hover:ring-slate-400',
                    )}
                  >
                    <span className="block text-sm font-medium">{m.title}</span>
                    <span className={cx('block text-[11px] leading-tight', mode === m.key ? 'opacity-90' : 'text-slate-500')}>
                      {m.hint}
                    </span>
                  </button>
                ))}
              </div>

              <Select label="Label size" value={sizeKey} onChange={(e) => setSizeKey(e.target.value)}>
                {Object.values(LABEL_SIZES).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
                <option value="custom">Custom size…</option>
              </Select>

              {sizeKey === 'custom' && (
                <div className="mt-3 flex items-end gap-2">
                  <Input
                    label="Width (mm)"
                    name="customW"
                    type="number"
                    min={CUSTOM_LIMITS.minWidth}
                    max={CUSTOM_LIMITS.maxWidth}
                    step="0.1"
                    value={customW}
                    onChange={(e) => setCustomW(e.target.value)}
                  />
                  <span className="pb-2.5 text-slate-400">×</span>
                  <Input
                    label="Height (mm)"
                    name="customH"
                    type="number"
                    min={CUSTOM_LIMITS.minHeight}
                    max={CUSTOM_LIMITS.maxHeight}
                    step="0.1"
                    value={customH}
                    onChange={(e) => setCustomH(e.target.value)}
                  />
                </div>
              )}
              {sizeKey === 'custom' && !custom && (
                <p className="mt-1.5 text-xs text-red-600">
                  Enter a width of {CUSTOM_LIMITS.minWidth}–{CUSTOM_LIMITS.maxWidth} mm and a height of{' '}
                  {CUSTOM_LIMITS.minHeight}–{CUSTOM_LIMITS.maxHeight} mm.
                </p>
              )}
              <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                {mode === 'roll'
                  ? `Each label prints on its own ${size.width} × ${size.height} mm page. In the print dialog set the paper size to match your labels and margins to none.`
                  : `Up to ${size.perRow} labels across an A4 page. Set scale to 100% — "fit to page" will shift them off the die-cut.`}
              </p>

              <label className="mt-3 flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={showLbp}
                  onChange={(e) => setShowLbp(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 accent-brand-600"
                />
                Show the price in LBP too
              </label>
            </Card>

            {sourceLabel && (
              <div className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <Truck size={15} className="shrink-0" />
                Loaded from {sourceLabel}
              </div>
            )}

            {(suspect.length > 0 || missingCode.length > 0) && (
              <div className="space-y-1.5 rounded-xl bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
                {suspect.length > 0 && (
                  <p className="flex gap-1.5">
                    <AlertTriangle size={14} className="mt-px shrink-0" />
                    <span>
                      {suspect.map((e) => e.product.name).join(', ')} — the barcode is the right length
                      for a retail code but its check digit is wrong. It will print as Code 128, which
                      scans, but not as the EAN-13 you may expect.
                    </span>
                  </p>
                )}
                {missingCode.length > 0 && (
                  <p className="flex gap-1.5">
                    <AlertTriangle size={14} className="mt-px shrink-0" />
                    <span>{missingCode.map((e) => e.product.name).join(', ')} — no barcode or SKU to encode.</span>
                  </p>
                )}
              </div>
            )}

            <Card>
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
                <p className="text-sm font-medium text-slate-800">
                  {labels.length} label{labels.length === 1 ? '' : 's'}
                  {pages > 0 && (
                    <span className="ml-1 text-xs text-slate-400">
                      · {mode === 'roll' ? '' : '~'}
                      {pages} page{pages === 1 ? '' : 's'}
                    </span>
                  )}
                </p>
                {selection.length > 0 && (
                  <button
                    onClick={() => {
                      setSelection([]);
                      setSourceLabel('');
                    }}
                    className="flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-red-600"
                  >
                    <Trash2 size={12} /> Clear
                  </button>
                )}
              </div>

              {selection.length === 0 ? (
                <EmptyState
                  icon={Tag}
                  title="Nothing selected"
                  description="Search above, or open a confirmed purchase invoice and choose Print labels."
                />
              ) : (
                <ul className="divide-y divide-slate-50">
                  {selection.map(({ product, quantity }) => (
                    <li key={product.id} className="flex items-center gap-2 px-3 py-2">
                      <ProductThumb product={product} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-800">{product.name}</p>
                        <p className="tnum text-xs text-slate-400">{money(product.price)}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setQuantity(product.id, quantity - 1)}
                          aria-label={`One fewer ${product.name}`}
                          className="flex h-6 w-6 items-center justify-center rounded bg-slate-100 text-slate-600 hover:bg-slate-200"
                        >
                          <Minus size={12} />
                        </button>
                        <input
                          value={quantity}
                          onChange={(e) => setQuantity(product.id, Math.max(0, Number(e.target.value) || 0))}
                          aria-label={`Label count for ${product.name}`}
                          className="tnum h-6 w-12 rounded bg-slate-100 text-center text-sm"
                        />
                        <button
                          onClick={() => setQuantity(product.id, quantity + 1)}
                          aria-label={`One more ${product.name}`}
                          className="flex h-6 w-6 items-center justify-center rounded bg-slate-100 text-slate-600 hover:bg-slate-200"
                        >
                          <Plus size={12} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* Preview — this is what actually goes to the printer */}
          <div>
            <p className="no-print mb-2 text-sm text-slate-500">
              Preview · {size.label}
              {labels.length > 0 && <Badge tone="neutral" className="ml-2">{labels.length} up</Badge>}
            </p>
            {!products ? (
              <Skeleton className="h-64" />
            ) : labels.length === 0 ? (
              <Card className="no-print">
                <EmptyState
                  icon={Printer}
                  title="Nothing to print yet"
                  description="Selected products will appear here exactly as they will be printed."
                />
              </Card>
            ) : (
              <div className="overflow-x-auto rounded-xl bg-white p-4 ring-1 ring-slate-200">
                <LabelSheet labels={labels} size={size} rate={rate} showLbp={showLbp} mode={mode} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

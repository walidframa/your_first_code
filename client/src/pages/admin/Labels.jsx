import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AlertTriangle, Minus, Plus, Printer, RotateCcw, Search, Tag, Trash2, Truck } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { useSettings } from '../../context/SettingsContext';
import { useAuth } from '../../context/AuthContext';
import LabelSheet from '../../components/LabelSheet';
import {
  CUSTOM_LIMITS,
  DEFAULT_STYLE,
  LABEL_PARTS,
  LABEL_SIZES,
  SCALE_LIMITS,
  customSize,
  normaliseStyle,
  overflows,
  perSheet,
  styleLayout,
} from '../../lib/labelLayout';
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

/** The preset that is exactly these dimensions, if there is one. */
function presetFor(width, height) {
  return Object.values(LABEL_SIZES).find((s) => s.width === width && s.height === height) || null;
}

export default function Labels() {
  const toast = useToast();
  const { rate, settings, refresh } = useSettings();
  const { can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [products, setProducts] = useState(null);
  const [selection, setSelection] = useState([]); // [{ product, quantity }]
  const [search, setSearch] = useState('');
  const [sizeKey, setSizeKey] = useState('tiny');
  const [customW, setCustomW] = useState('40');
  const [customH, setCustomH] = useState('20');
  const [mode, setMode] = useState('sheet');
  const [sourceLabel, setSourceLabel] = useState('');
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [savingStyle, setSavingStyle] = useState(false);

  const shopName = settings?.company_name || '';

  /*
   * The shop's saved design, once. Not a dependency of anything below, so a
   * later save does not reach back and undo what is on the screen.
   */
  const saved = settings?.label_style;
  useEffect(() => {
    if (!saved) return;
    let stored;
    try {
      stored = normaliseStyle(JSON.parse(saved));
    } catch {
      return; // A row edited into nonsense leaves the built-in design alone.
    }
    setStyle(stored);
    setMode(stored.mode);
    setCustomW(String(stored.width));
    setCustomH(String(stored.height));
    const preset = presetFor(stored.width, stored.height);
    setSizeKey(preset ? preset.key : 'custom');
    // Only the first read: after that the screen is the source of truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved !== undefined]);

  // A custom size falls back to a preset while the typed values are unusable,
  // so the preview never blanks out mid-keystroke.
  const custom = customSize(customW, customH);
  const base = sizeKey === 'custom' ? custom || LABEL_SIZES.tiny : LABEL_SIZES[sizeKey];
  // The chosen size, as the shop has styled it. This is what prints.
  const size = useMemo(() => styleLayout(base, style), [base, style]);
  const clipped = overflows(size);
  const fromDocument = searchParams.get('fromDocument');
  const fromProduct = searchParams.get('product');

  const setPart = (key, value) => setStyle((s) => ({ ...s, [key]: value }));

  async function saveStyle(next) {
    setSavingStyle(true);
    try {
      await api.put('/settings', {
        label_style: next === null ? null : { ...style, width: size.width, height: size.height, mode },
      });
      await refresh();
      if (next === null) {
        setStyle(DEFAULT_STYLE);
        setMode(DEFAULT_STYLE.mode);
        setCustomW(String(DEFAULT_STYLE.width));
        setCustomH(String(DEFAULT_STYLE.height));
        setSizeKey(presetFor(DEFAULT_STYLE.width, DEFAULT_STYLE.height)?.key || 'custom');
        toast('Back to the built-in label');
      } else {
        toast('Saved — this is what the shop prints now');
      }
    } catch (err) {
      toast(err.response?.data?.error || 'Could not save the design', 'error');
    } finally {
      setSavingStyle(false);
    }
  }

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

  /**
   * Arriving from a product that was just created or edited.
   *
   * The count comes with it — what was typed into the stock box is how many of
   * the thing are on the bench waiting for a label — and it is editable here
   * like any other, because the box that came in and the shelf are not always
   * the same number.
   */
  useEffect(() => {
    if (!fromProduct || !products) return;

    const product = products.find((p) => String(p.id) === String(fromProduct));
    const quantity = Math.max(1, Math.round(Number(searchParams.get('qty')) || 1));
    if (product) {
      setSelection([{ product, quantity }]);
      setSourceLabel(product.name);
    } else {
      toast('That product is not on the list to label', 'warning');
    }
    setSearchParams({}, { replace: true });
  }, [fromProduct, products, searchParams, setSearchParams, toast]);

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

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
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
                  className="h-10 w-full rounded-lg bg-white pr-3 pl-9 text-sm ring-1 ring-edge transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
                />
              </div>

              {matches.length > 0 && (
                <ul className="mt-2 divide-y divide-rule">
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
                        : 'bg-white text-slate-700 ring-edge hover:ring-slate-400',
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

            </Card>

            {/*
              * What is on the label, and how big.
              *
              * The sizes are multiples of what the label worked out for itself
              * rather than points typed in, so a design set on a 40 × 20 still
              * reads sensibly when the same shop prints a 70 × 42. The preview
              * beside this is the whole point — nothing here needs explaining
              * if you can see it change.
              */}
            <Card className="p-4">
              <p className="mb-2 text-sm font-medium text-slate-700">What is on the label</p>

              <div className="space-y-2.5">
                {LABEL_PARTS.map(([key, name]) => {
                  const scaleKey = `${key}Scale`;
                  const on = style[key] !== false;
                  return (
                    <div key={key} className="flex items-center gap-3">
                      <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => setPart(key, e.target.checked)}
                          className="h-4 w-4 shrink-0 rounded border-slate-300 accent-brand-600"
                        />
                        <span className="truncate">
                          {name}
                          {key === 'shop' && shopName && (
                            <span className="ml-1 text-xs text-slate-400">{shopName}</span>
                          )}
                        </span>
                      </label>
                      <input
                        type="range"
                        min={SCALE_LIMITS.min}
                        max={SCALE_LIMITS.max}
                        step="0.05"
                        disabled={!on}
                        value={style[scaleKey] ?? 1}
                        onChange={(e) => setPart(scaleKey, Number(e.target.value))}
                        aria-label={`Size of ${name.toLowerCase()}`}
                        className="w-24 accent-brand-600 disabled:opacity-40"
                      />
                      <span className="tnum w-10 shrink-0 text-right text-xs text-slate-400">
                        {Math.round((style[scaleKey] ?? 1) * 100)}%
                      </span>
                    </div>
                  );
                })}
              </div>

              {clipped && (
                <p className="mt-3 flex gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <AlertTriangle size={14} className="mt-px shrink-0" />
                  <span>
                    That is taller than a {size.width} × {size.height} mm label. The bottom of it will
                    be cut off — turn a line off, make one smaller, or use a taller label.
                  </span>
                </p>
              )}

              {can('settings') && (
                <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
                  <Button size="sm" className="flex-1" loading={savingStyle} onClick={() => saveStyle(style)}>
                    Save as the shop's label
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={savingStyle}
                    onClick={() => saveStyle(null)}
                    title="Back to the built-in design"
                    aria-label="Back to the built-in design"
                  >
                    <RotateCcw size={14} />
                  </Button>
                </div>
              )}
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
                <ul className="divide-y divide-rule">
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
                          className="touch-target flex h-6 w-6 items-center justify-center rounded bg-slate-100 text-slate-600 hover:bg-slate-200"
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
                          className="touch-target flex h-6 w-6 items-center justify-center rounded bg-slate-100 text-slate-600 hover:bg-slate-200"
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
                <LabelSheet
                  labels={labels}
                  size={size}
                  rate={rate}
                  showLbp={style.lbp !== false}
                  mode={mode}
                  shopName={shopName}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

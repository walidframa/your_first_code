import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  Ban,
  Check,
  ClipboardList,
  FileText,
  LayoutGrid,
  Plus,
  Printer,
  Receipt,
  Search,
  Trash2,
  Truck,
} from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { useSettings, lbp } from '../../context/SettingsContext';
import ProductLineSearch, { AddFreeTextButton } from '../../components/ProductLineSearch';
import ProductQuickCreate from '../../components/ProductQuickCreate';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  ProductThumb,
  Skeleton,
  cx,
  money,
  useToast,
} from '../../components/ui';

/** Each type's identity: icon, wording, and what confirming it will do. */
export const TYPE_META = {
  quotation: {
    label: 'Quotation',
    icon: FileText,
    tint: 'bg-violet-50 text-violet-700 ring-violet-200',
    active: 'bg-violet-600 text-white ring-violet-600',
    effect: 'An offer — nothing moves',
    party: 'customer',
  },
  sales_order: {
    label: 'Sales order',
    icon: ClipboardList,
    tint: 'bg-blue-50 text-blue-700 ring-blue-200',
    active: 'bg-blue-600 text-white ring-blue-600',
    effect: 'A commitment — nothing moves',
    party: 'customer',
  },
  sales_invoice: {
    label: 'Sales invoice',
    icon: Receipt,
    tint: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    active: 'bg-emerald-600 text-white ring-emerald-600',
    effect: 'Stock out, customer billed',
    party: 'customer',
  },
  purchase_invoice: {
    label: 'Purchase invoice',
    icon: Truck,
    tint: 'bg-amber-50 text-amber-700 ring-amber-200',
    active: 'bg-amber-600 text-white ring-amber-600',
    effect: 'Stock in, supplier owed',
    party: 'supplier',
  },
};

const STATUS_TONES = { draft: 'neutral', confirmed: 'good', cancelled: 'critical' };

function TypeIcon({ type, size = 16 }) {
  const Icon = TYPE_META[type]?.icon || FileText;
  return <Icon size={size} />;
}

/* --------------------------------------------------------------- new form */

function DocumentForm({ onClose, onSaved }) {
  const toast = useToast();
  const { rate, toLbp } = useSettings();

  const [docType, setDocType] = useState('purchase_invoice');
  const [parties, setParties] = useState([]);
  const [partyId, setPartyId] = useState('');
  const [products, setProducts] = useState([]);
  const [lines, setLines] = useState([]);
  const [discountPercent, setDiscountPercent] = useState(0);
  const [onAccount, setOnAccount] = useState(true);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [quickCreate, setQuickCreate] = useState(null);

  const meta = TYPE_META[docType];
  const partyType = meta.party;
  const isInvoice = docType.endsWith('invoice');
  const priceField = docType === 'purchase_invoice' ? 'cost' : 'price';

  const loadProducts = useCallback(
    () => api.get('/products').then((res) => setProducts(res.data.products.filter((p) => p.active))),
    [],
  );

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  useEffect(() => {
    setPartyId('');
    api.get(`/${partyType}s`).then((res) => setParties(res.data.parties));
  }, [partyType]);

  /** Re-price product lines when switching between cost-based and price-based types. */
  useEffect(() => {
    setLines((prev) =>
      prev.map((l) => {
        if (!l.product) return l;
        return { ...l, price: String(l.product[priceField] ?? l.product.price ?? 0) };
      }),
    );
  }, [priceField]);

  function addProduct(product) {
    setLines((prev) => {
      const existing = prev.findIndex((l) => l.product?.id === product.id);
      if (existing !== -1) {
        return prev.map((l, i) =>
          i === existing ? { ...l, quantity: String(Number(l.quantity || 0) + 1) } : l,
        );
      }
      return [
        ...prev,
        {
          key: `p${product.id}-${Date.now()}`,
          product,
          name: product.name,
          quantity: '1',
          price: String(product[priceField] ?? product.price ?? 0),
        },
      ];
    });
  }

  function addFreeText() {
    setLines((prev) => [
      ...prev,
      { key: `f${Date.now()}`, product: null, name: '', quantity: '1', price: '' },
    ]);
  }

  const updateLine = (key, patch) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const priced = lines.map((l) => ({
    ...l,
    lineTotal: (Number(l.quantity) || 0) * (Number(l.price) || 0),
  }));
  const subtotal = priced.reduce((sum, l) => sum + l.lineTotal, 0);
  const discount = subtotal * ((Number(discountPercent) || 0) / 100);
  const tax = (subtotal - discount) * 0.08;
  const total = subtotal - discount + tax;

  const valid =
    partyId &&
    lines.length > 0 &&
    lines.every((l) => (l.product || l.name.trim()) && Number(l.quantity) > 0 && Number(l.price) >= 0);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.post('/documents', {
        docType,
        partyId: Number(partyId),
        discountPercent: Number(discountPercent) || 0,
        onAccount,
        notes: notes || null,
        items: lines.map((l) => ({
          productId: l.product?.id ?? null,
          name: l.product ? undefined : l.name,
          quantity: Number(l.quantity),
          price: Number(l.price),
        })),
      });
      toast(`${meta.label} ${res.data.document.doc_number} created`);
      onSaved(res.data.document.id);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create document');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Modal open onClose={onClose} title="New document" size="xl">
        <form onSubmit={submit} className="space-y-4">
          {/* Type is picked by icon — it decides everything else on this form. */}
          <div className="grid grid-cols-4 gap-2">
            {Object.entries(TYPE_META).map(([key, m]) => {
              const Icon = m.icon;
              const selected = docType === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setDocType(key)}
                  className={cx(
                    'flex flex-col items-center gap-1.5 rounded-xl px-2 py-3 text-center ring-1 transition',
                    selected ? m.active : `${m.tint} hover:brightness-95`,
                  )}
                >
                  <Icon size={20} />
                  <span className="text-xs leading-tight font-medium">{m.label}</span>
                  <span className={cx('text-[10px] leading-tight', selected ? 'opacity-90' : 'opacity-70')}>
                    {m.effect}
                  </span>
                </button>
              );
            })}
          </div>

          <div>
            <label htmlFor="doc-party" className="mb-1.5 block text-sm font-medium text-slate-700">
              {partyType === 'supplier' ? 'Supplier' : 'Customer'}
            </label>
            <select
              id="doc-party"
              value={partyId}
              onChange={(e) => setPartyId(e.target.value)}
              className="h-10 w-full rounded-lg bg-white px-3 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
            >
              <option value="">Choose a {partyType}…</option>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">Add items</p>
            <ProductLineSearch
              products={products}
              priceField={priceField}
              onPick={addProduct}
              onCreateNew={(name) => setQuickCreate(name)}
            />

            {lines.length > 0 && (
              <div className="mt-3 overflow-hidden rounded-xl ring-1 ring-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Item</th>
                      <th className="w-20 px-2 py-2 text-right font-medium">Qty</th>
                      <th className="w-28 px-2 py-2 text-right font-medium">
                        {priceField === 'cost' ? 'Cost' : 'Price'}
                      </th>
                      <th className="w-24 px-2 py-2 text-right font-medium">Total</th>
                      <th className="w-10 px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {priced.map((l) => (
                      <tr key={l.key}>
                        <td className="px-3 py-2">
                          {l.product ? (
                            <div className="flex items-center gap-2">
                              <ProductThumb product={l.product} size="sm" />
                              <div className="min-w-0">
                                <p className="truncate font-medium text-slate-800">{l.product.name}</p>
                                <p className="text-xs text-slate-400">{l.product.sku}</p>
                              </div>
                            </div>
                          ) : (
                            <input
                              value={l.name}
                              onChange={(e) => updateLine(l.key, { name: e.target.value })}
                              placeholder="Description (e.g. delivery)"
                              aria-label="Line description"
                              className="h-8 w-full rounded-lg bg-white px-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                            />
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={l.quantity}
                            onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                            aria-label={`Quantity for ${l.product?.name || l.name || 'line'}`}
                            className="h-8 w-full rounded-lg bg-white px-2 text-right text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                          />
                        </td>
                        <td className="px-2 py-2">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={l.price}
                            onChange={(e) => updateLine(l.key, { price: e.target.value })}
                            aria-label={`Unit price for ${l.product?.name || l.name || 'line'}`}
                            className="h-8 w-full rounded-lg bg-white px-2 text-right text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                          />
                        </td>
                        <td className="tnum px-2 py-2 text-right font-medium text-slate-800">
                          {money(l.lineTotal)}
                        </td>
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                            aria-label="Remove line"
                            className="rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-2 flex items-center gap-1">
              <AddFreeTextButton onClick={addFreeText} />
              <button
                type="button"
                onClick={() => setQuickCreate('')}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-brand-700 transition hover:bg-brand-50"
              >
                <Plus size={14} /> New product
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <Input
                label="Discount %"
                type="number"
                min="0"
                max="100"
                value={discountPercent}
                onChange={(e) => setDiscountPercent(e.target.value)}
              />
              <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
              {isInvoice && (
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={onAccount}
                    onChange={(e) => setOnAccount(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 accent-brand-600"
                  />
                  Put on account (untick if paid immediately)
                </label>
              )}
            </div>

            <dl className="space-y-1 self-end rounded-xl bg-slate-50 px-4 py-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Subtotal</dt>
                <dd className="tnum text-slate-700">{money(subtotal)}</dd>
              </div>
              {discount > 0 && (
                <div className="flex justify-between">
                  <dt className="text-slate-500">Discount</dt>
                  <dd className="tnum text-slate-700">−{money(discount)}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-slate-500">Tax</dt>
                <dd className="tnum text-slate-700">{money(tax)}</dd>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold">
                <dt className="text-slate-900">Total</dt>
                <dd className="tnum text-slate-900">{money(total)}</dd>
              </div>
              {rate > 0 && (
                <div className="flex justify-between text-xs">
                  <dt className="text-slate-400">In pounds</dt>
                  <dd className="tnum text-slate-500">{lbp(toLbp(total))}</dd>
                </div>
              )}
            </dl>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={!valid} loading={saving}>
              Create draft
            </Button>
          </div>
        </form>
      </Modal>

      <ProductQuickCreate
        open={quickCreate !== null}
        initialName={quickCreate || ''}
        onClose={() => setQuickCreate(null)}
        onCreated={(product) => {
          setQuickCreate(null);
          loadProducts();
          addProduct(product);
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ detail */

function DocumentDetail({ id, onClose, onChanged }) {
  const toast = useToast();
  const { rate, toLbp } = useSettings();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.get(`/documents/${id}`).then((res) => setData(res.data));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(path, body, successMessage) {
    setError('');
    setBusy(true);
    try {
      await api.post(`/documents/${id}/${path}`, body);
      toast(successMessage);
      if (path === 'convert') {
        onChanged();
        onClose();
        return;
      }
      load();
      onChanged();
    } catch (err) {
      setError(err.response?.data?.error || 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <Modal open onClose={onClose} title="Loading…">
        <Skeleton className="h-40" />
      </Modal>
    );
  }

  const { document: doc, items, convertedTo } = data;
  const meta = TYPE_META[doc.doc_type];
  const canConvert = doc.doc_type === 'quotation' || doc.doc_type === 'sales_order';

  return (
    <Modal
      open
      onClose={onClose}
      title={`${meta.label} ${doc.doc_number}`}
      subtitle={`${doc.party_name || '—'} · ${doc.issue_date}`}
      size="lg"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className={cx('rounded-lg p-1.5 ring-1', meta.tint)}>
          <TypeIcon type={doc.doc_type} size={15} />
        </span>
        <Badge tone={STATUS_TONES[doc.status]}>{doc.status}</Badge>
        {doc.on_account && doc.doc_type.endsWith('invoice') && <Badge tone="info">On account</Badge>}
        {doc.converted_from_number && (
          <span className="text-xs text-slate-400">from {doc.converted_from_number}</span>
        )}
        {convertedTo.map((c) => (
          <span key={c.id} className="text-xs text-slate-400">
            → {c.doc_number}
          </span>
        ))}
      </div>

      <table className="w-full text-sm">
        <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
          <tr>
            <th className="py-1.5 font-medium">Item</th>
            <th className="py-1.5 text-right font-medium">Qty</th>
            <th className="py-1.5 text-right font-medium">Price</th>
            <th className="py-1.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {items.map((i) => (
            <tr key={i.id}>
              <td className="py-1.5 text-slate-700">
                {i.name}
                {i.sku && <span className="ml-1 text-xs text-slate-400">{i.sku}</span>}
              </td>
              <td className="tnum py-1.5 text-right text-slate-600">{i.quantity}</td>
              <td className="tnum py-1.5 text-right text-slate-600">{money(i.price)}</td>
              <td className="tnum py-1.5 text-right font-medium text-slate-800">{money(i.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-slate-500">Subtotal</dt>
          <dd className="tnum text-slate-700">{money(doc.subtotal)}</dd>
        </div>
        {doc.discount > 0 && (
          <div className="flex justify-between">
            <dt className="text-slate-500">Discount</dt>
            <dd className="tnum text-slate-700">−{money(doc.discount)}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-slate-500">Tax</dt>
          <dd className="tnum text-slate-700">{money(doc.tax)}</dd>
        </div>
        <div className="flex justify-between text-base font-semibold">
          <dt className="text-slate-900">Total</dt>
          <dd className="tnum text-slate-900">{money(doc.total)}</dd>
        </div>
        {rate > 0 && (
          <div className="flex justify-between text-xs">
            <dt className="text-slate-400">In pounds</dt>
            <dd className="tnum text-slate-500">{lbp(toLbp(doc.total))}</dd>
          </div>
        )}
      </dl>

      {doc.notes && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{doc.notes}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="no-print mt-5 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => window.print()} aria-label="Print">
          <Printer size={15} />
        </Button>

        {doc.status === 'draft' && (
          <Button loading={busy} onClick={() => act('confirm', null, `${doc.doc_number} confirmed`)}>
            <Check size={15} /> Confirm
          </Button>
        )}

        {canConvert && doc.status !== 'cancelled' && (
          <Button
            variant="secondary"
            loading={busy}
            onClick={() =>
              act(
                'convert',
                { docType: doc.doc_type === 'quotation' ? 'sales_order' : 'sales_invoice' },
                'Converted',
              )
            }
          >
            <ArrowRight size={15} />
            {doc.doc_type === 'quotation' ? 'To sales order' : 'To invoice'}
          </Button>
        )}

        {doc.status !== 'cancelled' && (
          <Button
            variant="danger"
            loading={busy}
            onClick={() => act('cancel', null, `${doc.doc_number} cancelled`)}
          >
            <Ban size={15} /> Cancel
          </Button>
        )}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------- list */

export default function Documents() {
  const [documents, setDocuments] = useState(null);
  const [counts, setCounts] = useState({});
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState(null);

  const load = useCallback(() => {
    // Load everything once so the tiles can show per-type counts.
    api.get('/documents').then((res) => {
      const all = res.data.documents;
      setDocuments(all);
      setCounts(
        all.reduce((acc, d) => {
          acc[d.doc_type] = (acc[d.doc_type] || 0) + 1;
          return acc;
        }, {}),
      );
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const term = search.trim().toLowerCase();
  const visible = (documents || []).filter(
    (d) =>
      (filter === 'all' || d.doc_type === filter) &&
      (!term ||
        d.doc_number.toLowerCase().includes(term) ||
        (d.party_name || '').toLowerCase().includes(term)),
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Documents"
        subtitle="Quotations, sales orders, sales invoices and purchase invoices"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> New document
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {/* Type tiles double as the filter. */}
        <div className="mb-4 grid grid-cols-5 gap-3">
          <button
            onClick={() => setFilter('all')}
            className={cx(
              'flex flex-col items-start gap-1.5 rounded-xl px-4 py-3 text-left ring-1 transition',
              filter === 'all'
                ? 'bg-slate-900 text-white ring-slate-900'
                : 'bg-white text-slate-600 ring-slate-200 hover:ring-slate-300',
            )}
          >
            <LayoutGrid size={18} />
            <span className="text-sm font-medium">All</span>
            <span className={cx('tnum text-xs', filter === 'all' ? 'opacity-80' : 'text-slate-400')}>
              {documents?.length ?? '—'}
            </span>
          </button>

          {Object.entries(TYPE_META).map(([key, m]) => {
            const Icon = m.icon;
            const selected = filter === key;
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={cx(
                  'flex flex-col items-start gap-1.5 rounded-xl px-4 py-3 text-left ring-1 transition',
                  selected ? m.active : `bg-white ring-slate-200 hover:ring-slate-300 ${m.tint.split(' ')[1]}`,
                )}
              >
                <Icon size={18} />
                <span className="text-sm leading-tight font-medium">{m.label}</span>
                <span className={cx('tnum text-xs', selected ? 'opacity-80' : 'text-slate-400')}>
                  {counts[key] ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        <Card>
          <div className="border-b border-slate-100 px-5 py-3">
            <div className="relative">
              <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by number or name…"
                className="h-9 w-full rounded-lg bg-slate-100 pr-3 pl-9 text-sm ring-1 ring-transparent transition focus:bg-white focus:ring-brand-600 focus:outline-none"
              />
            </div>
          </div>

          {!documents ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No documents"
              description="Create a quotation, invoice or purchase invoice to get started."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Number</th>
                  <th className="px-3 py-2.5 font-medium">Type</th>
                  <th className="px-3 py-2.5 font-medium">Party</th>
                  <th className="px-3 py-2.5 font-medium">Date</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {visible.map((d) => (
                  <tr key={d.id} onClick={() => setViewing(d.id)} className="cursor-pointer hover:bg-slate-50/60">
                    <td className="px-5 py-2.5 font-medium text-slate-800">{d.doc_number}</td>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-1.5 text-slate-500">
                        <span className={cx('rounded p-1', TYPE_META[d.doc_type]?.tint)}>
                          <TypeIcon type={d.doc_type} size={13} />
                        </span>
                        {TYPE_META[d.doc_type]?.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-500">{d.party_name || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-500">{d.issue_date}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={STATUS_TONES[d.status]}>{d.status}</Badge>
                    </td>
                    <td className="tnum px-5 py-2.5 text-right font-semibold text-slate-900">
                      {money(d.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {creating && (
        <DocumentForm
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            load();
            setViewing(id);
          }}
        />
      )}

      {viewing && <DocumentDetail id={viewing} onClose={() => setViewing(null)} onChanged={load} />}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  Ban,
  Check,
  FileText,
  Plus,
  Printer,
  Search,
  Trash2,
} from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { useSettings, lbp } from '../../context/SettingsContext';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  Select,
  Skeleton,
  cx,
  money,
  useToast,
} from '../../components/ui';

const TYPE_LABELS = {
  quotation: 'Quotation',
  sales_order: 'Sales order',
  sales_invoice: 'Sales invoice',
  purchase_invoice: 'Purchase invoice',
};

const STATUS_TONES = { draft: 'neutral', confirmed: 'good', cancelled: 'critical' };

function DocumentForm({ onClose, onSaved }) {
  const toast = useToast();
  const { rate, toLbp } = useSettings();

  const [docType, setDocType] = useState('purchase_invoice');
  const [parties, setParties] = useState([]);
  const [partyId, setPartyId] = useState('');
  const [products, setProducts] = useState([]);
  const [lines, setLines] = useState([{ productId: '', name: '', quantity: 1, price: '' }]);
  const [discountPercent, setDiscountPercent] = useState(0);
  const [onAccount, setOnAccount] = useState(true);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const partyType = docType === 'purchase_invoice' ? 'supplier' : 'customer';
  const isInvoice = docType.endsWith('invoice');

  useEffect(() => {
    api.get('/products').then((res) => setProducts(res.data.products.filter((p) => p.active)));
  }, []);

  useEffect(() => {
    setPartyId('');
    api.get(`/${partyType}s`).then((res) => setParties(res.data.parties));
  }, [partyType]);

  function updateLine(index, patch) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function pickProduct(index, id) {
    const product = products.find((p) => String(p.id) === String(id));
    updateLine(index, {
      productId: id,
      name: product?.name || '',
      price: product ? (docType === 'purchase_invoice' ? product.cost : product.price) : '',
    });
  }

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
    lines.every((l) => (l.productId || l.name.trim()) && Number(l.quantity) > 0 && Number(l.price) >= 0);

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
          productId: l.productId ? Number(l.productId) : null,
          name: l.name || undefined,
          quantity: Number(l.quantity),
          price: Number(l.price),
        })),
      });
      toast(`${TYPE_LABELS[docType]} ${res.data.document.doc_number} created`);
      onSaved(res.data.document.id);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create document');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="New document" size="xl">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Select label="Type" value={docType} onChange={(e) => setDocType(e.target.value)}>
            {Object.entries(TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Select
            label={partyType === 'supplier' ? 'Supplier' : 'Customer'}
            value={partyId}
            onChange={(e) => setPartyId(e.target.value)}
          >
            <option value="">Choose a {partyType}…</option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700">Lines</p>
          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="flex-1">
                  <select
                    value={line.productId}
                    onChange={(e) => pickProduct(i, e.target.value)}
                    className="h-9 w-full rounded-lg bg-white px-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                  >
                    <option value="">Free text…</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.sku})
                      </option>
                    ))}
                  </select>
                  {!line.productId && (
                    <input
                      value={line.name}
                      onChange={(e) => updateLine(i, { name: e.target.value })}
                      placeholder="Description"
                      className="mt-1 h-9 w-full rounded-lg bg-white px-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                    />
                  )}
                </div>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={line.quantity}
                  onChange={(e) => updateLine(i, { quantity: e.target.value })}
                  aria-label="Quantity"
                  className="h-9 w-20 rounded-lg bg-white px-2 text-right text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={line.price}
                  onChange={(e) => updateLine(i, { price: e.target.value })}
                  aria-label="Unit price"
                  className="h-9 w-24 rounded-lg bg-white px-2 text-right text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                />
                <span className="tnum w-20 text-right text-sm font-medium text-slate-800">
                  {money(priced[i].lineTotal)}
                </span>
                <button
                  type="button"
                  onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                  disabled={lines.length === 1}
                  aria-label="Remove line"
                  className="rounded p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => setLines((prev) => [...prev, { productId: '', name: '', quantity: 1, price: '' }])}
          >
            <Plus size={13} /> Add line
          </Button>
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
                Put on account (leave unticked if paid immediately)
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
  );
}

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
      const res = await api.post(`/documents/${id}/${path}`, body);
      toast(successMessage);
      if (path === 'convert') {
        onChanged();
        onClose();
        return res;
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
  const canConvert = doc.doc_type === 'quotation' || doc.doc_type === 'sales_order';

  return (
    <Modal
      open
      onClose={onClose}
      title={`${TYPE_LABELS[doc.doc_type]} ${doc.doc_number}`}
      subtitle={`${doc.party_name || '—'} · ${doc.issue_date}`}
      size="lg"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
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

export default function Documents() {
  const [documents, setDocuments] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState(null);

  const load = useCallback(() => {
    const params = filter === 'all' ? {} : { type: filter };
    api.get('/documents', { params }).then((res) => setDocuments(res.data.documents));
  }, [filter]);

  useEffect(() => {
    setDocuments(null);
    load();
  }, [load]);

  const term = search.trim().toLowerCase();
  const visible = (documents || []).filter(
    (d) =>
      !term ||
      d.doc_number.toLowerCase().includes(term) ||
      (d.party_name || '').toLowerCase().includes(term),
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
        <Card>
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3">
            <div className="relative flex-1">
              <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by number or name…"
                className="h-9 w-full rounded-lg bg-slate-100 pr-3 pl-9 text-sm ring-1 ring-transparent transition focus:bg-white focus:ring-brand-600 focus:outline-none"
              />
            </div>
            <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm font-medium">
              {[['all', 'All'], ...Object.entries(TYPE_LABELS)].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={cx(
                    'rounded-md px-2.5 py-1 whitespace-nowrap transition',
                    filter === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500',
                  )}
                >
                  {label}
                </button>
              ))}
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
                    <td className="px-3 py-2.5 text-slate-500">{TYPE_LABELS[d.doc_type]}</td>
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

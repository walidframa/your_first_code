import { useCallback, useEffect, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, History, Search, SlidersHorizontal } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import {
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  ModalActions,
  ProductThumb,
  Select,
  Skeleton,
  StockBadge,
  cx,
  money,
  useToast,
} from '../../components/ui';

const REASON_LABELS = {
  received: 'Stock received',
  damaged: 'Damaged',
  theft: 'Theft / shrinkage',
  count_correction: 'Count correction',
  return: 'Customer return',
  transfer: 'Transfer',
  other: 'Other',
};

function AdjustModal({ product, reasons, onClose, onSaved }) {
  const toast = useToast();
  const [mode, setMode] = useState('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('received');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const parsed = Number(amount);
  const delta = mode === 'add' ? parsed : mode === 'remove' ? -parsed : parsed - product.stock;
  const resulting = mode === 'set' ? parsed : product.stock + delta;
  const valid = Number.isFinite(parsed) && amount !== '' && delta !== 0 && resulting >= 0;

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.post('/inventory/adjust', {
        productId: product.id,
        delta: Math.trunc(delta),
        reason,
        note: note.trim() || null,
      });
      toast(`${product.name} updated to ${resulting} in stock`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Adjustment failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Adjust stock" subtitle={`${product.name} · ${product.sku}`}>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex items-center gap-3 rounded-xl bg-slate-50 px-4 py-3">
          <ProductThumb product={product} />
          <div>
            <p className="text-sm font-medium text-slate-800">{product.name}</p>
            <p className="tnum text-xs text-slate-500">Currently {product.stock} in stock</p>
          </div>
        </div>

        <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm font-medium">
          {[
            { key: 'add', label: 'Add' },
            { key: 'remove', label: 'Remove' },
            { key: 'set', label: 'Set to' },
          ].map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMode(m.key)}
              className={cx(
                'flex-1 rounded-md px-3 py-1.5 transition',
                mode === m.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>

        <Input
          type="number"
          min="0"
          step="1"
          label={mode === 'set' ? 'New stock level' : 'Quantity'}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
          required
        />

        <Select label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          {reasons.map((r) => (
            <option key={r} value={r}>
              {REASON_LABELS[r] || r}
            </option>
          ))}
        </Select>

        <Input
          label="Note (optional)"
          placeholder="e.g. PO #1042"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        {amount !== '' && Number.isFinite(parsed) && (
          <p className={cx('text-sm', resulting < 0 ? 'text-red-600' : 'text-slate-600')}>
            {resulting < 0
              ? 'That would take stock below zero.'
              : `New stock level: ${product.stock} → ${resulting}`}
          </p>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={!valid} loading={saving}>
            Save adjustment
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function HistoryModal({ product, onClose }) {
  const [movements, setMovements] = useState(null);

  useEffect(() => {
    api
      .get('/inventory/movements', { params: { productId: product.id, limit: 100 } })
      .then((res) => setMovements(res.data.movements));
  }, [product.id]);

  return (
    <Modal open onClose={onClose} title="Stock history" subtitle={`${product.name} · ${product.sku}`}>
      {!movements ? (
        <Skeleton className="h-32" />
      ) : movements.length === 0 ? (
        <EmptyState icon={History} title="No movements yet" description="Adjustments and imports appear here." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {movements.map((m) => (
            <li key={m.id} className="flex items-start gap-3 py-2.5">
              <div
                className={cx(
                  'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
                  m.delta > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600',
                )}
              >
                {m.delta > 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800">
                  {REASON_LABELS[m.reason] || m.reason}
                  <span className="tnum ml-2 font-normal text-slate-500">
                    {m.delta > 0 ? '+' : ''}
                    {m.delta} → {m.resulting_stock}
                  </span>
                </p>
                <p className="text-xs text-slate-400">
                  {m.created_at} · {m.user_name || 'System'}
                  {m.note ? ` · ${m.note}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export default function Inventory() {
  const [data, setData] = useState(null);
  const [reasons, setReasons] = useState([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [adjusting, setAdjusting] = useState(null);
  const [viewingHistory, setViewingHistory] = useState(null);

  const load = useCallback(async () => {
    const [invRes, reasonsRes] = await Promise.all([
      api.get('/inventory'),
      api.get('/inventory/reasons'),
    ]);
    setData(invRes.data);
    setReasons(reasonsRes.data.reasons);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const products = (data?.products || []).filter((p) => {
    const term = search.trim().toLowerCase();
    const matchesSearch =
      !term ||
      p.name.toLowerCase().includes(term) ||
      p.sku.toLowerCase().includes(term) ||
      (p.supplier || '').toLowerCase().includes(term);
    const matchesFilter =
      filter === 'all' ||
      (filter === 'low' && p.stock > 0 && p.stock <= p.reorder_point) ||
      (filter === 'out' && p.stock <= 0);
    return matchesSearch && matchesFilter;
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Inventory" subtitle="Stock levels, adjustments and movement history" />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {!data ? (
          <Skeleton className="h-64" />
        ) : (
          <>
            <div className="mb-4 grid grid-cols-4 gap-4">
              <Card className="px-4 py-3.5">
                <p className="text-xs text-slate-500">SKUs tracked</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">{data.totals.skuCount}</p>
              </Card>
              <Card className="px-4 py-3.5">
                <p className="text-xs text-slate-500">Units on hand</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {data.totals.units.toLocaleString()}
                </p>
              </Card>
              <Card className="px-4 py-3.5">
                <p className="text-xs text-slate-500">Retail value</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">{money(data.totals.retailValue)}</p>
                <p className="mt-0.5 text-xs text-slate-400">{money(data.totals.costValue)} at cost</p>
              </Card>
              <Card className="px-4 py-3.5">
                <p className="text-xs text-slate-500">Needs attention</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {data.totals.lowStock + data.totals.outOfStock}
                </p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {data.totals.outOfStock} out · {data.totals.lowStock} low
                </p>
              </Card>
            </div>

            <Card>
              <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-3">
                <div className="relative flex-1">
                  <Search
                    size={16}
                    className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by name, SKU or supplier…"
                    className="h-9 w-full rounded-lg bg-slate-100 pr-3 pl-9 text-sm ring-1 ring-transparent transition focus:bg-white focus:ring-brand-600 focus:outline-none"
                  />
                </div>
                <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm font-medium">
                  {[
                    { key: 'all', label: 'All' },
                    { key: 'low', label: 'Low' },
                    { key: 'out', label: 'Out' },
                  ].map((f) => (
                    <button
                      key={f.key}
                      onClick={() => setFilter(f.key)}
                      className={cx(
                        'rounded-md px-3 py-1 transition',
                        filter === f.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500',
                      )}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {products.length === 0 ? (
                <EmptyState icon={Search} title="No products match" description="Try a different search or filter." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                      <tr>
                        <th className="px-5 py-2.5 font-medium">Product</th>
                        <th className="px-3 py-2.5 font-medium">Supplier</th>
                        <th className="px-3 py-2.5 text-right font-medium">Reorder at</th>
                        <th className="px-3 py-2.5 text-right font-medium">Value</th>
                        <th className="px-3 py-2.5 font-medium">Status</th>
                        <th className="px-5 py-2.5 text-right font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {products.map((p) => (
                        <tr key={p.id} className="hover:bg-slate-50/60">
                          <td className="px-5 py-2.5">
                            <div className="flex items-center gap-3">
                              <ProductThumb product={p} size="sm" />
                              <div className="min-w-0">
                                <p className="truncate font-medium text-slate-800">{p.name}</p>
                                <p className="text-xs text-slate-400">{p.sku}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-slate-500">{p.supplier || '—'}</td>
                          <td className="tnum px-3 py-2.5 text-right text-slate-500">{p.reorder_point}</td>
                          <td className="tnum px-3 py-2.5 text-right text-slate-700">
                            {money(p.stock * p.price)}
                          </td>
                          <td className="px-3 py-2.5">
                            <StockBadge stock={p.stock} reorderPoint={p.reorder_point} />
                          </td>
                          <td className="px-5 py-2.5">
                            <div className="flex justify-end gap-1">
                              <Button size="sm" variant="secondary" onClick={() => setAdjusting(p)}>
                                <SlidersHorizontal size={13} /> Adjust
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setViewingHistory(p)}
                                aria-label={`History for ${p.name}`}
                              >
                                <History size={14} />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </div>

      {adjusting && (
        <AdjustModal
          product={adjusting}
          reasons={reasons}
          onClose={() => setAdjusting(null)}
          onSaved={() => {
            setAdjusting(null);
            load();
          }}
        />
      )}
      {viewingHistory && <HistoryModal product={viewingHistory} onClose={() => setViewingHistory(null)} />}
    </div>
  );
}

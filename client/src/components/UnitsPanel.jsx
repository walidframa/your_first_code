import { useCallback, useEffect, useState } from 'react';
import { Plus, Smartphone, Trash2 } from 'lucide-react';
import api from '../api';
import {
  Button,
  EmptyState,
  Modal,
  ModalActions,
  Select,
  Skeleton,
  cx,
  money,
  useToast,
} from './ui';

const CONDITIONS = [
  ['new', 'New'],
  ['used', 'Used'],
  ['refurbished', 'Refurbished'],
];

const STATUS_STYLE = {
  in_stock: 'bg-brand-50 text-brand-700',
  returned: 'bg-amber-50 text-amber-700',
  sold: 'bg-slate-100 text-slate-500',
  scrapped: 'bg-red-50 text-red-600',
};

const STATUS_LABEL = {
  in_stock: 'In stock',
  returned: 'Returned',
  sold: 'Sold',
  scrapped: 'Scrapped',
};

/**
 * Book handsets in.
 *
 * IMEIs arrive as a scanned or typed list, one per line, because that is how a
 * delivery is actually counted in — box after box, not a form field at a time.
 */
function ReceiveModal({ product, onClose, onSaved }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [condition, setCondition] = useState('new');
  const [cost, setCost] = useState(product.cost ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  /*
   * One handset per line. A dual-SIM phone has both numbers printed together,
   * so they go on the same line separated by a comma or slash — the separator
   * cannot be a space, because spaces appear inside a single IMEI as printed.
   */
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.post(`/units/product/${product.id}`, {
        // The server splits each line, so a dual-SIM handset arrives whole.
        units: lines.map((line) => ({ imei: line, condition, cost: Number(cost) || 0 })),
      });
      toast(`${res.data.added} booked in — ${res.data.stock} on the shelf`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not book these in');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={saving ? undefined : onClose} title={`Book in ${product.name}`} size="md">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="imeis" className="mb-1 block text-sm font-medium text-slate-700">
            IMEI or serial numbers
          </label>
          <textarea
            id="imeis"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            autoFocus
            placeholder={'351234567890123, 351234567890124\n358888777766661'}
            className="w-full rounded-xl px-3 py-2 font-mono text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-500">
            One handset per line. For a dual-SIM phone put both numbers on the line, separated by a
            comma. Spaces and dashes are ignored, so you can type them off the box.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="cond" className="mb-1 block text-sm font-medium text-slate-700">
              Condition
            </label>
            <Select id="cond" value={condition} onChange={(e) => setCondition(e.target.value)}>
              {CONDITIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="cost" className="mb-1 block text-sm font-medium text-slate-700">
              Cost each
            </label>
            <input
              id="cost"
              type="number"
              step="0.01"
              min="0"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              className="w-full rounded-xl px-3 py-2 ring-1 ring-edge focus:ring-2 focus:ring-brand-500 focus:outline-none"
            />
          </div>
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving} disabled={lines.length === 0}>
            {lines.length ? `Book in ${lines.length}` : 'Nothing to book in'}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/** Every handset of one product, and what became of it. */
export default function UnitsPanel({ product, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [receiving, setReceiving] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get(`/units/product/${product.id}`);
    setData(res.data);
  }, [product.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(unit) {
    try {
      await api.delete(`/units/${unit.id}`);
      toast(`${unit.imei} removed`);
      await load();
      onChanged?.();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not remove it', 'error');
    }
  }

  if (!data) return <Skeleton className="h-40" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-900">{data.available}</span> on the shelf ·{' '}
          {data.units.length} ever booked in
        </p>
        <Button size="sm" onClick={() => setReceiving(true)}>
          <Plus size={15} /> Book in
        </Button>
      </div>

      {data.units.length === 0 ? (
        <EmptyState
          icon={Smartphone}
          title="No handsets booked in yet"
          description="Add the IMEIs from the delivery and they become the stock for this product."
        />
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-xl ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">IMEI / serial</th>
                <th className="px-3 py-2 font-medium">Condition</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Where it went</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.units.map((u) => (
                <tr key={u.id}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-800">
                    {u.imei}
                    {u.imei2 && <span className="block text-slate-400">{u.imei2}</span>}
                  </td>
                  <td className="px-3 py-2 capitalize text-slate-600">{u.condition}</td>
                  <td className="tnum px-3 py-2 text-right text-slate-700">{money(u.cost)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={cx(
                        'rounded-full px-2 py-0.5 text-xs font-medium',
                        STATUS_STYLE[u.status],
                      )}
                    >
                      {STATUS_LABEL[u.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {u.order_number ? (
                      <>
                        {u.order_number}
                        {u.customer_name ? ` · ${u.customer_name}` : ''}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {/* Sold handsets are part of a sale's history; the API refuses
                        to delete them, so the button is not offered. */}
                    {u.status !== 'sold' && (
                      <button
                        onClick={() => remove(u)}
                        aria-label={`Remove ${u.imei}`}
                        className="rounded-lg p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {receiving && (
        <ReceiveModal
          product={product}
          onClose={() => setReceiving(false)}
          onSaved={async () => {
            setReceiving(false);
            await load();
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

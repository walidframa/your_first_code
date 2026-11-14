import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Smartphone, Tags, Trash2 } from 'lucide-react';
import api from '../api';
import { useLive } from '../lib/live';
import { unitKindOf } from '../lib/imei';
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
  sent_back: 'bg-violet-50 text-violet-700',
};

const STATUS_LABEL = {
  in_stock: 'In stock',
  returned: 'Returned',
  sold: 'Sold',
  scrapped: 'Scrapped',
  sent_back: 'Sent back to supplier',
};

/**
 * Book handsets in.
 *
 * IMEIs arrive as a scanned or typed list, one per line, because that is how a
 * delivery is actually counted in — box after box, not a form field at a time.
 */
function ReceiveModal({ product, onClose, onSaved }) {
  const toast = useToast();
  const serial = unitKindOf(product) === 'serial';
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
            {serial ? 'Serial numbers' : 'IMEI numbers'}
          </label>
          <textarea
            id="imeis"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            autoFocus
            placeholder={serial ? 'SN-24A0001\nSN-24A0002' : '351234567890123, 351234567890124\n358888777766661'}
            className="w-full rounded-xl px-3 py-2 font-mono text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-500">
            {serial
              ? 'One per line, as printed on the label. Spaces and dashes are ignored; letters are kept.'
              : 'One handset per line. For a dual-SIM phone put both numbers on the line, separated by a comma. Spaces and dashes are ignored, so you can type them off the box.'}
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
  const serialKind = unitKindOf(product) === 'serial';
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
  useLive(load);

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

  /*
   * Correcting what one handset cost, sold or not.
   *
   * A phone booked in at the wrong figure sells at the wrong figure, and the
   * profit report says so for ever. Each unit carries its own cost, so the
   * correction is per handset — and on one already sold the sale it left on
   * is recosted too, which is the whole reason to come back and fix it.
   */
  const [editing, setEditing] = useState(null);
  const [costText, setCostText] = useState('');
  function startEdit(unit) {
    setEditing(unit.id);
    setCostText(String(unit.cost ?? ''));
  }
  async function saveCost(unit) {
    const cost = Number(costText);
    if (!Number.isFinite(cost) || cost < 0) return toast('A cost is a number, zero or more', 'error');
    try {
      const res = await api.patch(`/units/${unit.id}`, { cost });
      const lines = res.data.lines_recosted || 0;
      toast(lines ? `${unit.imei} now cost ${money(cost)} — its sale follows` : `${unit.imei} now cost ${money(cost)}`);
      setEditing(null);
      await load();
      onChanged?.();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not change the cost', 'error');
    }
  }

  /*
   * The whole model to the product's cost, in one go.
   *
   * The product form already carries a changed cost onto the shelf — but only
   * when it changes, and only onto handsets that carried the old figure. A
   * model booked in wrong, corrected on the product a while ago and sold at
   * the wrong cost since needs the lot put right, sold ones included, and
   * going down the list one handset at a time is how one gets missed.
   */
  const [recosting, setRecosting] = useState(false);
  const [withSold, setWithSold] = useState(false);
  const [recostBusy, setRecostBusy] = useState(false);
  const target = Number(data?.product?.cost ?? product.cost) || 0;
  const offShelf = (data?.units || []).filter(
    (u) => (u.status === 'in_stock' || u.status === 'returned') && Number(u.cost) !== target,
  ).length;
  const offSold = (data?.units || []).filter((u) => u.status === 'sold' && Number(u.cost) !== target).length;
  async function recostAll() {
    setRecostBusy(true);
    try {
      const res = await api.post(`/units/product/${product.id}/recost`, { cost: target, includeSold: withSold });
      const { shelf, sold } = res.data;
      toast(
        `${shelf} on the shelf now cost ${money(target)}${
          sold ? ` · ${sold} sold ones too, and their sales follow` : ''
        }`,
      );
      setRecosting(false);
      await load();
      onChanged?.();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not change the costs', 'error');
    } finally {
      setRecostBusy(false);
    }
  }

  if (!data) return <Skeleton className="h-40" />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-900">{data.available}</span> on the shelf ·{' '}
          {data.units.length} ever booked in
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {offShelf + offSold > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setWithSold(false);
                setRecosting(true);
              }}
              title={`Set every handset of this model to the product's cost, ${money(target)}`}
            >
              <Tags size={15} /> All to {money(target)}
            </Button>
          )}
          <Button size="sm" onClick={() => setReceiving(true)}>
            <Plus size={15} /> Book in
          </Button>
        </div>
      </div>

      {recosting && (
        <Modal
          open
          onClose={recostBusy ? undefined : () => setRecosting(false)}
          title={`Every ${product.name} to ${money(target)}`}
          size="sm"
        >
          <p className="text-sm text-slate-600">
            The product's cost is <span className="font-semibold text-slate-900">{money(target)}</span>.{' '}
            {offShelf > 0
              ? `${offShelf} handset${offShelf === 1 ? '' : 's'} on the shelf carr${offShelf === 1 ? 'ies' : 'y'} another figure and will take it.`
              : 'Every handset on the shelf already carries it.'}
          </p>
          {offSold > 0 && (
            <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={withSold}
                onChange={(e) => setWithSold(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600"
              />
              <span>
                Also the {offSold} sold one{offSold === 1 ? '' : 's'}. The sale{offSold === 1 ? '' : 's'} they
                left on {offSold === 1 ? 'is' : 'are'} recosted, so the profit on them changes.
              </span>
            </label>
          )}
          <ModalActions>
            <Button variant="secondary" onClick={() => setRecosting(false)} disabled={recostBusy}>
              Cancel
            </Button>
            <Button onClick={recostAll} loading={recostBusy} disabled={offShelf === 0 && !withSold}>
              Set the cost
            </Button>
          </ModalActions>
        </Modal>
      )}

      {data.units.length === 0 ? (
        <EmptyState
          icon={Smartphone}
          title={serialKind ? 'Nothing booked in yet' : 'No handsets booked in yet'}
          description={`Add the ${serialKind ? 'serial numbers' : 'IMEIs'} from the delivery and they become the stock for this product.`}
        />
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-xl ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">{serialKind ? 'Serial number' : 'IMEI'}</th>
                <th className="px-3 py-2 font-medium">Condition</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Where it went</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {data.units.map((u) => (
                <tr key={u.id}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-800">
                    {u.imei}
                    {u.imei2 && <span className="block text-slate-400">{u.imei2}</span>}
                  </td>
                  <td className="px-3 py-2 capitalize text-slate-600">{u.condition}</td>
                  <td className="tnum px-3 py-2 text-right text-slate-700">
                    {editing === u.id ? (
                      <input
                        autoFocus
                        type="number"
                        min="0"
                        step="0.01"
                        value={costText}
                        aria-label={`Cost of ${u.imei}`}
                        onChange={(e) => setCostText(e.target.value)}
                        onBlur={() => saveCost(u)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                          if (e.key === 'Escape') setEditing(null);
                        }}
                        className="h-7 w-24 rounded-lg bg-white px-2 text-right text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => startEdit(u)}
                        title={u.status === 'sold' ? 'Correct what it cost — the sale it left on follows' : 'Correct what it cost'}
                        aria-label={`Change the cost of ${u.imei}`}
                        className="inline-flex items-center gap-1 rounded-md px-1 hover:bg-slate-100"
                      >
                        {money(u.cost)}
                        <Pencil size={11} className="text-slate-400" />
                      </button>
                    )}
                  </td>
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

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, History, Tag, TrendingDown, TrendingUp } from 'lucide-react';
import api from '../api';
import { Badge, Modal, Skeleton, cx, money } from './ui';

/** What each kind of thing that can happen to a product looks like. */
const KINDS = {
  sale: { label: 'Sold', tone: 'text-emerald-600', icon: ArrowDown },
  refund: { label: 'Refunded', tone: 'text-amber-600', icon: ArrowUp },
  purchase: { label: 'Received', tone: 'text-blue-600', icon: ArrowUp },
  invoice: { label: 'Invoiced', tone: 'text-emerald-600', icon: ArrowDown },
  adjustment: { label: 'Adjusted', tone: 'text-slate-500', icon: History },
  cost: { label: 'Cost', tone: 'text-violet-600', icon: Tag },
};

/**
 * One product's life: what was bought, what was sold, what was corrected, and
 * every time its cost moved.
 *
 * Kept in one list rather than tabs — the useful question is usually "what
 * happened around the time the margin changed", and that only answers itself
 * when purchases, sales and cost changes sit in the same column.
 */
export default function ItemActivity({ productId, onClose }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get(`/products/${productId}/activity`).then((res) => setData(res.data));
  }, [productId]);

  if (!data) {
    return (
      <Modal open onClose={onClose} title="Loading…">
        <Skeleton className="h-56" />
      </Modal>
    );
  }

  const { product, activity, costHistory } = data;
  /*
   * How far the cost has travelled: from what it was before the earliest
   * recorded change, to what it is now. A single change is still a change —
   * requiring two entries would report the first price rise as "never".
   */
  const latestCost = costHistory[0];
  const earliest = costHistory[costHistory.length - 1];
  const startedAt = earliest?.previous_cost ?? null;
  const costMoved = !!latestCost && startedAt !== null;
  const costDirection = costMoved ? latestCost.cost - startedAt : 0;

  const margin = product.price > 0 ? ((product.price - product.cost) / product.price) * 100 : 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={product.name}
      subtitle={`${product.sku} · ${product.stock} in stock`}
      size="lg"
    >
      <div className="mb-4 grid grid-cols-4 gap-3">
        {[
          ['Sells for', money(product.price), null],
          ['Costs', money(product.cost), null],
          ['Margin', `${Math.round(margin)}%`, margin < 0 ? 'text-red-600' : null],
          [
            'Cost moved',
            costMoved ? `${costDirection > 0 ? '+' : ''}${money(costDirection)}` : 'never',
            costDirection > 0 ? 'text-red-600' : costDirection < 0 ? 'text-brand-700' : null,
          ],
        ].map(([label, value, tone]) => (
          <div key={label} className="rounded-xl bg-slate-50 px-3 py-2">
            <p className="text-xs text-slate-500">{label}</p>
            <p className={cx('tnum mt-0.5 font-semibold text-slate-900', tone)}>{value}</p>
          </div>
        ))}
      </div>

      {costHistory.length > 0 && (
        <>
          <p className="mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">
            What it has cost
          </p>
          <div className="mb-4 max-h-32 overflow-y-auto rounded-xl ring-1 ring-slate-100">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-50">
                {costHistory.map((c) => {
                  const up = c.previous_cost !== null && c.cost > c.previous_cost;
                  const Icon = up ? TrendingUp : TrendingDown;
                  return (
                    <tr key={c.id}>
                      <td className="px-3 py-1.5 text-xs text-slate-400">
                        {new Date(`${c.created_at}Z`).toLocaleDateString()}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="flex items-center gap-1.5 text-slate-700">
                          {c.previous_cost !== null && (
                            <Icon size={13} className={up ? 'text-red-500' : 'text-brand-600'} />
                          )}
                          <span className="tnum font-medium">{money(c.cost)}</span>
                          {c.previous_cost !== null && (
                            <span className="tnum text-xs text-slate-400">from {money(c.previous_cost)}</span>
                          )}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-xs text-slate-400 capitalize">{c.source}</td>
                      <td className="px-3 py-1.5 text-right text-xs text-slate-400">
                        {c.doc_number || c.user_name || ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">Everything it did</p>
      {activity.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          Nothing has happened to this product yet.
        </p>
      ) : (
        <div className="max-h-80 overflow-y-auto rounded-xl ring-1 ring-slate-100">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-50">
              {activity.map((a, i) => {
                const meta = KINDS[a.kind] || KINDS.adjustment;
                const Icon = meta.icon;
                return (
                  <tr key={`${a.kind}-${a.at}-${i}`}>
                    <td className="w-24 px-3 py-1.5 text-xs whitespace-nowrap text-slate-400">
                      {new Date(`${a.at}Z`).toLocaleDateString()}
                    </td>
                    <td className="w-24 px-2 py-1.5">
                      <span className={cx('flex items-center gap-1.5 text-xs font-medium', meta.tone)}>
                        <Icon size={13} />
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-slate-600">
                      {a.detail}
                      {a.who && <span className="ml-1 text-xs text-slate-400">{a.who}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-slate-400">{a.reference || ''}</td>
                    <td className="tnum w-20 px-3 py-1.5 text-right">
                      {a.kind === 'cost' ? (
                        <span className="text-violet-700">{money(a.cost)}</span>
                      ) : (
                        <span className={a.quantity < 0 ? 'text-red-600' : 'text-slate-700'}>
                          {a.quantity > 0 ? '+' : ''}
                          {a.quantity}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-slate-400">
        <Badge tone="neutral">note</Badge> Stock movements a sale or document already explains are shown
        once, under that sale or document.
      </p>
    </Modal>
  );
}

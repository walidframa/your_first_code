import { useEffect, useMemo, useState } from 'react';
import { Search, Smartphone } from 'lucide-react';
import api from '../api';
import { EmptyState, Modal, Skeleton, cx, money } from './ui';

const CONDITION_STYLE = {
  new: 'bg-brand-50 text-brand-700',
  used: 'bg-amber-50 text-amber-700',
  refurbished: 'bg-sky-50 text-sky-700',
};

/**
 * Which handset is leaving the shop.
 *
 * A serialised product cannot just be tapped into the cart — "an iPhone 13" is
 * not a thing anyone can hand over. The cashier picks the actual device, and
 * from that moment the sale is about that IMEI: its cost, its warranty, its
 * customer.
 */
export default function UnitPicker({ product, onPick, onClose }) {
  const [units, setUnits] = useState(null);
  const [term, setTerm] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get(`/units/product/${product.id}`).then((res) => {
      if (!cancelled) setUnits(res.data.units.filter((u) => u.status !== 'sold' && u.status !== 'scrapped'));
    });
    return () => {
      cancelled = true;
    };
  }, [product.id]);

  const shown = useMemo(() => {
    if (!units) return [];
    const t = term.replace(/[\s-]/g, '').toUpperCase();
    return t ? units.filter((u) => u.imei.includes(t)) : units;
  }, [units, term]);

  return (
    <Modal open onClose={onClose} title={product.name} subtitle="Which handset?" size="md">
      {units === null ? (
        <Skeleton className="h-40" />
      ) : units.length === 0 ? (
        <EmptyState
          icon={Smartphone}
          title="None on the shelf"
          description="Book the IMEIs in from Products before selling this."
        />
      ) : (
        <div className="space-y-3">
          {/* Typing the last few digits is how a cashier finds one in a drawer
              of twenty identical boxes. */}
          <div className="relative">
            <Search size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              autoFocus
              placeholder="Scan or type part of the IMEI"
              aria-label="Find a handset by IMEI"
              className="w-full rounded-xl py-2 pr-3 pl-9 font-mono text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-500 focus:outline-none"
            />
          </div>

          <ul className="max-h-80 space-y-1.5 overflow-y-auto">
            {shown.map((u) => (
              <li key={u.id}>
                <button
                  onClick={() => onPick(u)}
                  className="flex w-full items-center gap-3 rounded-xl bg-white px-3 py-2.5 text-left ring-1 ring-slate-200 transition hover:bg-slate-50 hover:ring-brand-400"
                >
                  <span className="flex-1 font-mono text-sm text-slate-800">{u.imei}</span>
                  <span
                    className={cx(
                      'rounded-full px-2 py-0.5 text-xs font-medium capitalize',
                      CONDITION_STYLE[u.condition],
                    )}
                  >
                    {u.condition}
                  </span>
                  {u.status === 'returned' && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                      returned
                    </span>
                  )}
                  <span className="tnum w-16 text-right text-sm text-slate-500">{money(product.price)}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-slate-400">
                No handset here matches {term}
              </li>
            )}
          </ul>
        </div>
      )}
    </Modal>
  );
}

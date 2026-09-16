import { useEffect, useMemo, useState } from 'react';
import { Search, Smartphone } from 'lucide-react';
import api from '../api';
import { Skeleton, cx } from './ui';

const CONDITION_STYLE = {
  new: 'bg-brand-50 text-brand-700',
  used: 'bg-amber-50 text-amber-700',
  refurbished: 'bg-sky-50 text-sky-700',
};

/**
 * Which handsets are going back to the supplier.
 *
 * On a delivery the IMEIs are typed off the boxes, because the phones are new
 * to the shop. On a return they are not: every one of them is already on the
 * shelf, so the line offers the shelf and the shop ticks. The line's quantity
 * follows the ticks rather than being typed separately — a count and a list
 * that could disagree would be refused at confirm time anyway.
 *
 * A return raised against a delivery arrives with that delivery's IMEIs on the
 * line; the ones still on the shelf come pre-ticked, and the ones since sold
 * are simply not offered.
 */
export default function ReturnHandsets({ product, value, quantity, onChange }) {
  const [units, setUnits] = useState(null);
  const [term, setTerm] = useState('');

  useEffect(() => {
    let live = true;
    api.get(`/units/product/${product.id}`, { params: { branch: 'here' } }).then((res) => {
      if (!live) return;
      setUnits(res.data.units.filter((u) => u.status === 'in_stock' || u.status === 'returned'));
    });
    return () => {
      live = false;
    };
  }, [product.id]);

  /* What the line names, as a set of numbers: either slot of a dual-SIM counts. */
  const named = useMemo(
    () => new Set(String(value || '').split(/[\s,;/|]+/).map((s) => s.replace(/\D/g, '')).filter(Boolean)),
    [value],
  );
  const ticked = useMemo(
    () => (units || []).filter((u) => named.has(u.imei) || (u.imei2 && named.has(u.imei2))),
    [units, named],
  );

  /*
   * Reconcile once the shelf is known: a line converted from a delivery may
   * name two phones of which one has since been sold. The count and the list
   * then follow what can actually go back.
   */
  useEffect(() => {
    if (units === null) return;
    const shelfImeis = ticked.map((u) => u.imei).join('\n');
    if (shelfImeis !== String(value || '') || Number(quantity) !== ticked.length) {
      onChange({ imeis: shelfImeis || null, quantity: ticked.length });
    }
    // Only when the shelf arrives or the named set changes — not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units]);

  const toggle = (u) => {
    const next = ticked.some((t) => t.id === u.id) ? ticked.filter((t) => t.id !== u.id) : [...ticked, u];
    onChange({ imeis: next.map((t) => t.imei).join('\n') || null, quantity: next.length });
  };

  const shown = useMemo(() => {
    if (!units) return [];
    const t = term.replace(/[\s-]/g, '').toUpperCase();
    return t ? units.filter((u) => u.imei.includes(t) || (u.imei2 || '').includes(t)) : units;
  }, [units, term]);

  if (units === null) return <Skeleton className="mt-2 h-16" />;

  if (units.length === 0) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-700">
        <Smartphone size={13} /> None of these are on the shelf here — there is nothing to send back.
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-1.5" data-return-handsets>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          {ticked.length === 0
            ? `Tick the handset${units.length === 1 ? '' : 's'} going back`
            : `${ticked.length} of ${units.length} on the shelf going back`}
        </p>
        {units.length > 6 && (
          <div className="relative">
            <Search size={13} className="absolute top-1/2 left-2 -translate-y-1/2 text-slate-400" />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Find by IMEI"
              aria-label="Find a handset by IMEI"
              className="h-7 w-40 rounded-lg py-1 pr-2 pl-7 font-mono text-xs ring-1 ring-edge focus:ring-2 focus:ring-brand-500 focus:outline-none"
            />
          </div>
        )}
      </div>
      <ul className="max-h-48 space-y-1 overflow-y-auto">
        {shown.map((u) => {
          const on = ticked.some((t) => t.id === u.id);
          return (
            <li key={u.id}>
              <label
                className={cx(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm ring-1 transition',
                  on ? 'bg-brand-50 ring-brand-300' : 'bg-white ring-slate-200 hover:bg-slate-50',
                )}
              >
                <input type="checkbox" checked={on} onChange={() => toggle(u)} className="accent-brand-600" />
                <span className="flex-1 font-mono text-slate-800">
                  {u.imei}
                  {u.imei2 && <span className="block text-xs text-slate-400">{u.imei2}</span>}
                </span>
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
              </label>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="px-2 py-3 text-center text-xs text-slate-400">No handset here matches {term}</li>
        )}
      </ul>
    </div>
  );
}

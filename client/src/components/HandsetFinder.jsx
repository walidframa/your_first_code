import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Smartphone, Search } from 'lucide-react';
import api from '../api';
import { Badge, Button, Modal, ModalActions, money } from './ui';

/**
 * Where is this handset?
 *
 * A customer walks in with a phone: did they buy it here, is it under
 * warranty, is there one like it in the other shop. The answer used to be
 * spread over five screens, each searching its own list. This is one box:
 * type or scan the IMEI, and it says what the phone is, which shelf it is
 * on, the sale it left on and who took it, the delivery it came in on, the
 * repairs it has been through — with a way to each.
 */

/** Something that could be an IMEI or a serial: eight or more digits in it. */
export const looksLikeImei = (text) => (String(text || '').replace(/\D/g, '').length >= 8);

const STATUS = {
  in_stock: { label: 'On the shelf', tone: 'good' },
  returned: { label: 'Returned, back on the shelf', tone: 'good' },
  sold: { label: 'Sold', tone: 'neutral' },
  scrapped: { label: 'Scrapped', tone: 'critical' },
  sent_back: { label: 'Sent back to the supplier', tone: 'warning' },
};

const day = (at) => String(at || '').slice(0, 10);

/** One line saying where it is, for a toast at the register. */
export function whereIs(found) {
  if (!found?.unit) {
    const t = found?.repairs?.[0];
    return t ? `Not one of ours — seen on repair ticket ${t.ticket_number}` : 'Nothing in the shop’s records';
  }
  const { unit, sale, tradeIn } = found;
  const name = unit.product_name;
  if (unit.status === 'sold' && sale) {
    const who = sale.customer_name ? ` to ${sale.customer_name}` : '';
    return `${name} was sold on ${sale.number}${who} (${day(sale.at)})`;
  }
  if (unit.status === 'in_stock' || unit.status === 'returned') {
    const where = unit.branch_name ? ` at ${unit.branch_name}` : '';
    const came = tradeIn ? ', bought in from ' + (tradeIn.seller_name || 'a customer') : '';
    return `${name} is on the shelf${where}${came}`;
  }
  return `${name}: ${STATUS[unit.status]?.label || unit.status}`;
}

export default function HandsetFinder({ open, onClose, initialImei = '' }) {
  const navigate = useNavigate();
  const [imei, setImei] = useState(initialImei);
  const [found, setFound] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (!open) return;
    setImei(initialImei || '');
    setFound(null);
    setError('');
    if (looksLikeImei(initialImei)) look(initialImei);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialImei]);

  async function look(value = imei) {
    const term = String(value || '').trim();
    if (!term) return;
    setBusy(true);
    setError('');
    setFound(null);
    try {
      const res = await api.get('/units/find', { params: { imei: term } });
      setFound(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not look that up');
    } finally {
      setBusy(false);
    }
  }

  function go(path) {
    onClose();
    navigate(path);
  }

  if (!open) return null;
  const unit = found?.unit;
  const status = unit ? STATUS[unit.status] || { label: unit.status, tone: 'neutral' } : null;

  return (
    <Modal open onClose={onClose} title="Find a handset" subtitle="Type or scan the IMEI or serial number">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          look();
        }}
        className="flex gap-2"
      >
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
          <input
            ref={box}
            autoFocus
            value={imei}
            onChange={(e) => setImei(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            placeholder="IMEI or serial…"
            aria-label="IMEI or serial number"
            className="h-10 w-full rounded-lg bg-slate-100 pr-3 pl-9 text-sm ring-1 ring-transparent focus:bg-white focus:ring-brand-600 focus:outline-none"
          />
        </div>
        <Button type="submit" loading={busy} disabled={!imei.trim()}>
          Find
        </Button>
      </form>

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" data-handset-missing>
          {error}
        </p>
      )}

      {found && (
        <div className="mt-4 space-y-3" data-handset-found>
          {unit ? (
            <div className="rounded-xl bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-semibold text-slate-900">
                    <Smartphone size={16} className="shrink-0 text-slate-500" />
                    <span className="truncate">{unit.product_name}</span>
                  </p>
                  <p className="tnum mt-0.5 text-xs text-slate-500">
                    IMEI {unit.imei}
                    {unit.imei2 ? ` · ${unit.imei2}` : ''}
                    {unit.sku ? ` · ${unit.sku}` : ''}
                  </p>
                </div>
                <Badge tone={status.tone}>{status.label}</Badge>
              </div>
              <dl className="mt-3 space-y-1.5 text-sm">
                {(unit.status === 'in_stock' || unit.status === 'returned') && (
                  <Row label="Where">
                    {unit.branch_name || 'This shop'}
                    {unit.condition && unit.condition !== 'new' ? ` · ${unit.condition}` : ''}
                    {` · sells for ${money(unit.price)}`}
                  </Row>
                )}
                {found.sale && (
                  <Row label="Sold">
                    {day(found.sale.at)}
                    {found.sale.customer_name ? ` · to ${found.sale.customer_name}` : ''}
                    {found.sale.customer_phone ? ` · ${found.sale.customer_phone}` : ''}
                    {' · '}
                    <button
                      type="button"
                      className="font-medium text-brand-700 hover:underline"
                      onClick={() =>
                        go(
                          found.sale.kind === 'order'
                            ? `/admin/orders?number=${encodeURIComponent(found.sale.number)}`
                            : `/admin/documents?number=${encodeURIComponent(found.sale.number)}`,
                        )
                      }
                    >
                      {found.sale.number}
                    </button>
                  </Row>
                )}
                {unit.warranty_months > 0 && unit.warranty_starts && (
                  <Row label="Warranty">
                    {unit.warranty_months} months from {day(unit.warranty_starts)}
                  </Row>
                )}
                {found.received && (
                  <Row label="Came in">
                    {day(found.received.at)}
                    {found.received.party_name ? ` · from ${found.received.party_name}` : ''}
                    {' · '}
                    <button
                      type="button"
                      className="font-medium text-brand-700 hover:underline"
                      onClick={() => go(`/admin/documents?number=${encodeURIComponent(found.received.number)}`)}
                    >
                      {found.received.number}
                    </button>
                  </Row>
                )}
                {found.tradeIn && (
                  <Row label="Bought in">
                    {day(found.tradeIn.at)}
                    {found.tradeIn.seller_name ? ` · from ${found.tradeIn.seller_name}` : ''}
                    {found.tradeIn.seller_phone ? ` · ${found.tradeIn.seller_phone}` : ''}
                    {' · '}
                    <button
                      type="button"
                      className="font-medium text-brand-700 hover:underline"
                      onClick={() => go('/admin/trade-ins')}
                    >
                      trade-ins
                    </button>
                  </Row>
                )}
                {unit.cost > 0 && <Row label="Cost">{money(unit.cost)}</Row>}
              </dl>
            </div>
          ) : (
            <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Not one of ours — never on the shelf here. It has been in for repair:
            </p>
          )}

          {found.repairs.length > 0 && (
            <div className="rounded-xl ring-1 ring-slate-200">
              <p className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
                Repairs
              </p>
              <ul className="divide-y divide-slate-100">
                {found.repairs.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="font-mono text-xs text-slate-700">{t.ticket_number}</span>
                      <span className="text-slate-600"> · {t.customer_name}</span>
                      <span className="block truncate text-xs text-slate-400">
                        {day(t.created_at)} · {t.fault}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-xs font-medium text-brand-700 hover:underline"
                      onClick={() => go(`/admin/repairs?q=${encodeURIComponent(t.ticket_number)}`)}
                    >
                      {t.status.replace('_', ' ')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <ModalActions>
        <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
          Close
        </Button>
      </ModalActions>
    </Modal>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex gap-3">
      <dt className="w-16 shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 text-slate-800">{children}</dd>
    </div>
  );
}

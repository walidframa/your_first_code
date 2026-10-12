import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import api from '../api';
import { useLive } from '../lib/live';
import { useAuth } from '../context/AuthContext';
import { rangeFor as rangeOf, useHistoryFilter } from '../lib/history';
import { onDate, atTime } from '../lib/when';
import PageHeader from '../components/PageHeader';
import HistoryFilter from '../components/HistoryFilter';
import ExportList from '../components/ExportList';
import { Badge, Button, Card, EmptyState, Skeleton, cx, money } from '../components/ui';

/**
 * Every line sold, with its cost and the minute it went out.
 *
 * My sales is a list of receipts; the takings are one figure. Neither
 * answers "what did we actually sell today, at what, and when" — which is
 * the question a shop asks of itself at the end of a shift and of a cashier
 * the morning after. This is that list: one row per line sold, newest
 * first, across the register and the sales invoices, with the handset's
 * number on the row where there is one.
 *
 * The cost and the profit are on it only for whoever holds the catalogue
 * permission; the server leaves them out for everybody else, so there is
 * nothing here to hide.
 */
export default function ItemsSold() {
  const { can } = useAuth();
  const history = useHistoryFilter('today');
  const [data, setData] = useState(null);
  const [allBranches, setAllBranches] = useState(false);
  const [exporting, setExporting] = useState(false);
  const { preset, from, to } = history;

  const range = useMemo(() => {
    if (preset === 'custom') return { from, to };
    return rangeOf(preset);
  }, [preset, from, to]);

  const load = useCallback(() => {
    const params = {};
    if (range.from) params.from = range.from;
    if (range.to) params.to = range.to;
    if (allBranches) params.branch = 'all';
    api.get('/reports/items-sold', { params }).then((res) => setData(res.data));
  }, [range.from, range.to, allBranches]);

  useEffect(() => {
    load();
  }, [load]);
  useLive(load);

  const seesCost = Boolean(data?.seesCost);
  const rows = useMemo(
    () =>
      (data?.rows || []).filter((r) =>
        history.matches(r.name, r.sku, r.number, r.sold_by, r.customer_name, r.imei, r.imei2, r.imeis),
      ),
    [data, history],
  );

  /* Totals of what is on screen — the search narrows them too. */
  const totals = useMemo(() => {
    const t = { quantity: 0, sold: 0, cost: 0 };
    for (const r of rows) {
      t.quantity += r.net_quantity;
      t.sold += r.net_total;
      if (seesCost) t.cost += r.cost_total || 0;
    }
    return { ...t, profit: t.sold - t.cost };
  }, [rows, seesCost]);

  const columns = useMemo(
    () => [
      { key: 'date', label: 'Date', get: (r) => onDate(r.at), default: true },
      { key: 'time', label: 'Time', get: (r) => atTime(r.at), default: true },
      { key: 'name', label: 'Item', get: (r) => r.name, default: true },
      { key: 'sku', label: 'SKU', get: (r) => r.sku || '', default: false },
      { key: 'number', label: 'IMEI / serial', get: (r) => numbersOf(r), default: true },
      { key: 'quantity', label: 'Qty', get: (r) => r.net_quantity, align: 'right', default: true },
      { key: 'price', label: 'Price', get: (r) => r.price, align: 'right', default: true },
      { key: 'total', label: 'Total', get: (r) => r.net_total, align: 'right', default: true },
      ...(seesCost
        ? [
            { key: 'cost', label: 'Cost each', get: (r) => r.cost ?? '', align: 'right', default: true },
            { key: 'cost_total', label: 'Cost total', get: (r) => r.cost_total ?? '', align: 'right', default: true },
            { key: 'profit', label: 'Profit', get: (r) => r.profit ?? '', align: 'right', default: true },
          ]
        : []),
      { key: 'ref', label: 'Sold on', get: (r) => r.number, default: true },
      { key: 'status', label: 'Status', get: (r) => statusOf(r), default: true },
      { key: 'sold_by', label: 'Sold by', get: (r) => r.sold_by || '', default: true },
      { key: 'customer', label: 'Customer', get: (r) => r.customer_name || '', default: false },
    ],
    [seesCost],
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Items sold"
        subtitle={
          data
            ? `${rows.length} line${rows.length === 1 ? '' : 's'} · ${totals.quantity} item${totals.quantity === 1 ? '' : 's'} · ${money(totals.sold)}${seesCost ? ` · makes ${money(totals.profit)}` : ''}`
            : 'Loading…'
        }
        actions={
          <Button variant="secondary" size="sm" onClick={() => setExporting(true)} disabled={!data}>
            <Download size={15} /> Export
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <HistoryFilter filter={history} placeholder="An item, a number, a cashier, a customer…" label="Search items sold">
          {can('branches') && (
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={allBranches}
                onChange={(e) => setAllBranches(e.target.checked)}
                className="accent-brand-600"
              />
              All branches
            </label>
          )}
        </HistoryFilter>

        {!data ? (
          <Card className="space-y-2 p-5">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </Card>
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing sold in this period" description="Lines sold at the register and on sales invoices appear here as they happen." />
        ) : (
          <Card className="overflow-x-auto" data-items-sold>
            <table className="w-full text-sm sm:min-w-[56rem]">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-3 py-2.5 font-medium">Item</th>
                  <th className="px-3 py-2.5 text-right font-medium">Qty</th>
                  <th className="px-3 py-2.5 text-right font-medium">Price</th>
                  <th className="px-3 py-2.5 text-right font-medium">Total</th>
                  {seesCost && <th className="px-3 py-2.5 text-right font-medium">Cost</th>}
                  {seesCost && <th className="px-3 py-2.5 text-right font-medium">Profit</th>}
                  <th className="px-3 py-2.5 font-medium">Sold on</th>
                  <th className="px-4 py-2.5 font-medium">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {rows.map((r) => {
                  const dead = r.net_quantity === 0;
                  return (
                    <tr key={`${r.source}-${r.id}`} className={cx(dead && 'text-slate-400')}>
                      <td className="tnum px-4 py-2 align-top whitespace-nowrap">
                        <span className="block text-slate-800">{atTime(r.at)}</span>
                        <span className="block text-xs text-slate-400">{onDate(r.at)}</span>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span className={cx('block font-medium', dead ? 'line-through' : 'text-slate-800')}>
                          {r.name}
                          {r.is_gift ? <Badge tone="info" className="ml-2">gift</Badge> : null}
                        </span>
                        {r.sku && <span className="block text-xs text-slate-400">{r.sku}</span>}
                        {numbersOf(r) && (
                          <span className="tnum block font-mono text-[11px] text-slate-500">
                            {r.unit_kind === 'serial' ? 'SN' : 'IMEI'} {numbersOf(r)}
                          </span>
                        )}
                      </td>
                      <td className="tnum px-3 py-2 text-right align-top">
                        {r.net_quantity}
                        {r.net_quantity !== r.quantity && (
                          <span className="block text-xs text-slate-400">of {r.quantity}</span>
                        )}
                      </td>
                      <td className="tnum px-3 py-2 text-right align-top">{money(r.price)}</td>
                      <td className="tnum px-3 py-2 text-right align-top font-medium">{money(r.net_total)}</td>
                      {seesCost && (
                        <td className="tnum px-3 py-2 text-right align-top">
                          {r.cost === null ? '—' : money(r.cost)}
                          {r.cost !== null && r.net_quantity > 1 && (
                            <span className="block text-xs text-slate-400">{money(r.cost_total)} total</span>
                          )}
                        </td>
                      )}
                      {seesCost && (
                        <td
                          className={cx(
                            'tnum px-3 py-2 text-right align-top font-medium',
                            r.profit === null ? 'text-slate-400' : r.profit < 0 ? 'text-red-600' : 'text-brand-700',
                          )}
                        >
                          {r.profit === null ? '—' : money(r.profit)}
                        </td>
                      )}
                      <td className="px-3 py-2 align-top">
                        <span className="block font-mono text-xs text-slate-700">{r.number}</span>
                        <span className="flex flex-wrap gap-1">
                          <Badge tone="neutral">{r.source === 'invoice' ? 'invoice' : 'receipt'}</Badge>
                          {r.status === 'refunded' && <Badge tone="warning">refunded</Badge>}
                          {r.status !== 'refunded' && r.returned_qty > 0 && <Badge tone="warning">part returned</Badge>}
                        </span>
                      </td>
                      <td className="px-4 py-2 align-top text-slate-600">
                        {r.sold_by || '—'}
                        {r.customer_name && <span className="block text-xs text-slate-400">{r.customer_name}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold text-slate-800">
                <tr>
                  <td className="px-4 py-2.5" colSpan={2}>
                    Total
                  </td>
                  <td className="tnum px-3 py-2.5 text-right">{totals.quantity}</td>
                  <td />
                  <td className="tnum px-3 py-2.5 text-right">{money(totals.sold)}</td>
                  {seesCost && <td className="tnum px-3 py-2.5 text-right">{money(totals.cost)}</td>}
                  {seesCost && (
                    <td className={cx('tnum px-3 py-2.5 text-right', totals.profit < 0 ? 'text-red-600' : 'text-brand-700')}>
                      {money(totals.profit)}
                    </td>
                  )}
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </Card>
        )}
      </div>

      <ExportList
        open={exporting}
        onClose={() => setExporting(false)}
        title="Items sold"
        subtitle={[range.from && range.to ? `${range.from} to ${range.to}` : 'all time', allBranches && 'all branches'].filter(Boolean).join(' · ')}
        filename={`Items sold ${range.from || 'all'}${range.to && range.to !== range.from ? ` to ${range.to}` : ''}`}
        storageKey="pos_export_items_sold"
        columns={columns}
        rows={rows}
      />
    </div>
  );
}

/** The IMEI or serial on the row: the unit's own, or the invoice line's list. */
function numbersOf(r) {
  if (r.imei) return [r.imei, r.imei2].filter(Boolean).join(' · ');
  if (r.imeis) return String(r.imeis).split(/[\r\n]+/).filter(Boolean).join(' · ');
  return '';
}

function statusOf(r) {
  if (r.status === 'refunded') return 'refunded';
  if (r.returned_qty > 0) return `part returned (${r.returned_qty})`;
  return 'sold';
}

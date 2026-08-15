import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Search } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import OrderTable from '../../components/OrderTable';
import { Card, Input, money } from '../../components/ui';

/**
 * Named periods, so nobody types two dates to answer "what did we do today".
 *
 * "All" is here because a shop looking for one invoice from March does not know
 * it was March — they know the number, and the search box is above the list.
 */
const PRESETS = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['year', 'This year'],
  ['all', 'All'],
  ['custom', 'Between two dates'],
];

const iso = (d) => d.toISOString().slice(0, 10);

function rangeFor(preset) {
  const today = new Date();
  if (preset === 'today') return { from: iso(today), to: iso(today) };
  if (preset === 'week') {
    const start = new Date(today);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    return { from: iso(start), to: iso(today) };
  }
  if (preset === 'month') {
    return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(today) };
  }
  if (preset === 'year') {
    return { from: iso(new Date(today.getFullYear(), 0, 1)), to: iso(today) };
  }
  return { from: null, to: null };
}

/**
 * Everything the shop sold, however it was sold.
 *
 * Register sales and confirmed sales invoices in one list, because from the
 * shop's side they are the same event and a screen showing only half of them
 * had an owner counting a fraction of the day and believing it.
 */
export default function Orders() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [preset, setPreset] = useState('month');
  const [from, setFrom] = useState(iso(new Date()));
  const [to, setTo] = useState(iso(new Date()));
  const [term, setTerm] = useState('');

  const range = preset === 'custom' ? { from, to } : rangeFor(preset);

  const load = useCallback(() => {
    const params = {};
    if (range.from) params.from = range.from;
    if (range.to) params.to = range.to;
    api.get('/orders', { params }).then((res) => setOrders(res.data.orders));
    /*
     * Invoices are filtered here rather than by the server: /documents has no
     * date range of its own, and adding one to reach this screen would be a
     * second place for "which day is this on" to be decided differently.
     */
    api
      .get('/documents', { params: { type: 'sales_invoice', status: 'confirmed' } })
      .then((res) => setInvoices(res.data.documents))
      .catch(() => setInvoices([])); // A shop without the documents module still sells.
  }, [range.from, range.to]);

  useEffect(() => {
    load();
  }, [load]);

  const inRange = useMemo(
    () =>
      invoices.filter((d) => {
        const on = String(d.confirmed_at || d.created_at).slice(0, 10);
        return (!range.from || on >= range.from) && (!range.to || on <= range.to);
      }),
    [invoices, range.from, range.to],
  );

  /*
   * One box, matching whatever somebody has in front of them: a receipt with a
   * number on it, an invoice number read off a phone, or a customer's name.
   */
  const query = term.trim().toLowerCase();
  const matches = (haystack) => !query || String(haystack || '').toLowerCase().includes(query);
  const shownOrders = (orders || []).filter(
    (o) => matches(o.order_number) || matches(o.customer_name) || matches(o.cashier_name),
  );
  const shownInvoices = inRange.filter(
    (d) => matches(d.doc_number) || matches(d.party_name) || matches(d.user_name),
  );

  const completed = shownOrders.filter((o) => o.status === 'completed');
  const refunded = shownOrders.filter((o) => o.status === 'refunded');
  const takings =
    completed.reduce((sum, o) => sum + o.total, 0) + shownInvoices.reduce((sum, d) => sum + d.total, 0);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Sales"
        subtitle={
          orders
            ? `${completed.length} rung up · ${shownInvoices.length} invoiced · ${refunded.length} refunded · ${money(takings)}`
            : 'Loading…'
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="relative min-w-[16rem] flex-1">
              <Search
                size={16}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
              />
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Search a sale or invoice number, a customer, a cashier…"
                aria-label="Search sales"
                className="h-10 w-full rounded-lg bg-white pr-3 pl-9 text-sm ring-1 ring-slate-300 transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setPreset(id)}
                  aria-pressed={preset === id}
                  className={
                    preset === id
                      ? 'rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white'
                      : 'rounded-lg bg-white px-3 py-2 text-sm font-medium text-slate-600 ring-1 ring-slate-300 transition hover:bg-slate-50'
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {preset === 'custom' && (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <Input
                label="From"
                name="from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="max-w-[12rem]"
              />
              <Input
                label="To"
                name="to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="max-w-[12rem]"
              />
            </div>
          )}
        </Card>

        <OrderTable
          orders={orders && shownOrders}
          invoices={shownInvoices}
          showCashier
          canRefund
          onChanged={load}
          /* An invoice is corrected where it can be edited and reversed
             properly, not with a refund button that does not fit it. */
          onOpenInvoice={(d) => navigate(`/admin/documents?number=${encodeURIComponent(d.doc_number)}`)}
        />
      </div>
    </div>
  );
}

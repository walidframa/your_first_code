import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import OrderTable from '../../components/OrderTable';
import HistoryFilter from '../../components/HistoryFilter';
import { useHistoryFilter } from '../../lib/history';
import { money } from '../../components/ui';

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
  /*
   * Arrived here looking for one sale, from an item's history.
   *
   * A number in hand means the period is not the question — the sale could be
   * from March — so that landing opens on everything with the number already
   * typed, exactly as the documents screen does.
   */
  const [params] = useSearchParams();
  const arrivedFor = params.get('number') || '';
  const filter = useHistoryFilter(arrivedFor ? 'all' : 'month', arrivedFor);
  const { range, within, matches } = filter;

  const load = useCallback(() => {
    const params = {};
    if (range.from) params.from = range.from;
    if (range.to) params.to = range.to;
    /*
     * An empty list beats a screen of skeletons for ever. Without the catch a
     * single failed request left this page loading with nothing to press and
     * no way to know why.
     */
    api
      .get('/orders', { params })
      .then((res) => setOrders(res.data.orders))
      .catch(() => setOrders([]));
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
    () => invoices.filter((d) => within(d.confirmed_at || d.created_at)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [invoices, range.from, range.to],
  );

  /*
   * One box, matching whatever somebody has in front of them: a receipt with a
   * number on it, an invoice number read off a phone, or a customer's name.
   */
  const shownOrders = (orders || []).filter((o) =>
    matches(o.order_number, o.customer_name, o.cashier_name),
  );
  const shownInvoices = inRange.filter((d) => matches(d.doc_number, d.party_name, d.user_name));

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

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <HistoryFilter
          filter={filter}
          label="Search sales"
          placeholder="Search a sale or invoice number, a customer, a cashier…"
        />

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

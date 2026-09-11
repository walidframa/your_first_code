import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { X } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import OrderTable from '../../components/OrderTable';
import HistoryFilter from '../../components/HistoryFilter';
import ReturnLine from '../../components/ReturnLine';
import { ProductSalesList } from '../../components/ProductSales';
import { historyOf } from '../../lib/productHistory';
import { useHistoryFilter } from '../../lib/history';
import { money } from '../../components/ui';

/**
 * Everything the shop sold, however it was sold.
 *
 * Register sales and confirmed sales invoices in one list, because from the
 * shop's side they are the same event and a screen showing only half of them
 * had an owner counting a fraction of the day and believing it.
 *
 * The search goes to the server rather than over the page on screen, and it
 * understands a *product* as well as a receipt: type "charger" and the answer
 * is where chargers went — each sale it went out on, with the line ready to
 * take back — which is the question somebody has when a customer is standing
 * there with one and no receipt, at any hour, drawer open or not. Returned from
 * here, the money comes out of the shop's main cash; the server decides that.
 */
export default function Orders() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState(null);
  const [invoices, setInvoices] = useState([]);
  /* The product the search turned out to name, and the ones it might have. */
  const [product, setProduct] = useState(null);
  const [candidates, setCandidates] = useState([]);
  /* Picked off the candidates, which settles the question. */
  const [pickedId, setPickedId] = useState(null);
  /* The line being counted back, whichever sale it went out on. */
  const [returning, setReturning] = useState(null);
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
  const { range, within, matches, term } = filter;
  const searching = term.trim();

  const load = useCallback(() => {
    /*
     * A search deliberately drops the period: the sale being looked for is
     * almost never in it, which is why somebody is typing. A product picked
     * off the list is the same question asked more precisely.
     */
    const params = {};
    if (pickedId) params.productId = pickedId;
    else if (searching) params.q = searching;
    else {
      if (range.from) params.from = range.from;
      if (range.to) params.to = range.to;
    }
    /*
     * An empty list beats a screen of skeletons for ever. Without the catch a
     * single failed request left this page loading with nothing to press and
     * no way to know why.
     */
    api
      .get('/orders', { params })
      .then((res) => {
        setOrders(res.data.orders);
        setProduct(res.data.product || null);
        setCandidates(res.data.products || []);
      })
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
  }, [range.from, range.to, searching, pickedId]);

  /* Debounced while typing: a receipt number is one request, not sixteen. */
  useEffect(() => {
    const timer = setTimeout(load, searching && !pickedId ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, searching, pickedId]);

  /* A new search is a new question; the pick belonged to the old one. */
  useEffect(() => {
    setPickedId(null);
  }, [searching]);

  const inRange = useMemo(
    () => invoices.filter((d) => searching || within(d.confirmed_at || d.created_at)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [invoices, range.from, range.to, searching],
  );

  /*
   * The server has already answered the search for sales — including by the
   * name of a product on them, which the box on screen cannot see — so only the
   * invoices are narrowed here.
   */
  const shownOrders = orders || [];
  const shownInvoices = inRange.filter((d) => matches(d.doc_number, d.party_name, d.user_name));

  const completed = shownOrders.filter((o) => o.status === 'completed');
  const refunded = shownOrders.filter((o) => o.status === 'refunded');
  const takings =
    completed.reduce((sum, o) => sum + o.total, 0) + shownInvoices.reduce((sum, d) => sum + d.total, 0);

  const history = product ? historyOf(orders) : [];
  const soldTotal = history.reduce((n, h) => n + h.line.quantity, 0);
  const backTotal = history.reduce((n, h) => n + (h.line.returned_qty || 0), 0);

  function subtitle() {
    if (!orders) return 'Loading…';
    if (product) {
      if (!history.length) return `${product.name} has not been sold`;
      return `${product.name} · ${soldTotal} sold across ${history.length} sale${
        history.length === 1 ? '' : 's'
      }${backTotal ? ` · ${backTotal} already back` : ''}`;
    }
    return `${completed.length} rung up · ${shownInvoices.length} invoiced · ${refunded.length} refunded · ${money(takings)}`;
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Sales" subtitle={subtitle()} />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <HistoryFilter
          filter={filter}
          label="Search sales"
          placeholder="A sale or invoice number, a customer, a cashier — or a product, to see where it went"
        />

        {/*
          * Several products fit what was typed. Offered rather than guessed:
          * "blue" is a charger and a cable, and returning the wrong one is a
          * stock count that is off twice.
          */}
        {candidates.length > 0 && !product && (
          <div className="mb-3 flex flex-wrap items-center gap-2" data-product-candidates>
            <span className="text-xs text-slate-500">Did you mean a product?</span>
            {candidates.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPickedId(p.id)}
                className="pressable rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-200"
              >
                {p.name}
                {p.sku ? <span className="ml-1 text-slate-400">{p.sku}</span> : null}
              </button>
            ))}
          </div>
        )}

        {product ? (
          <>
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-sm text-slate-600">
                Every sale <span className="font-medium text-slate-800">{product.name}</span> went out on,
                newest first. Return it off whichever one it was.
              </p>
              {pickedId && (
                <button
                  type="button"
                  onClick={() => setPickedId(null)}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-500 transition hover:bg-slate-100"
                >
                  <X size={13} /> Back to the search
                </button>
              )}
            </div>
            <ProductSalesList history={history} onReturn={setReturning} />
          </>
        ) : (
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
        )}
      </div>

      {returning && (
        <ReturnLine
          order={returning.order}
          item={returning.line}
          onClose={() => setReturning(null)}
          onDone={() => {
            setReturning(null);
            load();
          }}
        />
      )}
    </div>
  );
}

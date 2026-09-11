import { useCallback, useEffect, useState } from 'react';
import api from '../api';
import OrderTable from './OrderTable';
import ReturnLine from './ReturnLine';
import BarcodeScanner, { ScanButton, canScan } from './BarcodeScanner';
import { ProductSalesList } from './ProductSales';
import { historyOf } from '../lib/productHistory';
import { lbp, useSettings } from '../context/SettingsContext';
import { Input, Modal, money } from './ui';

/**
 * The sales this register can still do something about.
 *
 * Three questions, one box, because at a counter they are asked in the same
 * breath and only the first of them used to have an answer here:
 *
 * - **"What have I rung up on this till?"** — the sitting, which is the span
 *   the drawer will be counted against at close. That is what opens.
 * - **"This came back, where is the sale?"** — a search by the number on the
 *   receipt, or by who bought it.
 * - **"This came back and there is no receipt."** — which is the ordinary case,
 *   and the thing in their hand is the *product*. So the scanner works in this
 *   box too: scan what they are holding and its sales are the answer, with the
 *   line ready to take back off whichever one it went out on.
 *
 * Shown over the register rather than as somewhere to navigate to: a cart being
 * built is held in the register's own state, and walking away to look something
 * up would throw it away. The customer is still standing there.
 */
export default function SittingSales({ onClose, onChanged }) {
  const { rate } = useSettings();
  const [orders, setOrders] = useState(null);
  /* The product the query turned out to name, when it named one. */
  const [product, setProduct] = useState(null);
  const [query, setQuery] = useState('');
  const [scanning, setScanning] = useState(false);
  /* What the list on screen is actually answering, so the subtitle cannot say
     "this sitting" over a set of results from three weeks ago. */
  const [searched, setSearched] = useState('');
  /* The line being counted back, whichever sale it went out on. */
  const [returning, setReturning] = useState(null);

  const load = useCallback(async (q) => {
    const term = String(q || '').trim();
    setOrders(null);
    const res = await api.get('/orders', {
      // A search deliberately drops the sitting: the sale being looked for is
      // almost never on it, which is why somebody is typing.
      params: term ? { q: term } : { scope: 'sitting' },
    });
    setOrders(res.data.orders);
    setProduct(res.data.product || null);
    setSearched(term);
  }, []);

  /*
   * Debounced, because this runs on every keystroke against a counter's
   * connection. 300ms is long enough that typing a receipt number is one
   * request rather than sixteen, and short enough that nobody waits.
   */
  useEffect(() => {
    const timer = setTimeout(() => load(query), query.trim() ? 300 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  /*
   * Voided sales are shown but not counted. They happened, and hiding them is
   * how somebody voids the same sale twice — but the takings are what the shop
   * actually kept.
   */
  const live = (orders || []).filter((o) => o.status !== 'refunded');
  const takings = live.reduce((sum, o) => sum + o.total, 0);

  /* Every line of the scanned product, newest sale first. */
  const history = historyOf(orders);
  const soldTotal = history.reduce((n, h) => n + h.line.quantity, 0);
  const backTotal = history.reduce((n, h) => n + (h.line.returned_qty || 0), 0);

  function subtitle() {
    if (orders === null) return 'Loading…';
    if (product) {
      if (!history.length) return `${product.name} has not been sold`;
      return `${product.name} · ${soldTotal} sold across ${history.length} sale${
        history.length === 1 ? '' : 's'
      }${backTotal ? ` · ${backTotal} already back` : ''}`;
    }
    if (searched) {
      return orders.length === 0
        ? `Nothing matches “${searched}”`
        : `${orders.length} sale${orders.length === 1 ? '' : 's'} matching “${searched}”`;
    }
    if (orders.length === 0) return 'Nothing rung up on this sitting yet';
    /*
     * The refunded count belongs in the same breath as the takings.
     *
     * "0 sales · $0.00" printed directly above a list of three sales reads as
     * the screen contradicting itself, when what it means is that all three
     * came back. Saying so costs four words and stops the figure looking
     * broken.
     */
    const back = orders.length - live.length;
    return `${live.length} sale${live.length === 1 ? '' : 's'} · ${money(takings)}${
      rate > 0 ? ` · ${lbp(Math.round(takings * rate))}` : ''
    }${back > 0 ? ` · ${back} refunded, not counted` : ''}`;
  }

  return (
    <>
      <Modal open onClose={onClose} size="xl" title="Sales and returns" subtitle={subtitle()}>
        {/*
          * The search is the first thing in the dialog rather than above the
          * list, because the reason this dialog gets opened by somebody who is
          * not just curious is that a customer is holding something.
          */}
        <div className="mb-3 flex items-end gap-2">
          <Input
            className="flex-1"
            name="findSale"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            placeholder="Scan the product, or type a receipt number or customer"
            hint="Leave it empty for this sitting. Scanning what the customer is holding shows every sale it went out on."
          />
          {canScan() && (
            <ScanButton
              onClick={() => setScanning(true)}
              label="Scan what is being brought back"
              className="mb-6 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 transition hover:bg-slate-200 hover:text-slate-800"
            />
          )}
        </div>

        {product ? (
          <ProductSalesList history={history} onReturn={setReturning} />
        ) : (
          /*
           * Refunding is offered here whatever the role: the server decides,
           * and a cashier without the permission is told so rather than being
           * shown a screen with the one useful button missing and no
           * explanation.
           */
          <OrderTable
            orders={orders}
            showCashier
            canRefund
            onChanged={() => {
              load(query);
              onChanged?.();
            }}
          />
        )}
      </Modal>

      {scanning && (
        <BarcodeScanner
          onCancel={() => setScanning(false)}
          onScanned={(code) => {
            setScanning(false);
            setQuery(code);
          }}
        />
      )}

      {returning && (
        <ReturnLine
          order={returning.order}
          item={returning.line}
          onClose={() => setReturning(null)}
          onDone={() => {
            setReturning(null);
            load(query);
            onChanged?.();
          }}
        />
      )}
    </>
  );
}

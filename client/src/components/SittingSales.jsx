import { useCallback, useEffect, useState } from 'react';
import api from '../api';
import OrderTable from './OrderTable';
import { lbp, useSettings } from '../context/SettingsContext';
import { Input, Modal, money } from './ui';

/**
 * The sales this register can still do something about.
 *
 * Two questions, one screen, because they are asked in the same breath at a
 * counter and the second one used to have no answer here at all:
 *
 * - **"What have I rung up on this till?"** — the sitting, which is the span
 *   the drawer will be counted against at close. That is what opens.
 * - **"This came back, where is the sale?"** — which is a *search*, and until
 *   this box existed it could only be answered from the back office. A customer
 *   returning something the next morning is not in this sitting, and telling
 *   the person at the counter to go and find it somewhere else is how a return
 *   turns into an argument with a customer standing there.
 *
 * Shown over the register rather than as somewhere to navigate to: a cart being
 * built is held in the register's own state, and walking away to look something
 * up would throw it away. The customer is still standing there.
 */
export default function SittingSales({ onClose, onChanged }) {
  const { rate } = useSettings();
  const [orders, setOrders] = useState(null);
  const [query, setQuery] = useState('');
  /* What the list on screen is actually answering, so the subtitle cannot say
     "this sitting" over a set of results from three weeks ago. */
  const [searched, setSearched] = useState('');

  const load = useCallback(async (q) => {
    const term = String(q || '').trim();
    setOrders(null);
    const res = await api.get('/orders', {
      // A search deliberately drops the sitting: the sale being looked for is
      // almost never on it, which is why somebody is typing.
      params: term ? { q: term } : { scope: 'sitting' },
    });
    setOrders(res.data.orders);
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

  function subtitle() {
    if (orders === null) return 'Loading…';
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
    <Modal open onClose={onClose} size="xl" title="Sales and returns" subtitle={subtitle()}>
      {/*
        * The search is the first thing in the dialog rather than above the
        * list, because the reason this dialog gets opened by somebody who is
        * not just curious is that a customer is holding a receipt.
        */}
      <div className="mb-3">
        <Input
          name="findSale"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          placeholder="Receipt number or customer"
          hint="Leave it empty for this sitting. Type the end of the number on the receipt to find an older sale, then open it and press Return beside the line coming back."
        />
      </div>

      {/*
        * Refunding is offered here whatever the role: the server decides, and a
        * cashier without the permission is told so rather than being shown a
        * screen with the one useful button missing and no explanation.
        */}
      <OrderTable
        orders={orders}
        showCashier
        canRefund
        onChanged={() => {
          load(query);
          onChanged?.();
        }}
      />
    </Modal>
  );
}

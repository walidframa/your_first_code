import { useCallback, useEffect, useState } from 'react';
import api from '../api';
import OrderTable from './OrderTable';
import { lbp, useSettings } from '../context/SettingsContext';
import { Modal, money } from './ui';

/**
 * What this register has sold since the drawer was opened.
 *
 * The question at the counter is never "what have we ever sold" — it is "what
 * have I rung up on this till today", because that is the span the drawer will
 * be counted against at close, and because the sale somebody wants to correct
 * is almost always the last one or the one before it.
 *
 * Shown over the register rather than as somewhere to navigate to: a cart being
 * built is held in the register's own state, and walking away to look something
 * up would throw it away. The customer is still standing there.
 */
export default function SittingSales({ onClose, onChanged }) {
  const { rate } = useSettings();
  const [orders, setOrders] = useState(null);

  const load = useCallback(async () => {
    const res = await api.get('/orders', { params: { scope: 'sitting' } });
    setOrders(res.data.orders);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /*
   * Voided sales are shown but not counted. They happened, and hiding them is
   * how somebody voids the same sale twice — but the takings are what the shop
   * actually kept.
   */
  const live = (orders || []).filter((o) => o.status !== 'refunded');
  const takings = live.reduce((sum, o) => sum + o.total, 0);

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="This register's sales"
      subtitle={
        orders === null
          ? 'Loading…'
          : orders.length === 0
            ? 'Nothing rung up on this sitting yet'
            : /*
               * The refunded count belongs in the same breath as the takings.
               *
               * "0 sales · $0.00" printed directly above a list of three sales
               * reads as the screen contradicting itself, when what it means is
               * that all three came back. Saying so costs four words and stops
               * the figure looking broken.
               */
              `${live.length} sale${live.length === 1 ? '' : 's'} · ${money(takings)}${
                rate > 0 ? ` · ${lbp(Math.round(takings * rate))}` : ''
              }${
                orders.length - live.length > 0
                  ? ` · ${orders.length - live.length} refunded, not counted`
                  : ''
              }`
      }
    >
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
          load();
          onChanged?.();
        }}
      />
    </Modal>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import api from '../api';
import ReturnLine from './ReturnLine';
import { Badge, Card, EmptyState, Skeleton, money } from './ui';
import { when } from '../lib/when';
import { historyOf } from '../lib/productHistory';

/**
 * Where one product went, and the way back.
 *
 * A list of receipts is the wrong shape for this question. What somebody wants
 * to know, holding a charger with no receipt, is which sales it went out on and
 * how many are still with the customer — so that is what each row says, and the
 * button that takes it back is on the row rather than two screens further in.
 *
 * The line is returned off its own sale whatever else was on it. That has
 * always been true of the server; it was the finding that was missing.
 *
 * Shared by the register's "Sales & returns", the Sales screen and a product's
 * own history, so a return is the same three presses wherever the product was
 * found — including after the drawer has been counted and closed, when the
 * money comes out of the shop's main cash instead (the server decides that).
 */
export function ProductSalesList({ history, onReturn }) {
  if (!history.length) {
    return (
      <EmptyState
        icon={RotateCcw}
        title="Not sold yet"
        description="This product has not gone out on any sale, so there is nothing to take back."
      />
    );
  }

  return (
    <Card>
      <ul className="divide-y divide-rule" data-product-sales>
        {history.map(({ order, line }) => {
          const left = line.quantity - (line.returned_qty || 0);
          return (
            <li
              key={line.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">{order.order_number}</p>
                <p className="truncate text-xs text-slate-500">
                  {when(order.created_at)}
                  {order.customer_name ? ` · ${order.customer_name}` : ''}
                  {order.cashier_name ? ` · ${order.cashier_name}` : ''}
                </p>
              </div>

              <div className="flex items-center gap-3">
                <span className="tnum text-end text-sm text-slate-700">
                  <span className="text-slate-400">{line.quantity} ×</span> {money(line.price)}
                </span>

                {/*
                  * What is still with the customer, which is the only number
                  * that decides whether anything can come back.
                  */}
                {order.status === 'refunded' ? (
                  <Badge tone="warning">Voided</Badge>
                ) : left === 0 ? (
                  <Badge tone="neutral">All back</Badge>
                ) : (
                  <button
                    type="button"
                    onClick={() => onReturn({ order, line })}
                    className="pressable rounded-lg bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-800 ring-1 ring-brand-200 transition ring-inset hover:bg-brand-100"
                  >
                    Return {left > 1 ? `up to ${left}` : ''}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * The list above, loading its own sales for one product and handling the
 * return itself — for screens that already know which product they mean.
 */
export function ProductSalesHistory({ productId, onChanged }) {
  const [orders, setOrders] = useState(null);
  const [returning, setReturning] = useState(null);

  const load = useCallback(async () => {
    const res = await api.get('/orders', { params: { productId } });
    setOrders(res.data.orders);
  }, [productId]);

  useEffect(() => {
    load();
  }, [load]);

  if (orders === null) return <Skeleton className="h-24" />;

  const history = historyOf(orders);
  const sold = history.reduce((n, h) => n + h.line.quantity, 0);
  const back = history.reduce((n, h) => n + (h.line.returned_qty || 0), 0);

  return (
    <>
      {history.length > 0 && (
        <p className="mb-1.5 text-xs text-slate-500">
          {sold} sold across {history.length} sale{history.length === 1 ? '' : 's'}
          {back ? ` · ${back} already back` : ''}
        </p>
      )}
      <ProductSalesList history={history} onReturn={setReturning} />
      {returning && (
        <ReturnLine
          order={returning.order}
          item={returning.line}
          onClose={() => setReturning(null)}
          onDone={() => {
            setReturning(null);
            load();
            onChanged?.();
          }}
        />
      )}
    </>
  );
}

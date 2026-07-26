import { useState } from 'react';
import { Receipt as ReceiptIcon, RotateCcw } from 'lucide-react';
import api from '../api';
import { Badge, Button, Card, EmptyState, Modal, Skeleton, money, useToast } from './ui';

/**
 * Shared order history table. Admins see every cashier's orders and can refund;
 * cashiers see only their own (enforced server-side too).
 */
export default function OrderTable({ orders, showCashier = false, canRefund = false, onChanged }) {
  const toast = useToast();
  const [selected, setSelected] = useState(null);
  const [refunding, setRefunding] = useState(false);

  async function openOrder(id) {
    const res = await api.get(`/orders/${id}`);
    setSelected(res.data);
  }

  async function refund(id) {
    setRefunding(true);
    try {
      await api.post(`/orders/${id}/refund`);
      toast('Order refunded and stock restored');
      setSelected(null);
      onChanged?.();
    } catch (err) {
      toast(err.response?.data?.error || 'Refund failed', 'error');
    } finally {
      setRefunding(false);
    }
  }

  if (!orders) {
    return (
      <Card className="space-y-2 p-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-11" />
        ))}
      </Card>
    );
  }

  return (
    <>
      <Card>
        {orders.length === 0 ? (
          <EmptyState icon={ReceiptIcon} title="No sales yet" description="Completed sales will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Order</th>
                  {showCashier && <th className="px-3 py-2.5 font-medium">Cashier</th>}
                  <th className="px-3 py-2.5 font-medium">Date</th>
                  <th className="px-3 py-2.5 font-medium">Payment</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {orders.map((o) => (
                  <tr
                    key={o.id}
                    onClick={() => openOrder(o.id)}
                    className="cursor-pointer hover:bg-slate-50/60"
                  >
                    <td className="px-5 py-2.5 font-medium text-slate-800">{o.order_number}</td>
                    {showCashier && <td className="px-3 py-2.5 text-slate-500">{o.cashier_name}</td>}
                    <td className="px-3 py-2.5 text-slate-500">{o.created_at}</td>
                    <td className="px-3 py-2.5 text-slate-500 capitalize">{o.payment_method}</td>
                    <td className="px-3 py-2.5">
                      {o.status === 'refunded' ? (
                        <Badge tone="warning">Refunded</Badge>
                      ) : (
                        <Badge tone="good">Completed</Badge>
                      )}
                    </td>
                    <td className="tnum px-5 py-2.5 text-right font-semibold text-slate-900">
                      {money(o.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selected && (
        <Modal
          open
          onClose={() => setSelected(null)}
          size="sm"
          title={selected.order.order_number}
          subtitle={`${selected.order.created_at}${selected.order.cashier_name ? ` · ${selected.order.cashier_name}` : ''}`}
        >
          <div className="space-y-1.5 border-b border-dashed border-slate-200 pb-3 text-sm">
            {selected.items.map((item) => (
              <div key={item.id} className="flex justify-between gap-3">
                <span className="min-w-0 text-slate-600">
                  <span className="tnum text-slate-400">{item.quantity}×</span> {item.name}
                </span>
                <span className="tnum shrink-0 text-slate-800">{money(item.line_total)}</span>
              </div>
            ))}
          </div>

          <dl className="space-y-1 py-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Subtotal</dt>
              <dd className="tnum text-slate-700">{money(selected.order.subtotal)}</dd>
            </div>
            {selected.order.discount > 0 && (
              <div className="flex justify-between">
                <dt className="text-slate-500">Discount</dt>
                <dd className="tnum text-slate-700">−{money(selected.order.discount)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-slate-500">Tax</dt>
              <dd className="tnum text-slate-700">{money(selected.order.tax)}</dd>
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-1.5 font-semibold">
              <dt className="text-slate-900">Total</dt>
              <dd className="tnum text-slate-900">{money(selected.order.total)}</dd>
            </div>
          </dl>

          {canRefund && selected.order.status === 'completed' && (
            <Button
              variant="danger"
              className="w-full"
              loading={refunding}
              onClick={() => refund(selected.order.id)}
            >
              <RotateCcw size={15} /> Refund order
            </Button>
          )}
          {selected.order.status === 'refunded' && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-center text-sm text-amber-800">
              This order was refunded and stock was restored.
            </p>
          )}
        </Modal>
      )}
    </>
  );
}

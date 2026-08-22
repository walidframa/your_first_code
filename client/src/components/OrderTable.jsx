import { useState } from 'react';
import { Printer, Receipt as ReceiptIcon, RotateCcw } from 'lucide-react';
import api from '../api';
import Receipt from './Receipt';
import { useConfirm } from './ConfirmProvider';
import { when } from '../lib/when';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  ModalActions,
  Skeleton,
  money,
  useToast,
} from './ui';

/**
 * Shared sales history. Admins see every cashier's sales and can refund;
 * cashiers see only their own (enforced server-side too).
 *
 * `invoices` puts confirmed sales invoices in the same list, because from the
 * shop's side they are the same event — goods left, money is owed or was paid —
 * and a "Sales" screen that quietly showed only the ones rung up on the till
 * left an owner counting a fraction of the day and believing it. They are
 * marked as invoices rather than blended in: a refund belongs to a register
 * sale, and an invoice is corrected on the Documents screen where it can be
 * edited, converted and reversed properly.
 */
export default function OrderTable({
  orders,
  invoices = [],
  showCashier = false,
  canRefund = false,
  onChanged,
  onOpenInvoice,
}) {
  const toast = useToast();
  const [selected, setSelected] = useState(null);
  const [refunding, setRefunding] = useState(false);
  const [reprinting, setReprinting] = useState(null);
  const confirm = useConfirm();
  // The line whose return is being counted out.
  const [returning, setReturning] = useState(null);

  async function openOrder(id) {
    const res = await api.get(`/orders/${id}`);
    setSelected(res.data);
  }

  async function refund(id) {
    const order = selected?.order;
    const agreed = await confirm({
      title: `Void ${order?.order_number || 'this sale'}?`,
      body: (
        <>
          The whole sale comes back: every item returns to the shelf and{' '}
          <strong>{money(order?.total || 0)}</strong> comes out of what the shop has taken. The sale
          stays on the day's list, marked refunded.
        </>
      ),
      confirmLabel: 'Void the sale',
      cancelLabel: 'Keep it',
    });
    if (!agreed) return;

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

  const rows = [
    ...(orders || []).map((o) => ({ ...o, kind: 'order', at: o.created_at, ref: o.order_number })),
    ...invoices.map((d) => ({
      ...d,
      kind: 'invoice',
      at: d.confirmed_at || d.created_at,
      ref: d.doc_number,
    })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

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
        {rows.length === 0 ? (
          <EmptyState icon={ReceiptIcon} title="No sales yet" description="Completed sales will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Sale</th>
                  {showCashier && (
                    <th className="hidden px-3 py-2.5 font-medium md:table-cell">Cashier</th>
                  )}
                  <th className="px-3 py-2.5 font-medium">Date</th>
                  <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Payment</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((o) => (
                  <tr
                    key={`${o.kind}-${o.id}`}
                    onClick={() => (o.kind === 'order' ? openOrder(o.id) : onOpenInvoice?.(o))}
                    className="cursor-pointer hover:bg-slate-50/60"
                  >
                    <td className="px-5 py-2.5 font-medium text-slate-800">
                      {o.ref}
                      {o.kind === 'invoice' && (
                        <span className="ml-2 text-xs font-normal text-slate-400">invoice</span>
                      )}
                    </td>
                    {showCashier && (
                      <td className="hidden px-3 py-2.5 text-slate-500 md:table-cell">
                        {o.kind === 'order' ? o.cashier_name : o.user_name}
                      </td>
                    )}
                    <td className="px-3 py-2.5 text-slate-500">{when(o.at)}</td>
                    <td className="hidden px-3 py-2.5 text-slate-500 capitalize sm:table-cell">
                      {o.kind === 'order'
                        ? o.payment_method
                        : o.outstanding > 0
                          ? 'on account'
                          : o.payment_method || 'paid'}
                    </td>
                    <td className="px-3 py-2.5">
                      {o.kind === 'invoice' ? (
                        <Badge tone={o.outstanding > 0 ? 'info' : 'good'}>
                          {o.outstanding > 0 ? 'Owing' : 'Invoiced'}
                        </Badge>
                      ) : o.status === 'refunded' ? (
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
          subtitle={`${when(selected.order.created_at)}${selected.order.cashier_name ? ` · ${selected.order.cashier_name}` : ''}`}
        >
          {/*
            * A line at a time, because that is how things actually come back —
            * one of the six, not the sale. Voiding the whole thing to put one
            * item back loses the sale's own prices and its place in the day.
            */}
          <div className="space-y-1.5 border-b border-dashed border-slate-200 pb-3 text-sm">
            {selected.items.map((item) => {
              const left = item.quantity - (item.returned_qty || 0);
              return (
                <div key={item.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-slate-600">
                    <span className="tnum text-slate-400">{item.quantity}×</span> {item.name}
                    {item.returned_qty > 0 && (
                      <span className="ml-1.5 text-xs text-amber-700">
                        {left === 0 ? 'returned' : `${item.returned_qty} returned`}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-baseline gap-2">
                    <span className="tnum text-slate-800">{money(item.line_total)}</span>
                    {canRefund && selected.order.status === 'completed' && left > 0 && (
                      <button
                        onClick={() => setReturning(item)}
                        className="rounded px-1.5 py-0.5 text-xs font-medium text-brand-700 transition hover:bg-brand-50"
                      >
                        Return
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
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
            {/* Only when the sale carried any — see Receipt.jsx. */}
            {selected.order.tax > 0 && (
              <div className="flex justify-between">
                <dt className="text-slate-500">Tax</dt>
                <dd className="tnum text-slate-700">{money(selected.order.tax)}</dd>
              </div>
            )}
            <div className="flex justify-between border-t border-slate-100 pt-1.5 font-semibold">
              <dt className="text-slate-900">Total</dt>
              <dd className="tnum text-slate-900">{money(selected.order.total)}</dd>
            </div>
          </dl>

          {/*
            * Printed again, whenever. A customer comes back a week later
            * wanting the paper for a warranty claim, and the sale is right
            * here — asking them to have kept it is not an answer.
            */}
          <Button variant="secondary" className="w-full" onClick={() => setReprinting(selected)}>
            <Printer size={15} /> Print the receipt again
          </Button>

          {canRefund && selected.order.status === 'completed' && (
            <Button
              variant="danger"
              className="mt-2 w-full"
              loading={refunding}
              onClick={() => refund(selected.order.id)}
            >
              <RotateCcw size={15} /> Void the whole sale
            </Button>
          )}
          {selected.order.status === 'refunded' && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-center text-sm text-amber-800">
              This order was refunded and stock was restored.
            </p>
          )}
        </Modal>
      )}

      {reprinting && (
        <Receipt receipt={reprinting} onClose={() => setReprinting(null)} reprint />
      )}

      {returning && (
        <ReturnLine
          order={selected.order}
          item={returning}
          onClose={() => setReturning(null)}
          onDone={async () => {
            setReturning(null);
            // The sale itself may have just become void, and the lines have
            // certainly moved — read it back rather than patching it here.
            await openOrder(selected.order.id);
            onChanged?.();
          }}
        />
      )}
    </>
  );
}

/**
 * How many of this line are coming back.
 *
 * Asked rather than assumed, because a customer returning two of five is the
 * ordinary case and a dialog that silently took all five would be handing over
 * money nobody asked for. What goes back is worked out on the server — it is
 * the line's share of what was actually paid, after the discount and with the
 * tax, which is not a figure to let the browser assert.
 */
function ReturnLine({ order, item, onClose, onDone }) {
  const toast = useToast();
  const left = item.quantity - (item.returned_qty || 0);
  const [quantity, setQuantity] = useState(String(left));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/orders/${order.id}/return-line`, {
        itemId: item.id,
        quantity: Number(quantity),
      });
      toast(`${money(res.data.refunded)} back to the customer`);
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record that return');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="sm" title={`Return ${item.name}`} subtitle={order.order_number}>
      <Input
        label="How many are coming back"
        name="returnQuantity"
        type="number"
        min="1"
        max={String(left)}
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        hint={`${left} of ${item.quantity} still with the customer`}
        autoFocus
      />

      <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
        What goes back is this line's share of what was paid — after the discount and with the tax —
        not its price on the shelf. The stock, or the card's credit, comes back with it.
      </p>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <ModalActions>
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button
          className="flex-1"
          loading={busy}
          disabled={!(Number(quantity) > 0) || Number(quantity) > left}
          onClick={submit}
        >
          <RotateCcw size={15} /> Take it back
        </Button>
      </ModalActions>
    </Modal>
  );
}

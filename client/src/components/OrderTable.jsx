import { useState } from 'react';
import { Banknote, CreditCard, Landmark, Printer, Receipt as ReceiptIcon, RotateCcw, Send } from 'lucide-react';
import api from '../api';
import Receipt from './Receipt';
import { useConfirm } from './ConfirmProvider';
import ReturnLine from './ReturnLine';
import { useNarrow } from '../lib/screen';
import { when } from '../lib/when';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Modal,
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
/**
 * How a sale was paid, at a glance.
 *
 * "Cash" and "Card" in the same grey read as the same thing until somebody
 * actually reads the word — and the owner going down the day's list is not
 * reading words, they are looking for the card sales, because those are the
 * ones that are not in the drawer. A colour and a mark does that at the speed
 * the eye moves; the word is still there for anybody who wants it.
 */
const PAYMENT_LOOKS = {
  cash: { tone: 'good', icon: Banknote, label: 'Cash' },
  card: { tone: 'info', icon: CreditCard, label: 'Card' },
  account: { tone: 'warning', icon: Landmark, label: 'On account' },
  transfer: { tone: 'brand', icon: Send, label: 'Transfer' },
  split: { tone: 'neutral', icon: null, label: 'Split' },
};

export function PaymentBadge({ method, className }) {
  const look = PAYMENT_LOOKS[method] || { tone: 'neutral', icon: null, label: method || 'Paid' };
  return (
    <Badge tone={look.tone} icon={look.icon} className={className}>
      {look.label}
    </Badge>
  );
}

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
  /* One list or the other, never both in the DOM — see the rows below. */
  const narrow = useNarrow();
  // The line whose return is being counted out.
  const [returning, setReturning] = useState(null);

  async function openOrder(id) {
    const res = await api.get(`/orders/${id}`);
    setSelected(res.data);
  }

  /*
   * The way back from a return, and from a void.
   *
   * Both were final, and the only correction was ringing the thing up again
   * — a second sale on the day's list for something sold once. Refused by
   * the server where it cannot be true any more: a handset sold to somebody
   * else since, a shelf the goods have already left again.
   */
  async function undoReturn(item) {
    const order = selected?.order;
    const agreed = await confirm({
      title: `Undo the return of ${item.name}?`,
      body: (
        <>
          The goods go back off the shelf and the money comes back into the drawer — exactly what
          went out. {order?.order_number} is a sale again.
        </>
      ),
      confirmLabel: 'Undo the return',
    });
    if (!agreed) return;
    try {
      await api.post(`/orders/${order.id}/return-line/undo`, { itemId: item.id });
      toast('Return undone');
      await openOrder(order.id);
      onChanged?.();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not undo that return', 'error');
    }
  }

  async function unrefund(id) {
    const order = selected?.order;
    const agreed = await confirm({
      title: `Restore ${order?.order_number || 'this sale'}?`,
      body: (
        <>
          Everything that came back goes out again and <strong>{money(order?.total || 0)}</strong>{' '}
          comes back into the drawer. The sale is counted again.
        </>
      ),
      confirmLabel: 'Restore the sale',
    });
    if (!agreed) return;
    try {
      await api.post(`/orders/${id}/unrefund`);
      toast('Sale restored');
      await openOrder(id);
      onChanged?.();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not restore that sale', 'error');
    }
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
          <>
            {/*
              * A phone gets rows, not a table.
              *
              * Six columns squeezed into 380px wrapped a receipt number over
              * three lines and a date over four — unreadable at exactly the
              * counter returns are done at. Same rows, same order, stacked:
              * what it is and what it cost on the first line, when and who on
              * the second.
              *
              * Chosen here rather than with `sm:hidden`, because a class only
              * hides the second copy — both stay in the DOM. Every receipt
              * number would then appear twice, which doubles a five-hundred-row
              * list and makes "find the sale numbered X" ambiguous for anything
              * reading the page, tests included.
              */}
            {narrow ? (
              <ul className="divide-y divide-rule">
                {rows.map((o) => (
                  <li key={`${o.kind}-${o.id}`}>
                    <button
                      type="button"
                      onClick={() => (o.kind === 'order' ? openOrder(o.id) : onOpenInvoice?.(o))}
                      className="flex w-full flex-col gap-1 px-4 py-3 text-start transition hover:bg-slate-50/60"
                    >
                      <span className="flex w-full items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate text-sm font-medium text-slate-800">
                          {o.ref}
                          {o.kind === 'invoice' && (
                            <span className="ms-1.5 text-xs font-normal text-slate-400">invoice</span>
                          )}
                        </span>
                        <span className="tnum shrink-0 text-sm font-semibold text-slate-900">
                          {money(o.total)}
                        </span>
                      </span>
                      <span className="flex w-full items-center justify-between gap-3">
                        <span className="min-w-0 truncate text-xs text-slate-500">
                          {when(o.at)}
                          {showCashier && (o.cashier_name || o.user_name)
                            ? ` · ${o.kind === 'order' ? o.cashier_name : o.user_name}`
                            : ''}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {o.kind === 'order' && o.status !== 'refunded' && (
                            <PaymentBadge method={o.payment_method} />
                          )}
                          {o.kind === 'invoice' ? (
                            <Badge tone={o.outstanding > 0 ? 'info' : 'good'}>
                              {o.outstanding > 0 ? 'Owing' : 'Invoiced'}
                            </Badge>
                          ) : o.status === 'refunded' ? (
                            <Badge tone="warning">Refunded</Badge>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
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
              <tbody className="divide-y divide-rule">
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
                    <td className="hidden px-3 py-2.5 sm:table-cell">
                      <PaymentBadge
                        method={
                          o.kind === 'order'
                            ? o.payment_method
                            : o.outstanding > 0
                              ? 'account'
                              : o.payment_method || 'paid'
                        }
                      />
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
          </>
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
                        {/*
                          * A return made by mistake is undone here, on the
                          * line it was made on — goods back off the shelf,
                          * the money back into the drawer.
                          */}
                        {canRefund && (
                          <button
                            type="button"
                            onClick={() => undoReturn(item)}
                            className="ml-1.5 rounded px-1 font-medium text-brand-700 underline-offset-2 hover:underline"
                          >
                            undo
                          </button>
                        )}
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
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <span>This order was refunded and stock was restored.</span>
              {canRefund && (
                <button
                  type="button"
                  onClick={() => unrefund(selected.order.id)}
                  className="shrink-0 rounded px-1.5 py-0.5 font-medium text-amber-900 underline-offset-2 hover:underline"
                >
                  Undo the refund
                </button>
              )}
            </div>
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

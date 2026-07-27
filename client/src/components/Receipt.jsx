import { CheckCircle2, Printer } from 'lucide-react';
import { Button, Modal, money } from './ui';
import { lbp } from '../context/SettingsContext';

export default function Receipt({ receipt, onClose }) {
  const { order, items } = receipt;
  // Use the rate stored on the order, not the current one — a receipt must
  // still reconcile after the rate moves.
  const rate = order.exchange_rate || 0;
  const totalLbp = rate ? Math.round((order.total * rate) / 1000) * 1000 : 0;
  const gaveLbpChange = order.change_currency === 'LBP' && order.change_lbp > 0;

  return (
    <Modal open onClose={onClose} size="sm" className="print:shadow-none print:ring-0">
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50">
          <CheckCircle2 size={24} className="text-brand-600" />
        </div>
        <h2 className="text-lg font-semibold text-slate-900">Payment complete</h2>
        {order.payment_method === 'cash' && order.change_due > 0 && (
          <p className="mt-2 inline-block rounded-lg bg-amber-50 px-3 py-1.5 text-sm font-semibold text-amber-900">
            Give {gaveLbpChange ? lbp(order.change_lbp) : money(order.change_usd || order.change_due)} change
          </p>
        )}
        <p className="mt-2 text-xs text-slate-400">{order.order_number}</p>
      </div>

      <div className="my-4 space-y-1.5 border-y border-dashed border-slate-200 py-3 text-sm">
        {items.map((item) => (
          <div key={item.id} className="flex justify-between gap-3">
            <span className="min-w-0 text-slate-600">
              <span className="tnum text-slate-400">{item.quantity}×</span> {item.name}
            </span>
            <span className="tnum shrink-0 text-slate-800">{money(item.line_total)}</span>
          </div>
        ))}
      </div>

      <dl className="space-y-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-slate-500">Subtotal</dt>
          <dd className="tnum text-slate-700">{money(order.subtotal)}</dd>
        </div>
        {order.discount > 0 && (
          <div className="flex justify-between">
            <dt className="text-slate-500">Discount</dt>
            <dd className="tnum text-slate-700">−{money(order.discount)}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-slate-500">Tax</dt>
          <dd className="tnum text-slate-700">{money(order.tax)}</dd>
        </div>
        <div className="flex justify-between border-t border-slate-100 pt-1.5 text-base font-semibold">
          <dt className="text-slate-900">Total</dt>
          <dd className="tnum text-slate-900">{money(order.total)}</dd>
        </div>
        {rate > 0 && (
          <div className="flex justify-between text-xs">
            <dt className="text-slate-400">Total in pounds</dt>
            <dd className="tnum text-slate-500">{lbp(totalLbp)}</dd>
          </div>
        )}
        {order.payment_method === 'cash' && (
          <>
            {order.paid_usd > 0 && (
              <div className="flex justify-between">
                <dt className="text-slate-500">Paid in dollars</dt>
                <dd className="tnum text-slate-700">{money(order.paid_usd)}</dd>
              </div>
            )}
            {order.paid_lbp > 0 && (
              <div className="flex justify-between">
                <dt className="text-slate-500">Paid in pounds</dt>
                <dd className="tnum text-slate-700">{lbp(order.paid_lbp)}</dd>
              </div>
            )}
            <div className="flex justify-between font-medium text-brand-700">
              <dt>Change</dt>
              <dd className="tnum">
                {gaveLbpChange ? lbp(order.change_lbp) : money(order.change_usd || order.change_due)}
              </dd>
            </div>
          </>
        )}
        {rate > 0 && (
          <div className="flex justify-between text-xs">
            <dt className="text-slate-400">Rate</dt>
            <dd className="tnum text-slate-400">1 USD = {Number(rate).toLocaleString('en-US')} LL</dd>
          </div>
        )}
        {order.payment_method === 'card' && (
          <div className="flex justify-between">
            <dt className="text-slate-500">Paid by</dt>
            <dd className="text-slate-700">Card</dd>
          </div>
        )}
      </dl>

      <div className="no-print mt-5 flex gap-2">
        <Button variant="secondary" size="lg" onClick={() => window.print()} aria-label="Print receipt">
          <Printer size={16} />
        </Button>
        <Button size="lg" className="flex-1" onClick={onClose} autoFocus>
          New sale
        </Button>
      </div>
    </Modal>
  );
}

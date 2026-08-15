import { useState } from 'react';
import { CheckCircle2, Printer } from 'lucide-react';
import { Button, Modal, ModalActions, cx, money } from './ui';
import { useT } from '../context/LanguageContext';
import Letterhead, { ReceiptFooter } from './Letterhead';
import WhatsAppButton from './WhatsAppButton';
import { lbp } from '../context/SettingsContext';
import { A4, ROLL, usePageSize } from '../lib/pageSize';

/**
 * Which paper this shop puts a receipt on.
 *
 * A phone shop has a till roll at the counter and an office printer in the
 * back, and both get used: the roll for whoever is walking out, A4 for a
 * customer who wants something that looks like a document — a company buying a
 * handset for staff, or anyone who will file it.
 *
 * Remembered on the device, because it is a property of what is plugged into
 * this machine rather than of the shop. The counter tablet is on the roll
 * whatever the back office prefers.
 */
const PAPER_KEY = 'pos_receipt_paper';
const readPaper = () => (globalThis.localStorage?.getItem(PAPER_KEY) === 'a4' ? 'a4' : 'roll');

/**
 * @param reprint  Opened from a history rather than from the sale itself.
 *
 * The paper is the same and so is everything on it — what changes is what the
 * screen around it says. "Payment complete" and "give them their change" are
 * true at the counter and false a week later, and the button that closes it is
 * not starting the next sale.
 */
export default function Receipt({ receipt, onClose, reprint = false }) {
  const t = useT();
  const { order, items } = receipt;
  const [paper, setPaper] = useState(readPaper);

  function choosePaper(next) {
    setPaper(next);
    try {
      globalThis.localStorage?.setItem(PAPER_KEY, next);
    } catch {
      /* A blocked store must not stop anybody printing. */
    }
  }

  /*
   * Claimed rather than emitted. A `<style>` rendered here is one of several
   * `@page` rules in the document and wins or loses by where it landed, which
   * is how a receipt set to A4 came out on the roll. lib/pageSize owns the
   * only one there is.
   */
  usePageSize(paper === 'a4' ? A4 : ROLL);
  // Use the rate stored on the order, not the current one — a receipt must
  // still reconcile after the rate moves.
  const rate = order.exchange_rate || 0;
  const totalLbp = rate ? Math.round((order.total * rate) / 1000) * 1000 : 0;
  /*
   * Read the change back off the two amounts actually recorded rather than off
   * the mode that was chosen. Change can be handed back as dollars, as pounds,
   * or as some of each, and the stored pair says which without a third case to
   * keep in step.
   */
  const changeText =
    order.change_usd > 0 && order.change_lbp > 0
      ? `${money(order.change_usd)} + ${lbp(order.change_lbp)}`
      : order.change_lbp > 0
        ? lbp(order.change_lbp)
        : money(order.change_usd || order.change_due);

  return (
    <Modal open onClose={onClose} size="sm" className="print:shadow-none print:ring-0">
      <div className={cx('print-receipt', paper === 'a4' ? 'mode-a4' : 'mode-roll')}>
      {/* Who the shop is, so the slip is something that can be brought back. */}
      <Letterhead className="mb-3 border-b border-dashed border-slate-200 pb-3" />

      <div className="text-center">
        {!reprint && (
          <div className="no-print mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50">
            <CheckCircle2 size={24} className="text-brand-600" />
          </div>
        )}
        <h2 className="text-lg font-semibold text-slate-900">
          {reprint ? t('Receipt') : t('Payment complete')}
        </h2>
        {!reprint && order.payment_method === 'cash' && order.change_due > 0 && (
          <p className="mt-2 inline-block rounded-lg bg-amber-50 px-3 py-1.5 text-sm font-semibold text-amber-900">
            Give {changeText} change
          </p>
        )}
        <p className="mt-2 text-xs text-slate-400">{order.order_number}</p>
        {/* A reprint is dated, so nobody mistakes it for today's sale. */}
        {reprint && <p className="text-xs text-slate-400">{order.created_at}</p>}
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
        {/*
          * Shown only when there was tax on it — not "shown as zero".
          *
          * Keyed off what this sale actually carried rather than off today's
          * setting, so a receipt reprinted next year still shows what the
          * customer was charged, and a shop that has never charged tax never
          * has to explain a nought to anybody.
          */}
        {order.tax > 0 && (
          <div className="flex justify-between">
            <dt className="text-slate-500">Tax</dt>
            <dd className="tnum text-slate-700">{money(order.tax)}</dd>
          </div>
        )}
        <div className="flex justify-between border-t border-slate-100 pt-1.5 text-base font-semibold">
          <dt className="text-slate-900">Total</dt>
          <dd className="tnum text-slate-900">{money(order.total)}</dd>
        </div>
        {rate > 0 && (
          <div className="flex justify-between text-xs">
            <dt className="text-slate-400">Total in LBP</dt>
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
                <dt className="text-slate-500">Paid in LBP</dt>
                <dd className="tnum text-slate-700">{lbp(order.paid_lbp)}</dd>
              </div>
            )}
            <div className="flex justify-between font-medium text-brand-700">
              <dt>Change</dt>
              <dd className="tnum">
                {changeText}
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

        {/*
          * What this customer owes, in their hand.
          *
          * The moment to tell somebody their account stands at three hundred
          * dollars is while they are holding the receipt for it — a shop that
          * waits until next month is a shop having an argument about it. Shown
          * for anybody with a balance either way: owing it, or in credit.
          *
          * Only when there is a customer at all. Most sales are to whoever
          * walked in, and a line reading "Balance $0.00" on every receipt is
          * noise on a roll that costs money to print.
          */}
        {order.customer_name && Number(order.customer_balance) !== 0 && (
          <div className="mt-1 flex justify-between border-t border-dashed border-slate-200 pt-1 font-medium">
            <dt className="text-slate-700">
              {Number(order.customer_balance) > 0 ? 'Account balance' : 'In credit'}
            </dt>
            <dd className="tnum text-slate-900">
              {money(Math.abs(Number(order.customer_balance)))}
              {rate > 0 && (
                <span className="ml-1 text-xs font-normal text-slate-500">
                  {lbp(Math.round(Math.abs(Number(order.customer_balance)) * rate))}
                </span>
              )}
            </dd>
          </div>
        )}
      </dl>

      <ReceiptFooter className="mt-4 border-t border-dashed border-slate-200 pt-3" />
      </div>

      {/* Chosen before printing, not in a settings screen two rooms away. */}
      <div className="no-print mt-4 flex items-center gap-2 border-t border-slate-100 pt-3">
        <span className="text-xs text-slate-500">{t('Paper')}</span>
        {[
          ['roll', t('80mm roll')],
          ['a4', t('A4 sheet')],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => choosePaper(id)}
            aria-pressed={paper === id}
            className={cx(
              'rounded-lg px-2.5 py-1 text-xs font-medium ring-1 transition',
              paper === id
                ? 'bg-brand-600 text-white ring-brand-600'
                : 'bg-white text-slate-600 ring-slate-300 hover:bg-slate-50',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <ModalActions className="no-print">
        <Button variant="secondary" size="lg" onClick={() => window.print()} aria-label="Print receipt">
          <Printer size={16} />
        </Button>
        {/*
          * Sending it beats printing it for most of what a receipt is for: a
          * customer who has it on their phone still has it in a month, and the
          * shop does not go through a roll of paper.
          */}
        <WhatsAppButton path={`/orders/${order.id}/whatsapp`} label="WhatsApp" size="lg" />
        <Button size="lg" className="flex-1" onClick={onClose} autoFocus>
          {reprint ? t('Done') : t('New sale')}
        </Button>
      </ModalActions>
    </Modal>
  );
}

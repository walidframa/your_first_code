import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Banknote, CreditCard, Delete } from 'lucide-react';
import { Button, Modal, cx, money } from './ui';

const QUICK_CASH = [5, 10, 20, 50, 100];

/**
 * Payment step: pick a tender, and for cash enter the amount with a keypad.
 * Split out from the cart so the register stays a single-glance screen.
 */
export default function PaymentSheet({ open, total, onClose, onConfirm, submitting }) {
  const [method, setMethod] = useState(null);
  const [entry, setEntry] = useState('');

  useEffect(() => {
    if (open) {
      setMethod(null);
      setEntry('');
    }
  }, [open]);

  const tendered = Number(entry || 0);
  const change = tendered - total;
  const canConfirmCash = tendered >= total && total > 0;

  const suggestions = useMemo(() => {
    const rounded = Math.ceil(total);
    const set = new Set([Number(total.toFixed(2)), rounded]);
    for (const q of QUICK_CASH) if (q >= total) set.add(q);
    return [...set].sort((a, b) => a - b).slice(0, 4);
  }, [total]);

  function press(key) {
    setEntry((prev) => {
      if (key === 'clear') return '';
      if (key === 'back') return prev.slice(0, -1);
      if (key === '.') return prev.includes('.') ? prev : (prev || '0') + '.';
      // Cap at two decimal places.
      if (prev.includes('.') && prev.split('.')[1].length >= 2) return prev;
      return prev === '0' ? key : prev + key;
    });
  }

  return (
    <Modal
      open={open}
      onClose={submitting ? undefined : onClose}
      title={method === null ? 'Take payment' : method === 'cash' ? 'Cash payment' : 'Card payment'}
      subtitle={`Amount due ${money(total)}`}
      size={method === 'cash' ? 'md' : 'sm'}
    >
      {method === null && (
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setMethod('card')}
            className="flex flex-col items-center gap-2 rounded-xl bg-white px-4 py-8 ring-1 ring-slate-300 transition hover:bg-slate-50 hover:ring-brand-400"
          >
            <CreditCard size={26} className="text-slate-700" />
            <span className="font-medium text-slate-800">Card</span>
          </button>
          <button
            onClick={() => setMethod('cash')}
            className="flex flex-col items-center gap-2 rounded-xl bg-white px-4 py-8 ring-1 ring-slate-300 transition hover:bg-slate-50 hover:ring-brand-400"
          >
            <Banknote size={26} className="text-slate-700" />
            <span className="font-medium text-slate-800">Cash</span>
          </button>
        </div>
      )}

      {method === 'card' && (
        <div className="space-y-4">
          <div className="rounded-xl bg-slate-50 px-4 py-6 text-center">
            <p className="text-sm text-slate-500">Charge to card</p>
            <p className="mt-1 text-3xl font-semibold text-slate-900">{money(total)}</p>
          </div>
          <p className="text-center text-xs text-slate-500">
            This records the sale. No card is actually charged — connect a payment provider to take real
            payments.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" size="lg" onClick={() => setMethod(null)} disabled={submitting}>
              <ArrowLeft size={16} /> Back
            </Button>
            <Button
              size="lg"
              className="flex-1"
              loading={submitting}
              onClick={() => onConfirm({ paymentMethod: 'card' })}
            >
              Confirm {money(total)}
            </Button>
          </div>
        </div>
      )}

      {method === 'cash' && (
        <div className="space-y-4">
          <div className="rounded-xl bg-slate-50 px-4 py-4 text-center">
            <p className="text-xs tracking-wide text-slate-500 uppercase">Cash received</p>
            <p className="mt-1 text-3xl font-semibold text-slate-900">
              {entry ? money(tendered) : <span className="text-slate-300">$0.00</span>}
            </p>
            {entry !== '' && (
              <p
                className={cx(
                  'mt-1 text-sm font-medium',
                  change >= 0 ? 'text-brand-700' : 'text-red-600',
                )}
              >
                {change >= 0 ? `Change due ${money(change)}` : `${money(-change)} short`}
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {suggestions.map((amount) => (
              <button
                key={amount}
                onClick={() => setEntry(String(amount))}
                className="flex-1 rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-200"
              >
                {amount === Number(total.toFixed(2)) ? 'Exact' : money(amount)}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'].map((key) => (
              <button
                key={key}
                onClick={() => press(key)}
                aria-label={key === 'back' ? 'Backspace' : key}
                className="flex h-14 items-center justify-center rounded-xl bg-white text-lg font-medium text-slate-800 ring-1 ring-slate-200 transition hover:bg-slate-50 active:bg-slate-100"
              >
                {key === 'back' ? <Delete size={18} /> : key}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" size="lg" onClick={() => setMethod(null)} disabled={submitting}>
              <ArrowLeft size={16} /> Back
            </Button>
            <Button
              size="lg"
              className="flex-1"
              disabled={!canConfirmCash}
              loading={submitting}
              onClick={() => onConfirm({ paymentMethod: 'cash', amountTendered: tendered })}
            >
              {canConfirmCash ? `Confirm · change ${money(change)}` : 'Enter cash received'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

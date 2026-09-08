import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import api from '../api';
import { Button, Input, Modal, ModalActions, cx, money, useToast } from './ui';
import { useSettings } from '../context/SettingsContext';

/**
 * How many of this line are coming back.
 *
 * Asked rather than assumed, because a customer returning two of five is the
 * ordinary case and a dialog that silently took all five would be handing over
 * money nobody asked for. What goes back is worked out on the server — it is
 * the line's share of what was actually paid, after the discount and with the
 * tax, which is not a figure to let the browser assert.
 */
export default function ReturnLine({ order, item, onClose, onDone }) {
  const toast = useToast();
  const left = item.quantity - (item.returned_qty || 0);
  const [quantity, setQuantity] = useState(String(left));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { rate } = useSettings();
  /*
   * Which notes go back across the counter.
   *
   * Defaults to pounds only when the customer paid in pounds and nothing
   * else; a dollar sale refunded in dollars is what the drawer expects. The
   * server used to work this out from the tender and got "−$50 and
   * +3,150,000 LL" for a fifteen-dollar refund — see refundLegs there.
   */
  const netUsd = (order.paid_usd || 0) - (order.change_usd || 0);
  const netLbp = (order.paid_lbp || 0) - (order.change_lbp || 0);
  const [currency, setCurrency] = useState(netLbp > 0 && netUsd <= 0 ? 'LBP' : 'USD');
  const cash = order.payment_method === 'cash' && rate > 0;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/orders/${order.id}/return-line`, {
        itemId: item.id,
        quantity: Number(quantity),
        ...(cash ? { currency } : {}),
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

      {cash && (
        <div className="mt-3">
          <p className="mb-1.5 text-sm font-medium text-slate-700">Hand back in</p>
          <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm font-medium">
            {[
              ['USD', 'Dollars'],
              ['LBP', 'Pounds'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setCurrency(key)}
                aria-pressed={currency === key}
                className={cx(
                  'flex-1 rounded-md px-3 py-1.5 transition',
                  currency === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

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

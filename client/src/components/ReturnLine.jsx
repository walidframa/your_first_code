import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import api from '../api';
import { Button, Input, Modal, ModalActions, money, useToast } from './ui';

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

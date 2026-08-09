import { useState } from 'react';
import { Plus } from 'lucide-react';
import api from '../api';
import { Button, Input, Modal, Select, useToast } from './ui';

export const EXPENSE_CATEGORIES = [
  ['rent', 'Rent'],
  ['utilities', 'Utilities'],
  ['wages', 'Wages'],
  ['supplies', 'Supplies'],
  ['transport', 'Transport'],
  ['maintenance', 'Maintenance'],
  ['marketing', 'Marketing'],
  ['fees', 'Fees'],
  ['tax', 'Tax'],
  ['other', 'Other'],
];

export const PAID_WITH = [
  ['cash', 'Cash — from the till'],
  ['bank', 'Bank'],
  ['card', 'Card'],
  ['other', 'Other'],
];

/**
 * Money spent running the shop.
 *
 * Shared between the back office and the transfer counter, because the counter
 * is where most of it is actually spent: the operator pays for the water, the
 * generator subscription, a delivery — out of the same drawer they are trusted
 * to have counted right at closing. Recorded here it comes off the till like
 * anything else; recorded nowhere it becomes a shortfall somebody is blamed for.
 */
export default function AddExpense({ onClose, onSaved }) {
  const toast = useToast();
  const [category, setCategory] = useState('supplies');
  const [usd, setUsd] = useState('');
  const [lbpAmount, setLbpAmount] = useState('');
  const [paidWith, setPaidWith] = useState('cash');
  const [spentOn, setSpentOn] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/expenses', {
        spentOn,
        category,
        amountUsd: Number(usd) || 0,
        amountLbp: Number(lbpAmount) || 0,
        paidWith,
        note: note || null,
      });
      toast('Expense recorded');
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not record that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Add an expense" subtitle="Money spent running the shop">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="What for"
            name="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {EXPENSE_CATEGORIES.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
          <Input
            label="Date"
            name="spentOn"
            type="date"
            value={spentOn}
            onChange={(e) => setSpentOn(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Dollars"
            name="amountUsd"
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={usd}
            onChange={(e) => setUsd(e.target.value)}
          />
          <Input
            label="Lebanese pounds (LBP)"
            name="amountLbp"
            type="number"
            min="0"
            step="1000"
            placeholder="0"
            value={lbpAmount}
            onChange={(e) => setLbpAmount(e.target.value)}
          />
        </div>

        <Select
          label="Paid with"
          name="paidWith"
          value={paidWith}
          onChange={(e) => setPaidWith(e.target.value)}
        >
          {PAID_WITH.map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </Select>
        {paidWith === 'cash' && (
          <p className="text-xs text-slate-500">
            This comes out of the open cashbox, so the drawer still counts right at close.
          </p>
        )}

        <Input
          label="Note"
          name="note"
          placeholder="e.g. July rent"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            className="flex-1"
            loading={busy}
            disabled={!Number(usd) && !Number(lbpAmount)}
          >
            <Plus size={16} /> Record it
          </Button>
        </div>
      </form>
    </Modal>
  );
}

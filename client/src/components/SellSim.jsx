import { useState } from 'react';
import { Search, Smartphone } from 'lucide-react';
import api from '../api';
import IdPhotoField from './IdPhotoField';
import { Button, Input, Modal, ModalActions, money, useToast } from './ui';

/**
 * Sell a SIM at the counter.
 *
 * A SIM is found by the number on it, not by browsing a catalogue: the card is
 * in the cashier's hand and the number is printed on it, so that is what gets
 * typed. Any spelling finds it — 03 123 456, 03/123456, +961 3 123 456 — because
 * the number is normalised on both sides.
 *
 * The line is registered to a person, so the buyer's ID is photographed here
 * and travels with the cart line. It only reaches the server once the sale is
 * actually paid for: a customer who changes their mind should not leave a
 * photograph of their ID behind.
 */
export default function SellSim({ onClose, onPicked }) {
  const toast = useToast();
  const [number, setNumber] = useState('');
  const [sim, setSim] = useState(null);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState('');

  const [buyer, setBuyer] = useState({ name: '', phone: '' });
  const [idPhoto, setIdPhoto] = useState(null);
  const [price, setPrice] = useState('');

  async function find(e) {
    e.preventDefault();
    if (!number.trim()) return;

    setLooking(true);
    setError('');
    try {
      const res = await api.get(`/sims/by-number/${encodeURIComponent(number.trim())}`);
      const found = res.data.sim;
      if (found.status !== 'in_stock') {
        setError(`That SIM is already ${found.status.replace('_', ' ')}`);
        setSim(null);
        return;
      }
      setSim(found);
      setPrice(String(found.price ?? ''));
    } catch (err) {
      setSim(null);
      setError(err.response?.data?.error || 'Could not look that up');
    } finally {
      setLooking(false);
    }
  }

  function put() {
    onPicked({
      sim,
      price: price === '' ? sim.price : Number(price),
      buyer,
      idPhoto,
    });
    toast(`${sim.product_name} added`);
    onClose();
  }

  return (
    <Modal open onClose={onClose} title="Sell a SIM" subtitle="Find it by the number on the card">
      <form onSubmit={find} className="flex items-end gap-2">
        <Input
          label="Phone number"
          name="simNumber"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="e.g. 03 123 456"
          autoFocus
          className="flex-1"
        />
        <Button type="submit" loading={looking} disabled={!number.trim()}>
          <Search size={16} /> Find
        </Button>
      </form>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {sim && (
        <div className="mt-4 space-y-4">
          <div className="flex items-center gap-2 rounded-xl bg-brand-50 px-3 py-2.5 ring-1 ring-brand-200">
            <Smartphone size={16} className="shrink-0 text-brand-700" />
            <span className="flex-1 font-medium text-brand-900">{sim.product_name}</span>
            <span className="tnum text-sm text-brand-700">{money(sim.price)}</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Buyer's name"
              name="simBuyerName"
              value={buyer.name}
              onChange={(e) => setBuyer((b) => ({ ...b, name: e.target.value }))}
            />
            <Input
              label="Buyer's phone"
              name="simBuyerPhone"
              value={buyer.phone}
              onChange={(e) => setBuyer((b) => ({ ...b, phone: e.target.value }))}
              hint="Another number to reach them on"
            />
          </div>

          <Input
            label="Price"
            name="simPrice"
            type="number"
            min="0"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            hint="What was agreed at the counter"
          />

          {/*
            * A line belongs to a person, and the shop is the one that registered
            * it. Same field and same rules as buying a handset in.
            */}
          <IdPhotoField value={idPhoto} onChange={setIdPhoto} />
        </div>
      )}

      <ModalActions>
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button className="flex-1" disabled={!sim} onClick={put}>
          Add to the sale
        </Button>
      </ModalActions>
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import api from '../api';
import BarcodeField from './BarcodeField';
import { Button, Input, Modal, ModalActions, Select, useToast } from './ui';

/**
 * Create a product without leaving the document you are building.
 *
 * Deliberately shorter than the full product form: stock is left at zero
 * because a purchase invoice is usually what brings the first units in, and a
 * sales document should not be inventing stock.
 */
export default function ProductQuickCreate({
  open,
  initialName = '',
  /*
   * A model created while buying a used phone in *has* to be serialised, or the
   * handset that prompted it cannot be booked against it. There the answer is
   * already known, so the caller both sets it and locks it.
   *
   * Everywhere else it is only a starting position. This dialog is how a phone
   * shop adds a phone in the middle of writing a purchase invoice, and until
   * now it could not: there was no box here at all, so every handset created
   * this way came out as ordinary counted stock with no IMEI behind it, and the
   * only remedy was to go to the catalogue afterwards and do it again.
   */
  trackUnits = false,
  lockTrackUnits = false,
  onClose,
  onCreated,
}) {
  const toast = useToast();
  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState({
    name: '',
    sku: '',
    barcodes: [],
    price: '',
    cost: '',
    category_id: '',
    reorder_point: 5,
    tracks_units: trackUnits,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setForm((f) => ({ ...f, name: initialName, tracks_units: trackUnits }));
    setError('');
    api.get('/products/categories').then((res) => setCategories(res.data.categories));
  }, [open, initialName, trackUnits]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  /** Suggest a SKU from the name so the field is rarely typed by hand. */
  function suggestSku() {
    if (form.sku || !form.name.trim()) return;
    const slug = form.name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 12);
    setForm((f) => ({ ...f, sku: `${slug}-${Math.floor(Math.random() * 900 + 100)}` }));
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.post('/products', {
        ...form,
        price: Number(form.price) || 0,
        cost: Number(form.cost) || 0,
        stock: 0,
        reorder_point: Number(form.reorder_point) || 0,
        category_id: form.category_id || null,
        tracks_units: form.tracks_units,
      });
      toast(`${res.data.product.name} created`);
      onCreated(res.data.product);
      setForm({
        name: '', sku: '', barcodes: [], price: '', cost: '',
        category_id: '', reorder_point: 5, tracks_units: trackUnits,
      });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create the product');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <Modal open onClose={onClose} title="New product" subtitle="It will be added to this document" size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Name" name="name"
            value={form.name}
            onChange={set('name')}
            onBlur={suggestSku}
            required
            autoFocus
            className="col-span-2"
          />
          <Input label="SKU" name="sku" value={form.sku} onChange={set('sku')} required hint="Filled in from the name" />
          <div className="col-span-2">
            <BarcodeField
              value={form.barcodes}
              onChange={(barcodes) => setForm((f) => ({ ...f, barcodes }))}
            />
          </div>
          <Input label="Sell price (USD)" name="price" type="number" min="0" step="0.01" value={form.price} onChange={set('price')} required />
          <Input label="Cost (USD)" name="cost" type="number" min="0" step="0.01" value={form.cost} onChange={set('cost')} />
          <Select label="Category" name="category_id" value={form.category_id} onChange={set('category_id')}>
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Input label="Reorder point" name="reorder_point" type="number" min="0" step="1" value={form.reorder_point} onChange={set('reorder_point')} />

          {/*
            * Asked here for the same reason the full form asks it: a phone shop
            * adds phones, and this is the dialog it adds them from while the
            * delivery is being booked in. Locked when the caller already knows
            * — buying a used handset in, where anything else would be wrong.
            */}
          <label className="col-span-2 flex items-start gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
            <input
              type="checkbox"
              name="tracks_units"
              checked={form.tracks_units}
              disabled={lockTrackUnits}
              onChange={(e) => setForm((f) => ({ ...f, tracks_units: e.target.checked }))}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand-600 disabled:opacity-60"
            />
            <span>
              <span className="block text-sm font-medium text-slate-800">Track each one by IMEI</span>
              <span className="block text-xs text-slate-500">
                {lockTrackUnits
                  ? 'A handset booked in by IMEI has to be tracked this way.'
                  : 'For phones and anything with a serial. Stock is then the handsets booked in, and each carries its own cost.'}
              </span>
            </span>
          </label>
        </div>

        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          {form.tracks_units
            ? 'Stock starts at zero. Booking handsets in by IMEI is what brings units in.'
            : 'Stock starts at zero. Confirming a purchase invoice is what brings units in.'}
        </p>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            Create and add
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

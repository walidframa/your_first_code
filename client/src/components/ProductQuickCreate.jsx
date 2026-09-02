import { useEffect, useState } from 'react';
import api from '../api';
import BarcodeField from './BarcodeField';
import { Button, Input, Modal, ModalActions, Select, useToast } from './ui';

/** Sentinel option value: picking it asks for a name rather than choosing one. */
const NEW_CATEGORY = '__new__';

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
   * The number off the box, when that is what was scanned.
   *
   * A scan that matches nothing is how most products get created in a phone
   * shop — the delivery is on the counter and the reader is in hand. That code
   * used to arrive as the product's *name*, so the shop typed the real name
   * over it and the barcode, the one thing already known for certain, was
   * never saved: the same box scanned tomorrow missed again.
   */
  initialBarcode = '',
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
  /*
   * Naming a new shelf without leaving the delivery being typed in.
   *
   * `null` is "not asking"; a string is the name being typed, empty included —
   * which is why it is not simply falsy-checked.
   *
   * The full product form has had this for a while. This one did not, and it is
   * the dialog a shop actually meets it in: the first delivery of a thing never
   * stocked before brings the product and the shelf it belongs on at the same
   * moment, and the only way out was to abandon the half-typed line, go to the
   * catalogue, make the category, and start the purchase invoice again.
   */
  const [namingCategory, setNamingCategory] = useState(null);
  const [addingCategory, setAddingCategory] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm((f) => ({
      ...f,
      name: initialName,
      barcodes: initialBarcode ? [initialBarcode] : [],
      tracks_units: trackUnits,
    }));
    setError('');
    setNamingCategory(null);
    api.get('/products/categories').then((res) => setCategories(res.data.categories));
  }, [open, initialName, initialBarcode, trackUnits]);

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

  async function addCategory() {
    const name = namingCategory.trim();
    if (!name) return;
    setAddingCategory(true);
    try {
      const { data } = await api.post('/products/categories', { name });
      // Into the list and onto the product, because that is what it was made for.
      setCategories((list) => [...list, data.category].sort((a, b) => a.name.localeCompare(b.name)));
      setForm((f) => ({ ...f, category_id: String(data.category.id) }));
      setNamingCategory(null);
      toast(`${data.category.name} added`);
    } catch (err) {
      /*
       * The commonest answer by far is that it already exists — said as a toast
       * rather than as a red banner over the whole dialog, because it is about
       * this one box and the fix is to pick the existing one.
       */
      toast(err.response?.data?.error || 'Could not add that category', 'error');
    } finally {
      setAddingCategory(false);
    }
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
            /* Said, because the barcode below is already filled in and a shop
               that scanned its way here needs to know what is left to do. */
            hint={initialBarcode ? `Scanned ${initialBarcode} — this is all that is missing` : undefined}
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
          <div>
            <Select
              label="Category"
              name="category_id"
              value={form.category_id}
              onChange={(e) => {
                if (e.target.value === NEW_CATEGORY) {
                  setNamingCategory('');
                  return;
                }
                const picked = categories.find((c) => String(c.id) === e.target.value);
                /*
                 * A phone filed on the phone shelf is tracked by IMEI, without
                 * being asked again. The shelf was marked once; this is what
                 * makes that mark show up where the decision is being made.
                 * Still a tick box — the odd non-phone on that shelf is the
                 * shop's business, and it can untick it.
                 */
                setForm((f) => ({
                  ...f,
                  category_id: e.target.value,
                  tracks_units: lockTrackUnits ? f.tracks_units : Boolean(picked?.tracks_units),
                }));
              }}
            >
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value={NEW_CATEGORY}>+ New category…</option>
            </Select>

            {namingCategory !== null && (
              <div className="mt-2 flex items-end gap-2">
                <Input
                  label="New category"
                  value={namingCategory}
                  onChange={(e) => setNamingCategory(e.target.value)}
                  autoFocus
                  placeholder="Chargers"
                  /* Enter makes the category, and must never submit the
                     half-filled product behind it. */
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCategory();
                    }
                    if (e.key === 'Escape') setNamingCategory(null);
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  className="mb-0.5"
                  loading={addingCategory}
                  disabled={!namingCategory.trim()}
                  onClick={addCategory}
                >
                  Add
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="mb-0.5"
                  onClick={() => setNamingCategory(null)}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
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

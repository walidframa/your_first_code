import { useEffect, useState } from 'react';
import api from '../api';
import { Button, Input, Modal, Select, useToast } from './ui';

/**
 * Create a product without leaving the document you are building.
 *
 * Deliberately shorter than the full product form: stock is left at zero
 * because a purchase invoice is usually what brings the first units in, and a
 * sales document should not be inventing stock.
 */
export default function ProductQuickCreate({ open, initialName = '', onClose, onCreated }) {
  const toast = useToast();
  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState({
    name: '',
    sku: '',
    barcode: '',
    price: '',
    cost: '',
    category_id: '',
    reorder_point: 5,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setForm((f) => ({ ...f, name: initialName }));
    setError('');
    api.get('/products/categories').then((res) => setCategories(res.data.categories));
  }, [open, initialName]);

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
      });
      toast(`${res.data.product.name} created`);
      onCreated(res.data.product);
      setForm({ name: '', sku: '', barcode: '', price: '', cost: '', category_id: '', reorder_point: 5 });
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
          <Input label="Barcode" name="barcode" value={form.barcode} onChange={set('barcode')} />
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
        </div>

        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Stock starts at zero. Confirming a purchase invoice is what brings units in.
        </p>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            Create and add
          </Button>
        </div>
      </form>
    </Modal>
  );
}

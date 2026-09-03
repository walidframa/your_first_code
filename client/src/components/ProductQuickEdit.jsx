import { useEffect, useState } from 'react';
import api from '../api';
import BarcodeField from './BarcodeField';
import { Button, Input, Modal, ModalActions, useToast } from './ui';

/**
 * Correct a product without leaving the document being typed.
 *
 * The moment a wrong barcode or a wrong price is discovered is the moment the
 * thing is being booked in or invoiced — the box is in one hand and the
 * supplier's paper in the other. Until now that meant abandoning the document,
 * going to the catalogue, finding the product, fixing it and starting again;
 * which is enough work that the shop does not do it, and the wrong number
 * stays wrong until the next time it wastes somebody's minute.
 *
 * Deliberately four fields. This is a correction, not the catalogue form: the
 * things that are wrong at a counter are the name, the number on the box, what
 * it sells for and what it cost. Everything else about a product is a
 * decision, and decisions belong on the screen built for them.
 */
export default function ProductQuickEdit({ product, priceField = 'price', onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', sku: '', barcodes: [], price: '', cost: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!product) return;
    setForm({
      name: product.name ?? '',
      sku: product.sku ?? '',
      /* Every code it answers to. A product can have several — the maker's, the
         distributor's sticker, the shop's own — see BarcodeField. */
      barcodes: product.barcodes ?? (product.barcode ? [product.barcode] : []),
      price: product.price ?? '',
      cost: product.cost ?? '',
    });
    setError('');
  }, [product]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.put(`/products/${product.id}`, {
        name: form.name.trim(),
        sku: form.sku.trim(),
        barcodes: form.barcodes,
        price: Number(form.price) || 0,
        cost: Number(form.cost) || 0,
      });
      toast(`${res.data.product.name} updated`);
      onSaved(res.data.product);
    } catch (err) {
      /*
       * The commonest refusal by far is a barcode another product already
       * answers to, and it names that product — so it is shown here rather
       * than as a toast that goes away while somebody is still reading it.
       */
      setError(err.response?.data?.error || 'Could not save that');
    } finally {
      setSaving(false);
    }
  }

  if (!product) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${product.name}`}
      subtitle="This changes the product in the catalogue, not only on this document"
      size="lg"
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Name"
            name="name"
            value={form.name}
            onChange={set('name')}
            required
            autoFocus
            className="col-span-2"
          />
          <Input
            label="SKU"
            name="sku"
            value={form.sku}
            onChange={set('sku')}
            required
            className="col-span-2"
          />
          <div className="col-span-2">
            <BarcodeField
              value={form.barcodes}
              onChange={(barcodes) => setForm((f) => ({ ...f, barcodes }))}
              hint="Scan the box to correct it — the first is the one printed on labels."
            />
          </div>
          <Input
            label="Sell price (USD)"
            name="price"
            type="number"
            min="0"
            step="0.01"
            value={form.price}
            onChange={set('price')}
            required
          />
          <Input
            label="Cost (USD)"
            name="cost"
            type="number"
            min="0"
            step="0.01"
            value={form.cost}
            onChange={set('cost')}
            hint={
              priceField === 'cost'
                ? 'What the shop pays. This document prices its lines from it.'
                : undefined
            }
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving} disabled={!form.name.trim()}>
            Save the product
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

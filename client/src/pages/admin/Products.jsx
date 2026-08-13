import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  Archive,
  ArchiveRestore,
  History,
  Package,
  Pencil,
  Plus,
  Search,
  Smartphone,
  Tags,
  Upload,
} from 'lucide-react';
import api from '../../api';
import BarcodeField from '../../components/BarcodeField';
import MoneyInput from '../../components/MoneyInput';
import PageHeader from '../../components/PageHeader';
import ItemActivity from '../../components/ItemActivity';
import CategoryManager from '../../components/CategoryManager';
import ProductImageField from '../../components/ProductImageField';
import UnitsPanel from '../../components/UnitsPanel';
import { useSettings, lbp } from '../../context/SettingsContext';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  ModalActions,
  ProductThumb,
  Select,
  Skeleton,
  StockBadge,
  cx,
  money,
  useToast,
} from '../../components/ui';

const emptyForm = {
  name: '',
  sku: '',
  barcodes: [],
  price: '',
  cost: '',
  stock: '',
  reorder_point: '5',
  category_id: '',
  supplier: '',
  image_url: '',
  tracks_units: false,
  is_sim: false,
};

function ProductModal({ product, categories, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(
    product
      ? {
          name: product.name,
          sku: product.sku,
          barcodes: product.barcodes || (product.barcode ? [product.barcode] : []),
          price: product.price,
          cost: product.cost,
          stock: product.stock,
          reorder_point: product.reorder_point ?? 5,
          category_id: product.category_id || '',
          supplier: product.supplier || '',
          image_url: product.image_url || '',
          tracks_units: Boolean(product.tracks_units),
          is_sim: Boolean(product.is_sim),
        }
      : emptyForm,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmConvert, setConfirmConvert] = useState(null);

  async function convertAndSave() {
    setConfirmConvert(null);
    setSaving(true);
    try {
      await api.put(`/products/${product.id}`, {
        ...form,
        price: Number(form.price),
        cost: Number(form.cost) || 0,
        reorder_point: Number(form.reorder_point) || 0,
        category_id: form.category_id || null,
        tracks_units: true,
        convertStock: true,
      });
      toast('Now tracked by IMEI — book the handsets in next');
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    const payload = {
      ...form,
      price: Number(form.price),
      cost: Number(form.cost) || 0,
      stock: Number(form.stock) || 0,
      reorder_point: Number(form.reorder_point) || 0,
      category_id: form.category_id || null,
      tracks_units: form.tracks_units,
      // A product that is not serialised cannot be a SIM.
      is_sim: form.tracks_units && form.is_sim,
    };
    try {
      if (product) await api.put(`/products/${product.id}`, payload);
      else await api.post('/products', payload);
      toast(product ? 'Product updated' : 'Product created');
      onSaved();
    } catch (err) {
      /*
       * Switching an existing product to IMEI tracking clears its stock count,
       * because a quantity has no handsets behind it. The server refuses until
       * that is confirmed rather than destroying a count on a click.
       */
      if (err.response?.data?.needsConvert) {
        setConfirmConvert(err.response.data);
      } else {
        setError(err.response?.data?.error || 'Save failed');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={product ? 'Edit product' : 'New product'} size="lg">
      {confirmConvert && (
        <div className="mb-3 rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
          <p className="text-sm font-medium text-amber-900">
            {confirmConvert.stock} in stock — that count will be cleared
          </p>
          <p className="mt-1 text-sm text-amber-800">
            A quantity has no handsets behind it. Clear it, then book the phones in by their IMEIs so
            the stock is the actual devices on the shelf.
          </p>
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirmConvert(null)}>
              Keep it as a quantity
            </Button>
            <Button size="sm" onClick={convertAndSave} loading={saving}>
              Clear it and track by IMEI
            </Button>
          </div>
        </div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Name" value={form.name} onChange={set('name')} required autoFocus className="col-span-2" />
          <Input label="SKU" value={form.sku} onChange={set('sku')} required />
          <div className="col-span-2">
            <BarcodeField
              value={form.barcodes}
              onChange={(barcodes) => setForm((f) => ({ ...f, barcodes }))}
            />
          </div>
          {/* Either currency: a supplier quotes in pounds as often as in
              dollars, and the division belongs here rather than in somebody's
              head at the counter. Dollars are still what gets stored. */}
          <MoneyInput
            label="Price"
            name="price"
            value={form.price}
            onChange={(v) => setForm((f) => ({ ...f, price: v }))}
          />
          <MoneyInput
            label="Cost"
            name="cost"
            value={form.cost}
            onChange={(v) => setForm((f) => ({ ...f, cost: v }))}
          />
          <Input
            label="Stock on hand"
            type="number"
            step="1"
            value={form.tracks_units ? '' : form.stock}
            onChange={set('stock')}
            disabled={form.tracks_units}
            hint={form.tracks_units ? 'Counted from the handsets booked in' : undefined}
          />
          <Input
            label="Reorder point"
            type="number"
            step="1"
            min="0"
            value={form.reorder_point}
            onChange={set('reorder_point')}
            hint="Flag as low at or below this"
          />
          <Select label="Category" value={form.category_id} onChange={set('category_id')}>
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          {/*
            * Phones are sold one identified handset at a time; screen
            * protectors are not. The choice is per product so both live in one
            * catalogue.
            */}
          <label className="col-span-2 flex items-start gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
            <input
              type="checkbox"
              checked={form.tracks_units}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  tracks_units: e.target.checked,
                  // A SIM that is not counted one at a time is not a SIM.
                  is_sim: e.target.checked ? f.is_sim : false,
                }))
              }
              className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand-600"
            />
            <span>
              <span className="block text-sm font-medium text-slate-800">Track each one by IMEI</span>
              <span className="block text-xs text-slate-500">
                For phones and anything with a serial. Stock is then the handsets booked in, and each
                carries its own cost.
              </span>
            </span>
          </label>

          {/*
            * Always offered, and it turns IMEI tracking on by itself.
            *
            * A SIM is a serialised thing by definition — there is no such thing
            * as "four SIMs" without saying which four numbers — so this used to
            * appear only once the box above was ticked. That made it invisible
            * to anybody who did not already know that a SIM is a kind of
            * serialised product, which is everybody: the SIM screen says "tick
            * Sold as a SIM" and there was no such tick to be found.
            */}
          <label className="col-span-2 flex items-start gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
            <input
              type="checkbox"
              checked={form.is_sim}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  is_sim: e.target.checked,
                  // Ticking this makes it serialised, because it is.
                  tracks_units: e.target.checked ? true : f.tracks_units,
                }))
              }
              className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand-600"
            />
            <span>
              <span className="block text-sm font-medium text-slate-800">Sold as a SIM</span>
              <span className="block text-xs text-slate-500">
                Booked in and sold by the phone number on the card, from the SIM cards screen and the
                register. Ticking this counts them one by one, the same as IMEI.
              </span>
            </span>
          </label>

          <Input label="Supplier" value={form.supplier} onChange={set('supplier')} />
          <ProductImageField
            value={form.image_url}
            onChange={(v) => setForm((f) => ({ ...f, image_url: v }))}
            className="col-span-2"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            {product ? 'Save changes' : 'Create product'}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

export default function Products() {
  const toast = useToast();
  const { rate, toLbp } = useSettings();
  const [products, setProducts] = useState(null);
  const [categories, setCategories] = useState([]);
  const [managingCategories, setManagingCategories] = useState(false);
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(undefined);
  const [activityFor, setActivityFor] = useState(null);
  const [unitsFor, setUnitsFor] = useState(null);

  const load = useCallback(async () => {
    const [productsRes, categoriesRes] = await Promise.all([
      api.get('/products'),
      api.get('/products/categories'),
    ]);
    setProducts(productsRes.data.products);
    setCategories(categoriesRes.data.categories);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleArchive(product) {
    if (product.active) await api.delete(`/products/${product.id}`);
    else await api.put(`/products/${product.id}`, { active: true });
    toast(product.active ? `${product.name} archived` : `${product.name} restored`);
    load();
  }

  const visible = (products || []).filter((p) => {
    const term = search.trim().toLowerCase();
    const matchesSearch =
      !term ||
      p.name.toLowerCase().includes(term) ||
      p.sku.toLowerCase().includes(term) ||
      (p.barcodes || []).some((code) => code.includes(term));
    return matchesSearch && (showArchived ? true : p.active);
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Products"
        subtitle="Your catalog"
        actions={
          <>
            {/* Beside Import, because a supplier's file is the other thing
                that creates categories and this is where they get tidied. */}
            <Button variant="secondary" onClick={() => setManagingCategories(true)}>
              <Tags size={16} /> Categories
            </Button>
            <Link to="/admin/import">
              <Button variant="secondary">
                <Upload size={16} /> Import
              </Button>
            </Link>
            <Button onClick={() => setEditing(null)}>
              <Plus size={16} /> New product
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <Card>
          <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-3">
            <div className="relative flex-1">
              <Search
                size={16}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, SKU or barcode…"
                className="h-9 w-full rounded-lg bg-slate-100 pr-3 pl-9 text-sm ring-1 ring-transparent transition focus:bg-white focus:ring-brand-600 focus:outline-none"
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-brand-600"
              />
              Show archived
            </label>
          </div>

          {!products ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={Package}
              title="No products"
              description={search ? 'Nothing matches your search.' : 'Add a product or import your catalog.'}
              action={
                <Link to="/admin/import">
                  <Button variant="secondary">
                    <Upload size={16} /> Import a CSV
                  </Button>
                </Link>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-5 py-2.5 font-medium">Product</th>
                    <th className="px-3 py-2.5 font-medium">Category</th>
                    <th className="px-3 py-2.5 text-right font-medium">Price</th>
                    <th className="px-3 py-2.5 text-right font-medium">Margin</th>
                    <th className="px-3 py-2.5 font-medium">Stock</th>
                    <th className="px-5 py-2.5 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {visible.map((p) => {
                    const margin = p.price > 0 ? ((p.price - p.cost) / p.price) * 100 : 0;
                    return (
                      <tr key={p.id} className={cx('hover:bg-slate-50/60', !p.active && 'opacity-55')}>
                        <td className="px-5 py-2.5">
                          <div className="flex items-center gap-3">
                            <ProductThumb product={p} size="sm" />
                            <div className="min-w-0">
                              <p className="flex items-center gap-2 truncate font-medium text-slate-800">
                                {p.name}
                                {!p.active && <Badge tone="neutral">Archived</Badge>}
                              </p>
                              <p className="text-xs text-slate-400">
                                {p.sku}
                                {p.supplier ? ` · ${p.supplier}` : ''}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-slate-500">{p.category_name || '—'}</td>
                        <td className="tnum px-3 py-2.5 text-right">
                          <span className="block font-medium text-slate-800">{money(p.price)}</span>
                          {rate > 0 && (
                            <span className="block text-xs text-slate-400">{lbp(toLbp(p.price))}</span>
                          )}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right text-slate-500">{margin.toFixed(0)}%</td>
                        <td className="px-3 py-2.5">
                          {/* A card cannot be out of stock, and saying so on
                              every one of them would bury the products that
                              genuinely are. */}
                          {p.wallet_id ? (
                            <Badge tone="brand">Card · {p.wallet_name}</Badge>
                          ) : (
                            <StockBadge stock={p.stock} reorderPoint={p.reorder_point} />
                          )}
                        </td>
                        <td className="px-5 py-2.5">
                          <div className="flex justify-end gap-1">
                            {/* Serialised products are managed by handset, so the
                                shortcut goes where the work actually is. */}
                            {p.tracks_units ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setUnitsFor(p)}
                                aria-label={`Handsets of ${p.name}`}
                                title="Book in and track each IMEI"
                              >
                                <Smartphone size={14} /> IMEIs
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setActivityFor(p.id)}
                              aria-label={`Activity for ${p.name}`}
                              title="Sales, deliveries and cost changes"
                            >
                              <History size={14} /> History
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => setEditing(p)}>
                              <Pencil size={13} /> Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => toggleArchive(p)}
                              aria-label={p.active ? `Archive ${p.name}` : `Restore ${p.name}`}
                            >
                              {p.active ? <Archive size={14} /> : <ArchiveRestore size={14} />}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {editing !== undefined && (
        <ProductModal
          product={editing}
          categories={categories}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
        />
      )}

      {activityFor && <ItemActivity productId={activityFor} onClose={() => setActivityFor(null)} />}

      {managingCategories && (
        <CategoryManager onClose={() => setManagingCategories(false)} onChanged={load} />
      )}

      {unitsFor && (
        <Modal
          open
          onClose={() => setUnitsFor(null)}
          title={unitsFor.name}
          subtitle="Each handset, and what became of it"
          size="lg"
        >
          <UnitsPanel product={unitsFor} onChanged={load} />
        </Modal>
      )}
    </div>
  );
}

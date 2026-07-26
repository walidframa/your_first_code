import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Archive, ArchiveRestore, Package, Pencil, Plus, Search, Upload } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
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
  barcode: '',
  price: '',
  cost: '',
  stock: '',
  reorder_point: '5',
  category_id: '',
  supplier: '',
  image_url: '',
};

function ProductModal({ product, categories, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(
    product
      ? {
          name: product.name,
          sku: product.sku,
          barcode: product.barcode || '',
          price: product.price,
          cost: product.cost,
          stock: product.stock,
          reorder_point: product.reorder_point ?? 5,
          category_id: product.category_id || '',
          supplier: product.supplier || '',
          image_url: product.image_url || '',
        }
      : emptyForm,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

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
    };
    try {
      if (product) await api.put(`/products/${product.id}`, payload);
      else await api.post('/products', payload);
      toast(product ? 'Product updated' : 'Product created');
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={product ? 'Edit product' : 'New product'} size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Name" value={form.name} onChange={set('name')} required autoFocus className="col-span-2" />
          <Input label="SKU" value={form.sku} onChange={set('sku')} required />
          <Input label="Barcode" value={form.barcode} onChange={set('barcode')} hint="Scannable at the register" />
          <Input label="Price" type="number" step="0.01" min="0" value={form.price} onChange={set('price')} required />
          <Input label="Cost" type="number" step="0.01" min="0" value={form.cost} onChange={set('cost')} />
          <Input label="Stock on hand" type="number" step="1" value={form.stock} onChange={set('stock')} />
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
          <Input label="Supplier" value={form.supplier} onChange={set('supplier')} />
          <Input label="Image URL" value={form.image_url} onChange={set('image_url')} className="col-span-2" />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            {product ? 'Save changes' : 'Create product'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function Products() {
  const toast = useToast();
  const [products, setProducts] = useState(null);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(undefined);

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
      (p.barcode || '').includes(term);
    return matchesSearch && (showArchived ? true : p.active);
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Products"
        subtitle="Your catalog"
        actions={
          <>
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
                        <td className="tnum px-3 py-2.5 text-right font-medium text-slate-800">
                          {money(p.price)}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right text-slate-500">{margin.toFixed(0)}%</td>
                        <td className="px-3 py-2.5">
                          <StockBadge stock={p.stock} reorderPoint={p.reorder_point} />
                        </td>
                        <td className="px-5 py-2.5">
                          <div className="flex justify-end gap-1">
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
    </div>
  );
}

import { useEffect, useState } from 'react';
import api from '../../api';

const emptyForm = {
  name: '',
  sku: '',
  price: '',
  cost: '',
  stock: '',
  category_id: '',
  image_emoji: '📦',
};

export default function Products() {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState('');

  async function load() {
    const [productsRes, categoriesRes] = await Promise.all([
      api.get('/products'),
      api.get('/products/categories'),
    ]);
    setProducts(productsRes.data.products);
    setCategories(categoriesRes.data.categories);
  }

  useEffect(() => {
    load();
  }, []);

  function startEdit(product) {
    setEditingId(product.id);
    setForm({
      name: product.name,
      sku: product.sku,
      price: product.price,
      cost: product.cost,
      stock: product.stock,
      category_id: product.category_id || '',
      image_emoji: product.image_emoji,
    });
    setError('');
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm);
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const payload = {
      ...form,
      price: Number(form.price),
      cost: Number(form.cost) || 0,
      stock: Number(form.stock) || 0,
      category_id: form.category_id || null,
    };
    try {
      if (editingId) {
        await api.put(`/products/${editingId}`, payload);
      } else {
        await api.post('/products', payload);
      }
      cancelEdit();
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    }
  }

  async function archiveProduct(id) {
    await api.delete(`/products/${id}`);
    await load();
  }

  async function restoreProduct(product) {
    await api.put(`/products/${product.id}`, { active: true });
    await load();
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-semibold text-slate-800">Products & Inventory</h1>

      <form onSubmit={handleSubmit} className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-medium text-slate-700">{editingId ? 'Edit product' : 'Add product'}</h2>
        <div className="grid grid-cols-7 gap-2">
          <input
            className="col-span-2 rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <input
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="SKU"
            value={form.sku}
            onChange={(e) => setForm({ ...form, sku: e.target.value })}
            required
          />
          <input
            type="number"
            step="0.01"
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Price"
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
            required
          />
          <input
            type="number"
            step="0.01"
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Cost"
            value={form.cost}
            onChange={(e) => setForm({ ...form, cost: e.target.value })}
          />
          <input
            type="number"
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Stock"
            value={form.stock}
            onChange={(e) => setForm({ ...form, stock: e.target.value })}
          />
          <select
            className="rounded border border-slate-300 px-2 py-1.5 text-sm"
            value={form.category_id}
            onChange={(e) => setForm({ ...form, category_id: e.target.value })}
          >
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            className="w-20 rounded border border-slate-300 px-2 py-1.5 text-center text-sm"
            value={form.image_emoji}
            onChange={(e) => setForm({ ...form, image_emoji: e.target.value })}
            title="Emoji icon"
          />
          <button type="submit" className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
            {editingId ? 'Save changes' : 'Add product'}
          </button>
          {editingId && (
            <button type="button" onClick={cancelEdit} className="rounded-lg bg-slate-100 px-4 py-1.5 text-sm text-slate-600">
              Cancel
            </button>
          )}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </form>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3 text-right">Price</th>
              <th className="px-4 py-3 text-right">Stock</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className={`border-t border-slate-100 ${!p.active ? 'opacity-50' : ''}`}>
                <td className="px-4 py-2.5">
                  <span className="mr-2">{p.image_emoji}</span>
                  <span className="font-medium text-slate-700">{p.name}</span>
                </td>
                <td className="px-4 py-2.5 text-slate-500">{p.sku}</td>
                <td className="px-4 py-2.5 text-slate-500">{p.category_name || '—'}</td>
                <td className="px-4 py-2.5 text-right text-slate-700">${p.price.toFixed(2)}</td>
                <td className={`px-4 py-2.5 text-right font-medium ${p.stock <= 10 ? 'text-amber-600' : 'text-slate-700'}`}>
                  {p.stock}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => startEdit(p)} className="mr-3 text-xs text-emerald-700 hover:underline">
                    Edit
                  </button>
                  {p.active ? (
                    <button onClick={() => archiveProduct(p.id)} className="text-xs text-red-600 hover:underline">
                      Archive
                    </button>
                  ) : (
                    <button onClick={() => restoreProduct(p)} className="text-xs text-slate-600 hover:underline">
                      Restore
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import Receipt from '../components/Receipt';

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

export default function Checkout() {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [taxRate, setTaxRate] = useState(0);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [cart, setCart] = useState([]);
  const [discountPercent, setDiscountPercent] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('card');
  const [amountTendered, setAmountTendered] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState(null);

  async function loadData() {
    const [productsRes, categoriesRes, taxRes] = await Promise.all([
      api.get('/products', { params: { activeOnly: 'true' } }),
      api.get('/products/categories'),
      api.get('/orders/tax-rate'),
    ]);
    setProducts(productsRes.data.products);
    setCategories(categoriesRes.data.categories);
    setTaxRate(taxRes.data.taxRate);
  }

  useEffect(() => {
    loadData();
  }, []);

  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const matchesCategory = activeCategory === 'all' || p.category_id === activeCategory;
      const matchesSearch =
        !search ||
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.sku.toLowerCase().includes(search.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [products, activeCategory, search]);

  function addToCart(product) {
    setError('');
    setCart((prev) => {
      const existing = prev.find((i) => i.productId === product.id);
      if (existing) {
        if (existing.quantity >= product.stock) return prev;
        return prev.map((i) =>
          i.productId === product.id ? { ...i, quantity: i.quantity + 1 } : i,
        );
      }
      if (product.stock <= 0) return prev;
      return [
        ...prev,
        {
          productId: product.id,
          name: product.name,
          price: product.price,
          stock: product.stock,
          quantity: 1,
        },
      ];
    });
  }

  function updateQuantity(productId, quantity) {
    setCart((prev) =>
      prev
        .map((i) =>
          i.productId === productId
            ? { ...i, quantity: Math.max(1, Math.min(quantity, i.stock)) }
            : i,
        )
        .filter((i) => i.quantity > 0),
    );
  }

  function removeItem(productId) {
    setCart((prev) => prev.filter((i) => i.productId !== productId));
  }

  const subtotal = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const discountAmount = subtotal * (Number(discountPercent) / 100);
  const taxableAmount = subtotal - discountAmount;
  const tax = taxableAmount * taxRate;
  const total = taxableAmount + tax;
  const changeDue = paymentMethod === 'cash' ? Number(amountTendered || 0) - total : 0;

  async function handleCheckout() {
    setError('');
    if (cart.length === 0) return;
    if (paymentMethod === 'cash' && Number(amountTendered) < total) {
      setError('Amount tendered must cover the total');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post('/orders', {
        items: cart.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        discountPercent: Number(discountPercent) || 0,
        paymentMethod,
        amountTendered: paymentMethod === 'cash' ? Number(amountTendered) : undefined,
      });
      setReceipt({ order: res.data.order, items: res.data.items });
      setCart([]);
      setDiscountPercent(0);
      setAmountTendered('');
      await loadData();
    } catch (err) {
      setError(err.response?.data?.error || 'Checkout failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full">
      <div className="flex w-2/3 flex-col border-r border-slate-200 p-4">
        <div className="mb-3 flex items-center gap-2">
          <input
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            placeholder="Search products or SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          <button
            onClick={() => setActiveCategory('all')}
            className={`rounded-full px-3 py-1 text-sm font-medium ${
              activeCategory === 'all' ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 border border-slate-200'
            }`}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveCategory(c.id)}
              className={`rounded-full px-3 py-1 text-sm font-medium ${
                activeCategory === c.id ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 border border-slate-200'
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>

        <div className="grid flex-1 auto-rows-min grid-cols-4 gap-3 overflow-y-auto pb-4">
          {filteredProducts.map((p) => (
            <button
              key={p.id}
              onClick={() => addToCart(p)}
              disabled={p.stock <= 0}
              className="flex flex-col items-center rounded-xl border border-slate-200 bg-white p-3 text-center shadow-sm transition hover:shadow-md disabled:opacity-40"
            >
              <span className="text-3xl">{p.image_emoji}</span>
              <span className="mt-2 line-clamp-2 text-sm font-medium text-slate-800">{p.name}</span>
              <span className="mt-1 text-sm font-semibold text-emerald-700">{money(p.price)}</span>
              <span className="mt-0.5 text-xs text-slate-400">
                {p.stock > 0 ? `${p.stock} in stock` : 'Out of stock'}
              </span>
            </button>
          ))}
          {filteredProducts.length === 0 && (
            <p className="col-span-4 mt-10 text-center text-slate-400">No products match your search.</p>
          )}
        </div>
      </div>

      <div className="flex w-1/3 flex-col bg-white p-4">
        <h2 className="mb-3 text-lg font-semibold text-slate-800">Current Order</h2>

        <div className="flex-1 overflow-y-auto">
          {cart.length === 0 && <p className="mt-10 text-center text-sm text-slate-400">Cart is empty. Tap a product to add it.</p>}
          {cart.map((item) => (
            <div key={item.productId} className="mb-2 flex items-center justify-between rounded-lg border border-slate-100 p-2">
              <div className="flex-1">
                <p className="text-sm font-medium text-slate-800">{item.name}</p>
                <p className="text-xs text-slate-400">{money(item.price)} each</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => updateQuantity(item.productId, item.quantity - 1)}
                  className="h-6 w-6 rounded-full bg-slate-100 text-sm text-slate-600 hover:bg-slate-200"
                >
                  −
                </button>
                <span className="w-5 text-center text-sm">{item.quantity}</span>
                <button
                  onClick={() => updateQuantity(item.productId, item.quantity + 1)}
                  disabled={item.quantity >= item.stock}
                  className="h-6 w-6 rounded-full bg-slate-100 text-sm text-slate-600 hover:bg-slate-200 disabled:opacity-40"
                >
                  +
                </button>
                <button
                  onClick={() => removeItem(item.productId)}
                  className="ml-1 text-xs text-red-500 hover:text-red-700"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-500">Discount %</span>
            <input
              type="number"
              min="0"
              max="100"
              value={discountPercent}
              onChange={(e) => setDiscountPercent(e.target.value)}
              className="w-20 rounded border border-slate-300 px-2 py-1 text-right"
            />
          </div>
          <div className="flex justify-between text-sm text-slate-600">
            <span>Subtotal</span>
            <span>{money(subtotal)}</span>
          </div>
          <div className="flex justify-between text-sm text-slate-600">
            <span>Discount</span>
            <span>-{money(discountAmount)}</span>
          </div>
          <div className="flex justify-between text-sm text-slate-600">
            <span>Tax ({(taxRate * 100).toFixed(0)}%)</span>
            <span>{money(tax)}</span>
          </div>
          <div className="flex justify-between text-base font-semibold text-slate-900">
            <span>Total</span>
            <span>{money(total)}</span>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={() => setPaymentMethod('card')}
              className={`flex-1 rounded-lg py-2 text-sm font-medium ${
                paymentMethod === 'card' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              💳 Card
            </button>
            <button
              onClick={() => setPaymentMethod('cash')}
              className={`flex-1 rounded-lg py-2 text-sm font-medium ${
                paymentMethod === 'cash' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              💵 Cash
            </button>
          </div>

          {paymentMethod === 'cash' && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Amount tendered</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={amountTendered}
                onChange={(e) => setAmountTendered(e.target.value)}
                className="w-24 rounded border border-slate-300 px-2 py-1 text-right"
              />
            </div>
          )}
          {paymentMethod === 'cash' && amountTendered !== '' && (
            <div className="flex justify-between text-sm font-medium text-slate-700">
              <span>Change due</span>
              <span>{money(Math.max(0, changeDue))}</span>
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            onClick={handleCheckout}
            disabled={cart.length === 0 || submitting}
            className="w-full rounded-lg bg-emerald-600 py-3 font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
          >
            {submitting ? 'Processing…' : `Charge ${money(total)}`}
          </button>
        </div>
      </div>

      {receipt && <Receipt receipt={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

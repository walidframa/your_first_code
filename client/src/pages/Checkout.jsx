import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, Search, ShoppingCart, Trash2, X } from 'lucide-react';
import api from '../api';
import Receipt from '../components/Receipt';
import PaymentSheet from '../components/PaymentSheet';
import CustomerPicker from '../components/CustomerPicker';
import CashBox from '../components/CashBox';
import { Button, EmptyState, ProductThumb, Skeleton, cx, money, useToast } from '../components/ui';
import { useSettings, lbp } from '../context/SettingsContext';

const round2 = (n) => Math.round(n * 100) / 100;

export default function Checkout() {
  const toast = useToast();
  const searchRef = useRef(null);
  const { rate, toLbp } = useSettings();

  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [taxRate, setTaxRate] = useState(0);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [cart, setCart] = useState([]);
  const [discountPercent, setDiscountPercent] = useState(0);

  const [paymentOpen, setPaymentOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState(null);
  /*
   * Bumped after every completed sale. The cashbox panel watches it, so the
   * drawer's figure follows the till instead of going stale the moment a
   * customer pays — which is exactly when it is being read.
   */
  const [salesMade, setSalesMade] = useState(0);
  const [customer, setCustomer] = useState(null);

  const loadData = useCallback(async () => {
    const [productsRes, categoriesRes, taxRes] = await Promise.all([
      api.get('/products', { params: { activeOnly: 'true' } }),
      api.get('/products/categories'),
      api.get('/orders/tax-rate'),
    ]);
    setProducts(productsRes.data.products);
    setCategories(categoriesRes.data.categories);
    setTaxRate(taxRes.data.taxRate);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const addToCart = useCallback(
    (product, quantity = 1) => {
      let outcome = 'added';
      setCart((prev) => {
        const existing = prev.find((i) => i.productId === product.id);
        const inCart = existing?.quantity || 0;
        if (inCart + quantity > product.stock) {
          outcome = 'capped';
          return prev;
        }
        if (existing) {
          return prev.map((i) =>
            i.productId === product.id ? { ...i, quantity: i.quantity + quantity } : i,
          );
        }
        return [
          ...prev,
          {
            productId: product.id,
            name: product.name,
            sku: product.sku,
            price: product.price,
            stock: product.stock,
            image_url: product.image_url,
            image_emoji: product.image_emoji,
            quantity,
          },
        ];
      });
      if (outcome === 'capped') {
        toast(`Only ${product.stock} of ${product.name} in stock`, 'warning');
      }
      return outcome;
    },
    [toast],
  );

  /** Scan or type an exact barcode/SKU and press Enter to add it. */
  async function handleScan(code) {
    try {
      const res = await api.get('/products/lookup', { params: { code } });
      const product = res.data.product;
      if (product.stock <= 0) {
        toast(`${product.name} is out of stock`, 'error');
        return;
      }
      if (addToCart(product) === 'added') toast(`Added ${product.name}`);
      setSearch('');
    } catch (err) {
      toast(err.response?.data?.error || 'Product not found', 'error');
    }
  }

  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return products.filter((p) => {
      const matchesCategory = activeCategory === 'all' || p.category_id === activeCategory;
      const matchesSearch =
        !term ||
        p.name.toLowerCase().includes(term) ||
        p.sku.toLowerCase().includes(term) ||
        (p.barcode || '').includes(term);
      return matchesCategory && matchesSearch;
    });
  }, [products, activeCategory, search]);

  function updateQuantity(productId, quantity) {
    setCart((prev) =>
      prev.flatMap((i) => {
        if (i.productId !== productId) return [i];
        if (quantity <= 0) return [];
        return [{ ...i, quantity: Math.min(quantity, i.stock) }];
      }),
    );
  }

  const subtotal = round2(cart.reduce((sum, i) => sum + i.price * i.quantity, 0));
  const discountAmount = round2(subtotal * (Number(discountPercent) / 100));
  const taxableAmount = round2(subtotal - discountAmount);
  const tax = round2(taxableAmount * taxRate);
  const total = round2(taxableAmount + tax);
  const itemCount = cart.reduce((sum, i) => sum + i.quantity, 0);

  async function handleConfirmPayment({
    paymentMethod,
    payments,
    changeCurrency,
    changeUsd,
    changeLbp,
  }) {
    setSubmitting(true);
    try {
      const res = await api.post('/orders', {
        items: cart.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        discountPercent: Number(discountPercent) || 0,
        paymentMethod,
        payments,
        changeCurrency,
        // Both only matter when change is split, and then they are what the
        // cashier is actually handing over.
        changeUsd,
        changeLbp,
        customerId: customer?.id ?? null,
      });
      setReceipt({ order: res.data.order, items: res.data.items });
      setSalesMade((n) => n + 1);
      setCart([]);
      setDiscountPercent(0);
      setCustomer(null);
      setPaymentOpen(false);
      await loadData();
    } catch (err) {
      toast(err.response?.data?.error || 'Checkout failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  // Keyboard shortcuts: "/" focuses search, F2 opens payment, Esc clears search.
  useEffect(() => {
    function onKey(e) {
      if (e.key === '/' && document.activeElement !== searchRef.current) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'F2' && cart.length > 0 && !receipt) {
        e.preventDefault();
        setPaymentOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cart.length, receipt]);

  return (
    <div className="flex h-full">
      {/* Catalog */}
      <section className="flex min-w-0 flex-1 flex-col bg-slate-100">
        <div className="border-b border-slate-200 bg-white px-5 py-3">
          <div className="relative">
            <Search
              size={17}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
            />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && search.trim()) handleScan(search.trim());
                if (e.key === 'Escape') setSearch('');
              }}
              placeholder="Scan barcode or search products…  (press / to focus)"
              aria-label="Scan barcode or search products"
              className="h-11 w-full rounded-xl bg-slate-100 pr-9 pl-10 text-sm ring-1 ring-transparent transition focus:bg-white focus:ring-brand-600 focus:outline-none"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute top-1/2 right-3 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-700"
              >
                <X size={15} />
              </button>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {[{ id: 'all', name: 'All' }, ...categories].map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveCategory(c.id)}
                className={cx(
                  'rounded-full px-3 py-1.5 text-sm font-medium transition',
                  activeCategory === c.id
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                )}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {Array.from({ length: 12 }).map((_, i) => (
                <Skeleton key={i} className="h-[132px]" />
              ))}
            </div>
          ) : filteredProducts.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No products found"
              description={
                search ? `Nothing matches “${search}”.` : 'This category has no active products yet.'
              }
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {filteredProducts.map((p) => {
                const soldOut = p.stock <= 0;
                const low = !soldOut && p.stock <= p.reorder_point;
                return (
                  <button
                    key={p.id}
                    onClick={() => {
                      if (addToCart(p) === 'added') toast(`Added ${p.name}`);
                    }}
                    disabled={soldOut}
                    className={cx(
                      'group flex flex-col items-start gap-2 rounded-xl bg-white p-3 text-left ring-1 ring-slate-900/[0.06] transition',
                      soldOut
                        ? 'cursor-not-allowed opacity-45'
                        : 'hover:-translate-y-0.5 hover:shadow-md hover:ring-brand-300 active:translate-y-0',
                    )}
                  >
                    <ProductThumb product={p} size="lg" className="w-full" />
                    <span className="line-clamp-2 min-h-[2.5rem] text-sm leading-tight font-medium text-slate-800">
                      {p.name}
                    </span>
                    <div className="w-full">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="tnum text-sm font-semibold text-slate-900">{money(p.price)}</span>
                        <span
                          className={cx(
                            'tnum text-xs',
                            soldOut ? 'text-red-600' : low ? 'text-amber-700' : 'text-slate-400',
                          )}
                        >
                          {soldOut ? 'Sold out' : `${p.stock} left`}
                        </span>
                      </div>
                      {rate > 0 && (
                        <span className="tnum block text-xs font-medium text-slate-500">
                          {lbp(toLbp(p.price))}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Cart */}
      <aside className="no-print flex w-[380px] shrink-0 flex-col border-l border-slate-200 bg-white">
        {/*
         * The drawer's state belongs where the money is taken. A cashier who
         * only finds out it is shut when a cash sale is refused has already
         * kept a customer waiting.
         */}
        <CashBox refreshOn={salesMade} />

        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div>
            <h2 className="font-semibold text-slate-900">Current sale</h2>
            {rate > 0 && (
              <p className="tnum text-[11px] text-slate-400">
                1 USD = {Number(rate).toLocaleString('en-US')} LL
              </p>
            )}
          </div>
          {cart.length > 0 && (
            <button
              onClick={() => setCart([])}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 size={13} /> Clear
            </button>
          )}
        </div>

        <div className="border-b border-slate-100 px-3 py-2">
          <CustomerPicker customer={customer} onChange={setCustomer} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {cart.length === 0 ? (
            <EmptyState
              icon={ShoppingCart}
              title="No items yet"
              description="Scan a barcode or tap a product to start the sale."
            />
          ) : (
            <ul className="space-y-1">
              {cart.map((item) => (
                <li key={item.productId} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-slate-50">
                  <ProductThumb product={item} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{item.name}</p>
                    <p className="tnum text-xs text-slate-400">
                      {money(item.price)} each
                      {rate > 0 && <> · {lbp(toLbp(item.price))}</>}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => updateQuantity(item.productId, item.quantity - 1)}
                      aria-label={`Decrease ${item.name}`}
                      className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-slate-600 transition hover:bg-slate-200"
                    >
                      <Minus size={13} />
                    </button>
                    <span className="tnum w-6 text-center text-sm font-medium">{item.quantity}</span>
                    <button
                      onClick={() => updateQuantity(item.productId, item.quantity + 1)}
                      disabled={item.quantity >= item.stock}
                      aria-label={`Increase ${item.name}`}
                      className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-slate-600 transition hover:bg-slate-200 disabled:opacity-40"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  <div className="w-24 shrink-0 text-right">
                    <span className="tnum block text-sm font-semibold text-slate-900">
                      {money(item.price * item.quantity)}
                    </span>
                    {rate > 0 && (
                      <span className="tnum block text-[11px] text-slate-400">
                        {lbp(toLbp(item.price * item.quantity))}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-slate-100 px-5 py-4">
          <div className="mb-3 flex items-center justify-between">
            <label htmlFor="discount" className="text-sm text-slate-500">
              Discount
            </label>
            <div className="flex items-center gap-1">
              <input
                id="discount"
                type="number"
                min="0"
                max="100"
                value={discountPercent}
                onChange={(e) => setDiscountPercent(e.target.value)}
                className="tnum h-8 w-16 rounded-lg bg-slate-100 px-2 text-right text-sm ring-1 ring-transparent focus:bg-white focus:ring-brand-600 focus:outline-none"
              />
              <span className="text-sm text-slate-400">%</span>
            </div>
          </div>

          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">
                Subtotal <span className="text-slate-400">· {itemCount} item{itemCount === 1 ? '' : 's'}</span>
              </dt>
              <dd className="tnum text-slate-700">{money(subtotal)}</dd>
            </div>
            {discountAmount > 0 && (
              <div className="flex justify-between">
                <dt className="text-slate-500">Discount</dt>
                <dd className="tnum text-brand-700">−{money(discountAmount)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-slate-500">Tax ({(taxRate * 100).toFixed(0)}%)</dt>
              <dd className="tnum text-slate-700">{money(tax)}</dd>
            </div>
            <div className="flex items-baseline justify-between border-t border-slate-100 pt-2">
              <dt className="font-semibold text-slate-900">Total</dt>
              <dd className="text-2xl font-semibold text-slate-900">{money(total)}</dd>
            </div>
            {rate > 0 && (
              <div className="flex items-baseline justify-between">
                <dt className="text-xs text-slate-400">In pounds</dt>
                <dd className="tnum text-base font-medium text-slate-600">{lbp(toLbp(total))}</dd>
              </div>
            )}
          </dl>

          <Button
            size="xl"
            className="mt-4 w-full"
            disabled={cart.length === 0}
            onClick={() => setPaymentOpen(true)}
          >
            Charge {money(total)}
          </Button>
          <p className="mt-2 text-center text-[11px] text-slate-400">
            Press <kbd className="rounded bg-slate-100 px-1 font-sans">F2</kbd> to charge
          </p>
        </div>
      </aside>

      <PaymentSheet
        open={paymentOpen}
        total={total}
        customer={customer}
        submitting={submitting}
        onClose={() => setPaymentOpen(false)}
        onConfirm={handleConfirmPayment}
      />

      {receipt && <Receipt receipt={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

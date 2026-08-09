import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HandCoins, Minus, Plus, Search, ShoppingCart, Trash2, UserRound, X } from 'lucide-react';
import api from '../api';
import Receipt from '../components/Receipt';
import PaymentSheet from '../components/PaymentSheet';
import CustomerPicker from '../components/CustomerPicker';
import CashBox from '../components/CashBox';
import UnitPicker from '../components/UnitPicker';
import PhoneSaleDialog from '../components/PhoneSaleDialog';
import BuyHandsetModal from '../components/BuyHandsetModal';
import { Button, EmptyState, ProductThumb, Skeleton, cx, money, useToast } from '../components/ui';
import { useSettings, lbp } from '../context/SettingsContext';

const round2 = (n) => Math.round(n * 100) / 100;

export default function Checkout() {
  const toast = useToast();
  const searchRef = useRef(null);
  const { rate, toLbp } = useSettings();

  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  /*
   * The credit behind the cards. A cashier selling recharge needs to see the
   * wallet running out before a customer is standing there waiting for a code
   * the shop cannot produce.
   */
  const [wallets, setWallets] = useState([]);
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
  // The serialised product waiting for the cashier to say which handset.
  const [pickingUnitFor, setPickingUnitFor] = useState(null);
  // The handset picked, waiting on its price, gifts and accounts.
  const [sellingUnit, setSellingUnit] = useState(null);
  // Buying a phone happens at the counter too, not only in the back office.
  const [buyingHandset, setBuyingHandset] = useState(false);
  /*
   * Who walked out with the phone, and what the shop set up for them. Most
   * buyers never become a customer account — what is needed months later is a
   * name, a number, and the iCloud they have forgotten.
   */
  const [buyer, setBuyer] = useState({ name: '', phone: '' });
  const [accounts, setAccounts] = useState([]);

  const loadData = useCallback(async () => {
    const [productsRes, categoriesRes, taxRes, walletsRes] = await Promise.all([
      api.get('/products', { params: { activeOnly: 'true' } }),
      api.get('/products/categories'),
      api.get('/orders/tax-rate'),
      api.get('/wallets', { params: { activeOnly: 'true' } }),
    ]);
    setProducts(productsRes.data.products);
    setCategories(categoriesRes.data.categories);
    setTaxRate(taxRes.data.taxRate);
    setWallets(walletsRes.data.wallets);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const addToCart = useCallback(
    (product, quantity = 1, unit = null) => {
      let outcome = 'added';
      setCart((prev) => {
        /*
         * A serialised product never merges: two iPhones are IMEI A and IMEI B,
         * each with its own line, its own cost and its own row on the receipt.
         */
        if (unit) {
          if (prev.some((i) => i.unitId === unit.id)) {
            outcome = 'duplicate';
            return prev;
          }
          return [
            ...prev,
            {
              lineKey: `${product.id}:${unit.id}`,
              productId: product.id,
              unitId: unit.id,
              imei: unit.imei,
              name: product.name,
              sku: product.sku,
              price: product.price,
              stock: 1,
              image_url: product.image_url,
              image_emoji: product.image_emoji,
              quantity: 1,
            },
          ];
        }

        /*
         * A card has no shelf behind it — what it spends is the wallet's
         * credit, which is settled with the supplier rather than at the
         * counter. So there is no quantity to cap it against.
         */
        const unlimited = Boolean(product.wallet_id);

        const existing = prev.find((i) => i.productId === product.id && !i.unitId);
        const inCart = existing?.quantity || 0;
        if (!unlimited && inCart + quantity > product.stock) {
          outcome = 'capped';
          return prev;
        }
        if (existing) {
          return prev.map((i) =>
            i.productId === product.id && !i.unitId ? { ...i, quantity: i.quantity + quantity } : i,
          );
        }
        return [
          ...prev,
          {
            lineKey: String(product.id),
            productId: product.id,
            unitId: null,
            name: product.name,
            sku: product.sku,
            price: product.price,
            stock: product.stock,
            unlimited,
            image_url: product.image_url,
            image_emoji: product.image_emoji,
            quantity,
          },
        ];
      });
      if (outcome === 'capped') {
        toast(`Only ${product.stock} of ${product.name} in stock`, 'warning');
      }
      if (outcome === 'duplicate') {
        toast('That handset is already on this sale', 'warning');
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
      if (!product.wallet_id && product.stock <= 0) {
        toast(`${product.name} is out of stock`, 'error');
        return;
      }
      if (product.tracks_units) {
        setPickingUnitFor(product);
        setSearch('');
        return;
      }
      if (addToCart(product) === 'added') toast(`Added ${product.name}`);
      setSearch('');
    } catch (err) {
      toast(err.response?.data?.error || 'Product not found', 'error');
    }
  }

  const walletById = useMemo(() => new Map(wallets.map((w) => [w.id, w])), [wallets]);

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

  /**
   * Everything settled in the sale dialog, put into the cart at once.
   *
   * The gifts are ordinary lines marked as gifts rather than something attached
   * to the phone: each one leaves stock in its own right, and the receipt has
   * to show what the customer actually walked out with.
   */
  function addPhoneToCart(product, unit, details) {
    setCart((prev) => {
      if (prev.some((i) => i.unitId === unit.id)) return prev;

      const lines = [
        {
          lineKey: `${product.id}:${unit.id}`,
          productId: product.id,
          unitId: unit.id,
          imei: unit.imei,
          name: product.name,
          sku: product.sku,
          price: details.price,
          discount: details.discount,
          stock: 1,
          image_url: product.image_url,
          image_emoji: product.image_emoji,
          quantity: 1,
        },
      ];

      for (const g of details.gifts) {
        // Keyed to the handset so two phones can each carry the same freebie.
        if (prev.some((i) => i.lineKey === `gift:${unit.id}:${g.productId}`)) continue;
        lines.push({
          lineKey: `gift:${unit.id}:${g.productId}`,
          productId: g.productId,
          unitId: null,
          name: g.name,
          price: 0,
          stock: g.stock,
          quantity: 1,
          isGift: true,
        });
      }

      return [...prev, ...lines];
    });

    // The buyer belongs to the sale, not the line — the last one named wins,
    // which is what a counter would expect when two phones go out together.
    if (details.buyerName || details.buyerPhone) {
      setBuyer({ name: details.buyerName, phone: details.buyerPhone });
    }
    if (details.accounts.length) setAccounts((a) => [...a, ...details.accounts]);

    toast(`Added ${product.name} · ${unit.imei}`);
  }

  /** Give a line away: no money, but the stock still moves. */
  function toggleGift(lineKey) {
    setCart((prev) => prev.map((i) => (i.lineKey === lineKey ? { ...i, isGift: !i.isGift } : i)));
  }

  function updateQuantity(lineKey, quantity) {
    setCart((prev) =>
      prev.flatMap((i) => {
        if (i.lineKey !== lineKey) return [i];
        if (quantity <= 0) return [];
        return [{ ...i, quantity: i.unlimited ? quantity : Math.min(quantity, i.stock) }];
      }),
    );
  }

  const subtotal = round2(
    cart.reduce(
      (sum, i) => sum + (i.isGift ? 0 : i.price * i.quantity - (i.discount || 0)),
      0,
    ),
  );
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
        items: cart.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
          unitId: i.unitId,
          isGift: Boolean(i.isGift),
          // Undefined leaves the catalogue price alone; a handset carries what
          // was actually agreed at the counter.
          price: i.price,
          discount: i.discount,
        })),
        discountPercent: Number(discountPercent) || 0,
        paymentMethod,
        payments,
        changeCurrency,
        // Both only matter when change is split, and then they are what the
        // cashier is actually handing over.
        changeUsd,
        changeLbp,
        customerId: customer?.id ?? null,
        buyerName: buyer.name || null,
        buyerPhone: buyer.phone || null,
        accounts: accounts.filter((a) => a.username.trim()),
      });
      setReceipt({ order: res.data.order, items: res.data.items });
      setSalesMade((n) => n + 1);
      setCart([]);
      setDiscountPercent(0);
      setCustomer(null);
      setBuyer({ name: '', phone: '' });
      setAccounts([]);
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
                /*
                 * A card is never sold out. What it can be is unfunded — the
                 * wallet behind it empty — which is worth saying on the tile
                 * without refusing the sale: the customer is here, the code can
                 * still be given, and the supplier is settled with later.
                 */
                const wallet = p.wallet_id ? walletById.get(p.wallet_id) : null;
                const soldOut = !p.wallet_id && p.stock <= 0;
                const low = !p.wallet_id && !soldOut && p.stock <= p.reorder_point;
                return (
                  <button
                    key={p.id}
                    onClick={() => {
                      if (p.tracks_units) {
                        setPickingUnitFor(p);
                        return;
                      }
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
                            soldOut || (wallet && wallet.balance <= 0)
                              ? 'text-red-600'
                              : low
                                ? 'text-amber-700'
                                : 'text-slate-400',
                          )}
                        >
                          {wallet
                            ? wallet.balance <= 0
                              ? 'no credit'
                              : 'card'
                            : soldOut
                              ? 'Sold out'
                              : `${p.stock} left`}
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

        <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
          <div className="min-w-0 flex-1">
            <CustomerPicker customer={customer} onChange={setCustomer} />
          </div>
          {/* Buying a used phone is counter work, so it starts at the counter. */}
          <button
            onClick={() => setBuyingHandset(true)}
            title="Buy a used handset from a customer"
            className="flex shrink-0 items-center gap-1 rounded-lg bg-slate-100 px-2 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-200"
          >
            <HandCoins size={14} /> Buy in
          </button>
        </div>

        {/*
          * Buyer and accounts are collected in the sale dialog on the way in,
          * so a handset cannot reach the cart without them being asked for.
          * Shown here only as a reminder of what was captured.
          */}
        {(buyer.name || accounts.length > 0) && (
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs text-slate-500">
            <UserRound size={13} className="text-slate-400" />
            <span className="truncate">
              {buyer.name || 'no name'}
              {buyer.phone ? ` · ${buyer.phone}` : ''}
            </span>
            {accounts.length > 0 && (
              <span className="ml-auto rounded-full bg-brand-50 px-1.5 py-0.5 font-medium text-brand-700">
                {accounts.length} account{accounts.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}

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
                <li key={item.lineKey} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-slate-50">
                  <ProductThumb product={item} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{item.name}</p>
                    <p className="tnum text-xs text-slate-400">
                      {money(item.price)} each
                      {rate > 0 && <> · {lbp(toLbp(item.price))}</>}
                    </p>
                    {item.imei && (
                      <p className="truncate font-mono text-[11px] text-slate-400">{item.imei}</p>
                    )}
                    <button
                      onClick={() => toggleGift(item.lineKey)}
                      className={cx(
                        'mt-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium transition',
                        item.isGift
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600',
                      )}
                    >
                      {item.isGift ? '★ Gift — free' : 'Make it a gift'}
                    </button>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => updateQuantity(item.lineKey, item.quantity - 1)}
                      aria-label={`Decrease ${item.name}`}
                      className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-slate-600 transition hover:bg-slate-200"
                    >
                      <Minus size={13} />
                    </button>
                    <span className="tnum w-6 text-center text-sm font-medium">{item.quantity}</span>
                    <button
                      onClick={() => updateQuantity(item.lineKey, item.quantity + 1)}
                      disabled={!item.unlimited && item.quantity >= item.stock}
                      aria-label={`Increase ${item.name}`}
                      className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-slate-600 transition hover:bg-slate-200 disabled:opacity-40"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  <div className="w-24 shrink-0 text-right">
                    <span
                      className={cx(
                        'tnum block text-sm font-semibold',
                        item.isGift ? 'text-slate-300 line-through' : 'text-slate-900',
                      )}
                    >
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
                <dt className="text-xs text-slate-400">In LBP</dt>
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

      {pickingUnitFor && (
        <UnitPicker
          product={pickingUnitFor}
          onClose={() => setPickingUnitFor(null)}
          onPick={(unit) => {
            setSellingUnit({ product: pickingUnitFor, unit });
            setPickingUnitFor(null);
          }}
        />
      )}

      {buyingHandset && (
        <BuyHandsetModal
          onClose={() => setBuyingHandset(false)}
          onSaved={async () => {
            setBuyingHandset(false);
            await loadData();
            setSalesMade((n) => n + 1);
          }}
        />
      )}

      {sellingUnit && (
        <PhoneSaleDialog
          product={sellingUnit.product}
          unit={sellingUnit.unit}
          onCancel={() => setSellingUnit(null)}
          onAdd={(details) => {
            addPhoneToCart(sellingUnit.product, sellingUnit.unit, details);
            setSellingUnit(null);
          }}
        />
      )}

      {receipt && <Receipt receipt={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HandCoins,
  Minus,
  Receipt as ReceiptIcon,
  Send,
  Smartphone,
  Wrench,
  PauseCircle,
  Plus,
  Search,
  ShoppingCart,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import api from '../api';
import Receipt from '../components/Receipt';
import { HeldSalesDialog, HoldSaleDialog, ResumeIssues } from '../components/HeldSales';
import TakeInRepair from '../components/TakeInRepair';
import PaymentSheet from '../components/PaymentSheet';
import CustomerPicker from '../components/CustomerPicker';
import CashBox from '../components/CashBox';
import UnitPicker from '../components/UnitPicker';
import PhoneSaleDialog from '../components/PhoneSaleDialog';
import BuyHandsetModal from '../components/BuyHandsetModal';
import SellSim from '../components/SellSim';
import SendCredit from '../components/SendCredit';
import SittingSales from '../components/SittingSales';
import { ringUp } from '../lib/sales';
import { useOffline } from '../context/OfflineContext';
import { useLicence } from '../context/LicenceContext';
import { useT } from '../context/LanguageContext';
import MoneyInput from '../components/MoneyInput';
import {
  Button,
  EmptyState,
  Modal,
  ModalActions,
  ProductThumb,
  Skeleton,
  cx,
  money,
  useToast,
} from '../components/ui';
import { useSettings, lbp } from '../context/SettingsContext';
import { useConfirm } from '../components/ConfirmProvider';
import { useAuth } from '../context/AuthContext';

/**
 * A request the screen can open without.
 *
 * Resolves to `fallback` instead of throwing, so one feature a shop has not
 * bought cannot take down the screen that sells everything else.
 */
const optional = (request, fallback) => request.then((res) => res.data).catch(() => fallback);


const round2 = (n) => Math.round(n * 100) / 100;

/** Where a half-rung sale waits while somebody looks at another page. */
const CART_KEY = 'pos_cart';

/**
 * What this line is going out at.
 *
 * A phone shop haggles. Until now the only answer to "make it two hundred" was
 * the whole-sale discount, which is the wrong instrument when one handset moved
 * on price and the case beside it did not — and it left the books saying the
 * phone sold at list with a discount on the basket, which is not what happened.
 * A price agreed on one line is recorded on that line, so the margin on the
 * phone is the margin on the phone.
 *
 * Typed in either currency, because half of what is quoted across this counter
 * is quoted in pounds. Nothing here touches the catalogue: the shelf price is
 * kept beside it and is one press away again.
 */
function LinePrice({ item, onClose, onSet }) {
  const t = useT();
  const { rate } = useSettings();
  const listed = item.listPrice ?? item.price;
  const [value, setValue] = useState(String(item.price));

  const asked = Number(value);
  const valid = value !== '' && Number.isFinite(asked) && asked >= 0;
  const changed = valid && round2(asked) !== round2(listed);

  return (
    <Modal open onClose={onClose} title={t('Price for this sale')} subtitle={item.name}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSet(round2(asked));
        }}
        className="space-y-4"
      >
        <MoneyInput
          label={t('Price each')}
          name="linePrice"
          value={value}
          onChange={setValue}
          autoFocus
          hint={`${t('On the shelf')}: ${money(listed)}${rate > 0 ? ` · ${lbp(Math.round(listed * rate))}` : ''}`}
        />

        {/*
          * What it means for this sale, said in the terms it was argued in —
          * a customer asks for money off, not for a new unit price.
          */}
        {changed && (
          <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200">
            {asked < listed
              ? `${money(round2(listed - asked))} off each, ${money(round2((listed - asked) * item.quantity))} off this line.`
              : `${money(round2(asked - listed))} more each than the shelf price.`}
          </p>
        )}

        {/* Zero is a giveaway with the stock still moving, which is what the
            Gift button is for — said here so nobody invents it with a price. */}
        {valid && round2(asked) === 0 && (
          <p className="text-xs text-slate-500">
            {t('At nothing, this is a gift — the Gift button says so on the receipt.')}
          </p>
        )}

        <ModalActions>
          {item.listPrice != null && item.listPrice !== item.price ? (
            <Button type="button" variant="secondary" className="flex-1" onClick={() => onSet(listed)}>
              {t('Back to')} {money(listed)}
            </Button>
          ) : (
            <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
              {t('Cancel')}
            </Button>
          )}
          <Button type="submit" className="flex-1" disabled={!valid}>
            {t('Use this price')}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

export default function Checkout() {
  const toast = useToast();
  const confirm = useConfirm();
  const searchRef = useRef(null);
  const { rate, toLbp } = useSettings();
  const { refreshQueue } = useOffline();
  // What this shop actually bought — see lib/nav.js.
  const { hasModule } = useLicence();
  const t = useT();

  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  /*
   * The credit behind the cards. A cashier selling recharge needs to see the
   * wallet running out before a customer is standing there waiting for a code
   * the shop cannot produce.
   */
  const [wallets, setWallets] = useState([]);
  const [taxRate, setTaxRate] = useState(0);
  // What the shop calls it on a receipt — VAT, TVA, or its own word.
  const [taxName, setTaxName] = useState('Tax');
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  /*
   * The cart survives leaving this screen.
   *
   * It is somebody's actual sale, half rung up, with a customer standing
   * there. Before tabs there was no ordinary way to leave the register
   * mid-sale; now there is — checking a price, looking up a repair — and
   * losing the cart on the way back would make that a trap rather than a
   * feature.
   *
   * Session storage, not local: a sale belongs to whoever is at the counter
   * now. A till reopened tomorrow morning must not offer the night's abandoned
   * cart to whoever opens it. Anything meant to outlive the sitting is a held
   * sale, which is a deliberate act with a name on it.
   */
  const [cart, setCart] = useState(() => {
    try {
      const kept = JSON.parse(sessionStorage.getItem(CART_KEY) || '[]');
      return Array.isArray(kept) ? kept : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      if (cart.length) sessionStorage.setItem(CART_KEY, JSON.stringify(cart));
      else sessionStorage.removeItem(CART_KEY);
    } catch {
      /* A full or blocked store must not stop anybody selling. */
    }
  }, [cart]);
  /*
   * A discount, and which of the three things it is.
   *
   * "Ten per cent off", "call it fifty dollars" and "knock off two hundred
   * thousand" are all normal at a counter, and none of them should need the
   * cashier to work out what the other two come to.
   */
  const [discountValue, setDiscountValue] = useState(0);
  const [discountMode, setDiscountMode] = useState('percent');

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
  /* The cart line whose price is being argued over, if any. */
  const [pricing, setPricing] = useState(null);
  // The handset picked, waiting on its price, gifts and accounts.
  const [sellingUnit, setSellingUnit] = useState(null);
  // Buying a phone happens at the counter too, not only in the back office.
  const [buyingHandset, setBuyingHandset] = useState(false);
  // A phone left in for repair. Counter work, so it starts at the counter.
  const [takingRepair, setTakingRepair] = useState(false);
  // This till's sales, over the register rather than away from it.
  const [showingSales, setShowingSales] = useState(false);
  // A SIM sold by its number, and calling credit sent by SMS. Both are counter
  // work with their own dialog, and neither is a product on the shelf.
  const [sellingSim, setSellingSim] = useState(false);
  const [sendingCredit, setSendingCredit] = useState(false);
  /*
   * Who walked out with the phone, and what the shop set up for them. Most
   * buyers never become a customer account — what is needed months later is a
   * name, a number, and the iCloud they have forgotten.
   */
  const [buyer, setBuyer] = useState({ name: '', phone: '' });
  const [accounts, setAccounts] = useState([]);
  /*
   * Sales put to one side. The count sits on the button so a cart parked by the
   * morning shift is visible to the afternoon one without anybody going looking
   * for it.
   */
  const [heldCount, setHeldCount] = useState(0);
  const [heldDialog, setHeldDialog] = useState(null);
  const [resumeIssues, setResumeIssues] = useState(null);

  /*
   * What the till needs, and what it merely likes to have.
   *
   * These were one `Promise.all`, which means they were one thing: any of the
   * five failing threw before the first `setState`, so the products were never
   * put on the screen and the grid sat on its loading skeletons for ever, with
   * no error and nothing to press.
   *
   * That is not hypothetical. `/wallets` is behind the `cards` module, and a
   * shop that had not bought recharge cards got a 403 there — so a feature it
   * had never asked for silently took away the ability to sell anything at all.
   * The screen showed grey rectangles where its own stock should be.
   *
   * So: three requests that the register cannot open without, and two that it
   * can. An optional one that fails costs its own feature — the wallet button,
   * the held-sales count — and nothing else.
   */
  const loadData = useCallback(async () => {
    const [productsRes, categoriesRes, taxRes] = await Promise.all([
      api.get('/products', { params: { activeOnly: 'true' } }),
      api.get('/products/categories'),
      api.get('/orders/tax-rate'),
    ]);
    setProducts(productsRes.data.products);
    setCategories(categoriesRes.data.categories);
    setTaxRate(taxRes.data.taxRate);
    setTaxName(taxRes.data.taxName || 'Tax');
    // Shown as soon as there is something to sell, rather than waiting on the
    // parts of the screen that are allowed to be missing.
    setLoading(false);

    const [wallets, held] = await Promise.all([
      optional(api.get('/wallets', { params: { activeOnly: 'true' } }), { wallets: [] }),
      optional(api.get('/held-sales'), { count: 0 }),
    ]);
    setWallets(wallets.wallets ?? []);
    setHeldCount(held.count ?? 0);
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

        /*
         * A validity card that is going to sell the days and move no credit.
         *
         * Worth saying here rather than only on the Cards screen, because this
         * is where somebody finds out: they sell one, go and look at the
         * carrier balance, and it is still zero. The setup is a press away in
         * the back office and this is the moment they would want to know.
         */
        const noCreditSetUp =
          Boolean(product.validity_days) &&
          !(product.credit_recovered > 0 && product.credit_wallet_id);

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
            noCreditSetUp,
            image_url: product.image_url,
            image_emoji: product.image_emoji,
            // What is in the pack, so the line can say what goes in the bag.
            bundleOf: product.bundleOf || null,
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

  /**
   * Everything on screen that belongs to this sale but is not a cart line.
   *
   * Held alongside the lines so picking the sale back up puts the cashier
   * exactly where they stood — the customer on the account, the buyer's name
   * for the phone, the discount already agreed. A cart restored without them is
   * a sale that has to be set up twice.
   */
  const saleContext = () => ({ discountValue, discountMode, customer, buyer, accounts });

  function applyHeldSale(held, issues, count) {
    const context = held.context || {};

    /*
     * The lines come back as they were typed — a negotiated price stays
     * negotiated — but what is on the shelf is read again. Otherwise the
     * quantity stepper would still be capped at yesterday's stock, and the
     * cashier would only find out at the moment they take the money.
     */
    const current = new Map(products.map((p) => [p.id, p]));
    setCart(
      (held.cart || []).map((linefromHold) => {
        const product = current.get(linefromHold.productId);
        if (!product || linefromHold.unitId) return linefromHold;
        return { ...linefromHold, stock: product.stock, unlimited: Boolean(product.wallet_id) };
      }),
    );
    /*
     * `discountPercent` is what a sale held before any of this existed carries,
     * so an old one picked up today still comes back with its discount.
     */
    setDiscountValue(context.discountValue ?? context.discountPercent ?? 0);
    setDiscountMode(context.discountMode || 'percent');
    setCustomer(context.customer ?? null);
    setBuyer(context.buyer ?? { name: '', phone: '' });
    setAccounts(context.accounts ?? []);
    setHeldDialog(null);
    if (typeof count === 'number') setHeldCount(count);
    // Only if something actually moved underneath it — an unchanged sale should
    // come back without a dialog in the way.
    if (issues?.length) setResumeIssues(issues);
  }

  /** Give a line away: no money, but the stock still moves. */
  function toggleGift(lineKey) {
    setCart((prev) => prev.map((i) => (i.lineKey === lineKey ? { ...i, isGift: !i.isGift } : i)));
  }

  /**
   * What this one is going out at, today, for this customer.
   *
   * Haggling is how a phone is sold here, and until now the only way to meet a
   * price was the whole-sale discount — which is the wrong instrument when one
   * handset moved and the case beside it did not. The catalogue is untouched:
   * this is the line's price, and `listPrice` keeps what the shelf says so the
   * change stays visible and reversible while the cart is open.
   *
   * Not behind a permission of its own, deliberately. The discount box on this
   * same screen already lets anybody standing here take money off the total,
   * so gating this and not that would be a lock on one door of two — and the
   * sale records what was actually charged either way, which is what the
   * profit report reads.
   */
  function setLinePrice(lineKey, price) {
    setCart((prev) =>
      prev.map((i) =>
        i.lineKey === lineKey
          ? { ...i, price, listPrice: i.listPrice ?? i.price }
          : i,
      ),
    );
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

  /*
   * A phone handed over as part of this sale.
   *
   * Held here rather than saved when the dialog closes: the handset, the money
   * and the sale have to land together. A trade-in written down against a sale
   * that then failed leaves the shop holding stock it never bought and a
   * customer holding a phone it thinks it sold.
   */
  const [tradeIn, setTradeIn] = useState(null);
  const { can } = useAuth();

  const subtotal = round2(
    cart.reduce(
      (sum, i) => sum + (i.isGift ? 0 : i.price * i.quantity - (i.discount || 0)),
      0,
    ),
  );
  const discountAmount = Math.min(
    subtotal,
    round2(
      discountMode === 'percent'
        ? subtotal * (Number(discountValue) / 100)
        : discountMode === 'lbp'
          ? (rate > 0 ? Number(discountValue) / rate : 0)
          : Number(discountValue) || 0,
    ),
  );
  const taxableAmount = round2(subtotal - discountAmount);
  const tax = round2(taxableAmount * taxRate);
  const total = round2(taxableAmount + tax);

  /*
   * What the shop stands to make on the sale in front of it.
   *
   * The figure a shopkeeper wants before agreeing to a price, not after — the
   * whole reason a counter haggles is to find out how far down it can go, and
   * working that out on paper while a customer waits is how a shop sells at a
   * loss and finds out at the end of the month.
   *
   * Tax is not in it. Tax is collected, not earned; counting it as margin would
   * flatter every line by whatever the government's share is.
   *
   * A gift is priced at nothing and still cost what it cost, so it drags the
   * figure down — which is exactly what giving something away does.
   */
  const costOf = (i) =>
    i.unit?.cost ?? (i.cost === null || i.cost === undefined ? null : Number(i.cost));
  const priced = cart.filter((i) => costOf(i) !== null);
  const unknownCost = cart.length - priced.length;
  const cartCost = round2(priced.reduce((sum, i) => sum + costOf(i) * i.quantity, 0));
  const cartTakings = round2(
    priced.reduce((sum, i) => sum + (i.isGift ? 0 : i.price * i.quantity - (i.discount || 0)), 0),
  );
  // The whole-sale discount comes off the margin, not off the cost.
  const cartProfit = round2(cartTakings - cartCost - discountAmount);
  const cartMargin = cartTakings > 0 ? Math.round((cartProfit / cartTakings) * 100) : 0;
  /*
   * What somebody actually hands over — allowed to be negative, which is the
   * whole point. `total` stays what the goods came to, because that is what the
   * receipt and the day's takings are about.
   */
  const tradeInValue = tradeIn ? round2(Number(tradeIn.value) || 0) : 0;
  const due = round2(total - tradeInValue);
  const owedToCustomer = due < 0 ? round2(-due) : 0;
  const itemCount = cart.reduce((sum, i) => sum + i.quantity, 0);

  /**
   * Settle a sale where the shop owes the money.
   *
   * Deliberately not the payment sheet. That screen is built around counting
   * out what a customer handed over and working out their change, and none of
   * that exists here — there is one number, it goes the other way, and it comes
   * out of the drawer. One question, then done.
   */
  async function payTheCustomer() {
    const ok = await confirm({
      title: `${t('Hand the customer')} ${money(owedToCustomer)} ${t('out of the drawer?')}`,
      body: t('This takes the money out of the drawer now.'),
      confirmLabel: t('Hand it over'),
      cancelLabel: t('Not yet'),
      tone: 'warning',
    });
    if (!ok) return;
    await handleConfirmPayment({ paymentMethod: 'cash', payments: [], changeCurrency: 'LBP' });
  }

  async function handleConfirmPayment({
    paymentMethod,
    payments,
    // A sale settled with more than one thing sends its pieces instead of a
    // method; the server understands either.
    tenders,
    changeCurrency,
    changeUsd,
    changeLbp,
  }) {
    setSubmitting(true);
    try {
      const res = await ringUp({
        items: cart.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
          unitId: i.unitId,
          isGift: Boolean(i.isGift),
          /*
           * Credit is not a product: the server works out the messages and what
           * they cost from the carrier's own settings, and only takes the
           * amount and the number from here.
           */
          creditSend: i.creditSend,
          // A SIM is a line registered to somebody, so the buyer's ID rides
          // with it and is attached to the sale line once it exists.
          idPhoto: i.idPhoto,
          // Undefined leaves the catalogue price alone; a handset carries what
          // was actually agreed at the counter.
          price: i.price,
          discount: i.discount,
        })),
        // The shape the server settles on; it converts pounds with its own
        // rate rather than trusting the one this browser happens to hold.
        discount: { mode: discountMode, value: Number(discountValue) || 0 },
        paymentMethod,
        payments,
        tenders,
        changeCurrency,
        // Both only matter when change is split, and then they are what the
        // cashier is actually handing over.
        changeUsd,
        changeLbp,
        customerId: customer?.id ?? null,
        buyerName: buyer.name || null,
        buyerPhone: buyer.phone || null,
        accounts: accounts.filter((a) => a.username.trim()),
        // The old phone, taken in as part of this sale rather than before it,
        // so the handset and the money land together or not at all.
        tradeIn: tradeIn
          ? {
              productId: tradeIn.productId,
              imei: tradeIn.imei,
              condition: tradeIn.condition,
              value: tradeInValue,
              sellerName: tradeIn.sellerName || buyer.name || null,
              sellerPhone: tradeIn.sellerPhone || buyer.phone || null,
              idPhoto: tradeIn.idPhoto || null,
              note: tradeIn.note || null,
            }
          : null,
        /*
         * What the till believes it just sold. Only read when the sale has to
         * wait — the server is the authority on totals whenever it is there,
         * and this is what lets a receipt print and a queue be counted while it
         * is not.
         */
        localTotal: total,
        localLines: cart.map((i) => ({
          id: i.lineKey,
          name: i.name,
          quantity: i.quantity,
          price: i.price,
          line_total: round2(i.price * i.quantity),
        })),
      });

      if (res.waiting) {
        toast('Saved on this till — it will be sent when the server is back', 'warning', 7000);
      }
      setReceipt({ order: res.order, items: res.items, tenders: res.tenders });
      setSalesMade((n) => n + 1);
      setCart([]);
      setDiscountValue(0);
      setCustomer(null);
      setBuyer({ name: '', phone: '' });
      setAccounts([]);
      setTradeIn(null);
      setPaymentOpen(false);
      /*
       * Only worth re-reading the catalogue when there is something to read it
       * from; offline it would fail and say so for no reason.
       */
      if (!res.waiting) await loadData();
      else await refreshQueue();
    } catch (err) {
      toast(err.response?.data?.error || 'Checkout failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  /*
   * Keyboard shortcuts: "/" focuses search, F2 charges, F3 holds the sale and
   * F4 opens the shelf of held ones. Holding is a queue-length problem, and
   * reaching for the mouse is exactly what there is no time for.
   */
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
      if (e.key === 'F3' && cart.length > 0 && !receipt) {
        e.preventDefault();
        setHeldDialog('hold');
      }
      if (e.key === 'F4' && !receipt) {
        e.preventDefault();
        setHeldDialog('list');
      }
      /*
       * F6 takes a phone in. Not F5, which reloads the page — pressed by
       * mistake at a counter that would throw away the cart.
       *
       * It works with a sale part-rung, because that is when it is needed: the
       * customer buying a charger is also the one asking whether you can look
       * at their screen. Taking the repair in does not touch the cart.
       */
      if (e.key === 'F6' && !receipt) {
        e.preventDefault();
        setTakingRepair(true);
      }
      // The two that are sold from the counter without being on the shelf.
      if (e.key === 'F7' && !receipt) {
        e.preventDefault();
        setSellingSim(true);
      }
      if (e.key === 'F8' && !receipt) {
        e.preventDefault();
        setSendingCredit(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cart.length, receipt]);

  return (
    /*
     * Side by side on anything with room, stacked on a phone.
     *
     * A 380-pixel cart beside a product grid needs about a thousand pixels
     * before the grid stops being a single column of squeezed tiles. Below that
     * the two become one scrolling page — shelf first, then the cart under it —
     * which is the order somebody works in anyway: find the thing, then take
     * the money.
     */
    <div className="flex h-full flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      {/* Catalog */}
      <section className="flex min-w-0 flex-1 flex-col bg-slate-100 lg:min-h-0">
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
              placeholder={`${t('Scan barcode or search products…')}  (${t('press / to focus')})`}
              aria-label={t('Scan barcode or search products')}
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
                {t(c.name)}
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
                              ? t('no credit')
                              : t('card')
                            : soldOut
                              ? t('Sold out')
                              : `${p.stock} ${t('left')}`}
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

      {/*
        * Cart.
        *
        * Wider than it was, and wider again on a big screen. This column is
        * what the sale actually is — the names, the quantities, the prices
        * somebody is about to charge for — and at 380px a phone model with a
        * capacity and a colour in its name wrapped to three lines, which is
        * where a cashier stops reading and starts guessing.
        *
        * It grows only past `lg`, so the small counter monitor the app is
        * usually on keeps its shelf of products at the width it had.
        */}
      <aside className="no-print flex w-full shrink-0 flex-col border-slate-200 bg-white lg:w-[420px] xl:w-[500px] lg:border-s">
        {/*
         * The drawer's state belongs where the money is taken. A cashier who
         * only finds out it is shut when a cash sale is refused has already
         * kept a customer waiting.
         */}
        {/*
         * Profit belongs on this till and not the others: the register is where
         * the shop's trade happens, and the same figure repeated over the
         * transfer desk's drawer would read as a second lot of profit rather
         * than the same one.
         */}
        <CashBox refreshOn={salesMade} showProfit />

        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <div className="min-w-0">
              <h2 className="font-semibold text-slate-900">{t('Current sale')}</h2>
              {rate > 0 && (
                <p className="tnum text-[11px] text-slate-400">
                  1 USD = {Number(rate).toLocaleString('en-US')} LL
                </p>
              )}
            </div>

            {/*
              * What this sale is worth making, before it is agreed.
              *
              * Behind the same permission as the drawer's own profit: a cashier
              * who can see the margin on every line can work out what the shop
              * paid for everything on the shelf, and that is not theirs to know.
              * The owner haggling at the counter is exactly who needs it.
              */}
            {can('reports') && cart.length > 0 && (
              <span
                aria-label="What this sale makes"
                className={cx(
                  'tnum shrink-0 rounded-lg px-2 py-0.5 text-xs font-semibold',
                  cartProfit < 0 ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700',
                )}
                title={
                  unknownCost > 0
                    ? `${unknownCost} line${unknownCost === 1 ? '' : 's'} on this sale have no cost recorded, so this is understated`
                    : 'What this sale makes, before tax'
                }
              >
                {money(cartProfit)}
                {cartTakings > 0 && <span className="font-normal"> · {cartMargin}%</span>}
                {unknownCost > 0 && <span className="font-normal"> · ?</span>}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/*
             * What this till has already sold, and the way to put something
             * back. The sale somebody wants to correct is almost always the
             * last one, so the way to it belongs here rather than three screens
             * into the back office.
             */}
            <button
              onClick={() => setShowingSales(true)}
              title="This register's sales, to void or return"
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
            >
              <ReceiptIcon size={13} /> {t('Sales')}
            </button>
            {/*
             * The shelf of parked sales, with its count on the face of it.
             * A held sale nobody can see is a held sale nobody finishes.
             */}
            {heldCount > 0 && (
              <button
                onClick={() => setHeldDialog('list')}
                className="flex items-center gap-1 rounded-lg bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-100"
              >
                <PauseCircle size={13} /> Held {heldCount}
              </button>
            )}
            {cart.length > 0 && (
              <>
                <button
                  onClick={() => setHeldDialog('hold')}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
                >
                  <PauseCircle size={13} /> {t('Hold')}
                </button>
                <button
                  onClick={() => {
                    setCart([]);
                    // The trade-in goes with it: a phone left attached to an
                    // emptied cart would be taken in against the next customer.
                    setTradeIn(null);
                  }}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 size={13} /> {t('Clear')}
                </button>
              </>
            )}
          </div>
        </div>

        {/*
          * The customer, and the four things that start at the counter rather
          * than on the shelf: a phone bought in, a phone taken for repair, a SIM
          * found by its number, and credit that does not exist until it is sent.
          *
          * One row of icons rather than two rows of labelled buttons. They are
          * pressed a handful of times a day between them and each has a function
          * key on it; the cart underneath is read on every single sale, and it
          * was the cart that was losing the argument for space.
          */}
        <div className="flex items-center gap-1.5 border-b border-slate-100 px-3 py-2">
          <div className="min-w-0 flex-1">
            <CustomerPicker customer={customer} onChange={setCustomer} />
          </div>
          {[
            /*
             * One button, two jobs, decided by the cart.
             *
             * With something in it the customer is standing there swapping a
             * phone, so what they hand over comes off this sale. With an empty
             * cart it is an ordinary purchase — somebody selling the shop a
             * phone and walking out with the money.
             */
            [
              HandCoins,
              cart.length > 0 ? 'Part-exchange' : 'Buy in',
              cart.length > 0
                ? 'Take their old phone off this sale'
                : 'Buy a used handset from a customer',
              () => setBuyingHandset(true),
            ],
            [Wrench, 'Repair', 'Take a phone in for repair (F6)', () => setTakingRepair(true), 'repairs'],
            [Smartphone, 'Sell a SIM', 'Sell a SIM card (F7)', () => setSellingSim(true), 'sims'],
            [Send, 'Send credit', 'Send calling credit (F8)', () => setSendingCredit(true), 'credit'],
          ]
            // Nothing the shop did not buy: the till would refuse it anyway,
            // and a button that always fails is worse than no button.
            .filter(([, , , , module]) => !module || hasModule(module))
            .map(([Icon, name, tip, onClick]) => (
            <button
              key={name}
              onClick={onClick}
              title={tip}
              aria-label={name}
              className="flex shrink-0 items-center justify-center rounded-lg bg-slate-100 p-2 text-slate-600 transition hover:bg-slate-200 hover:text-slate-900"
            >
              <Icon size={16} />
            </button>
          ))}
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
              title={t('No items yet')}
              description={t('Scan a barcode or tap a product to start the sale.')}
            />
          ) : (
            <ul className="space-y-1">
              {/*
                * Two columns, not four. A picture and then everything else,
                * stacked — because a name, a unit price, a stepper and a line
                * total side by side in a column this narrow leaves the name
                * about a hundred pixels, and "Chocolat…" is not what anybody
                * needs to read off a cart.
                */}
              {cart.map((item) => (
                <li key={item.lineKey} className="flex gap-2.5 rounded-xl px-2 py-2 hover:bg-slate-50">
                  <ProductThumb product={item} size="sm" className="mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
                        {item.name}
                      </p>
                      <span
                        className={cx(
                          'tnum shrink-0 text-sm font-semibold',
                          item.isGift ? 'text-slate-300 line-through' : 'text-slate-900',
                        )}
                      >
                        {money(item.price * item.quantity)}
                      </span>
                    </div>

                    <div className="flex items-baseline gap-2 text-[11px] text-slate-400">
                      {/*
                        * The price is a button, because at this counter it is
                        * a question rather than a fact. A gift line is already
                        * at nothing and credit is priced by the carrier, so
                        * neither is ours to argue with.
                        */}
                      {item.isGift || item.creditSend ? (
                        <span className="tnum min-w-0 flex-1 truncate">
                          {money(item.price)} each
                          {rate > 0 && <> · {lbp(toLbp(item.price))}</>}
                        </span>
                      ) : (
                        <button
                          onClick={() => setPricing(item)}
                          title={t('Change the price for this sale')}
                          className={cx(
                            'tnum min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left transition',
                            'hover:bg-slate-100 hover:text-slate-700',
                            item.listPrice != null && item.listPrice !== item.price
                              ? 'font-medium text-amber-700'
                              : 'underline decoration-dotted underline-offset-2',
                          )}
                        >
                          {money(item.price)} each
                          {rate > 0 && <> · {lbp(toLbp(item.price))}</>}
                          {item.listPrice != null && item.listPrice !== item.price && (
                            <> · was {money(item.listPrice)}</>
                          )}
                        </button>
                      )}
                      {rate > 0 && (
                        <span className="tnum shrink-0">{lbp(toLbp(item.price * item.quantity))}</span>
                      )}
                    </div>

                    {item.imei && (
                      <p className="truncate font-mono text-[11px] text-slate-400">{item.imei}</p>
                    )}

                    {item.noCreditSetUp && (
                      <p className="mt-0.5 text-[11px] leading-snug text-amber-700">
                        No credit will reach a carrier — set it up under Cards
                      </p>
                    )}

                    <div className="mt-1 flex items-center gap-1">
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
                      <button
                        onClick={() => toggleGift(item.lineKey)}
                        className={cx(
                          'ml-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition',
                          item.isGift
                            ? 'bg-brand-50 text-brand-700'
                            : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600',
                        )}
                      >
                        {item.isGift ? t('★ Gift — free') : t('Make it a gift')}
                      </button>
                    </div>

                    {/*
                      * What is actually in the pack.
                      *
                      * A bundle is one line with one price, and a cashier
                      * handing it over has to put the right things in the bag.
                      * Listed under the line rather than behind a tap, because
                      * the moment it is needed is while the customer is
                      * standing there and the parts are on the shelf.
                      */}
                    {item.bundleOf?.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5 border-s-2 border-slate-100 ps-2.5">
                        {item.bundleOf.map((part) => (
                          <li key={part.productId} className="text-[11px] text-slate-500">
                            <span className="tnum text-slate-400">
                              {part.quantity * item.quantity}×
                            </span>{' '}
                            {part.name}
                          </li>
                        ))}
                      </ul>
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
              {t('Discount')}
            </label>
            <div className="flex items-center gap-1">
              <input
                id="discount"
                type="number"
                min="0"
                max={discountMode === 'percent' ? 100 : undefined}
                step={discountMode === 'lbp' ? 1000 : discountMode === 'usd' ? 0.5 : 1}
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                className="tnum h-8 w-24 rounded-lg bg-slate-100 px-2 text-right text-sm ring-1 ring-transparent focus:bg-white focus:ring-brand-600 focus:outline-none"
              />
              {/* Three buttons rather than a dropdown: it is three short words,
                  and on a touch screen a select is a menu to open and aim at. */}
              <div className="flex overflow-hidden rounded-lg bg-slate-100">
                {[
                  ['percent', '%'],
                  ['usd', '$'],
                  ['lbp', 'LL'],
                ].map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setDiscountMode(mode)}
                    aria-pressed={discountMode === mode}
                    className={cx(
                      'h-8 px-2 text-xs font-semibold transition',
                      discountMode === mode
                        ? 'bg-brand-600 text-white'
                        : 'text-slate-500 hover:text-slate-800',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">
                {t('Subtotal')} <span className="text-slate-400">· {itemCount} item{itemCount === 1 ? '' : 's'}</span>
              </dt>
              <dd className="tnum text-slate-700">{money(subtotal)}</dd>
            </div>
            {discountAmount > 0 && (
              <div className="flex justify-between">
                <dt className="text-slate-500">Discount</dt>
                <dd className="tnum text-brand-700">−{money(discountAmount)}</dd>
              </div>
            )}
            {/* No tax means no line, rather than a line reading zero: a shop
                that does not charge it should not have to explain a nought on
                every receipt it hands over. */}
            {taxRate > 0 && (
              <div className="flex justify-between">
                <dt className="text-slate-500">
                  {t(taxName)} ({(taxRate * 100).toFixed(taxRate * 100 % 1 ? 2 : 0)}%)
                </dt>
                <dd className="tnum text-slate-700">{money(tax)}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between border-t border-slate-100 pt-2">
              <dt className="font-semibold text-slate-900">{t('Total')}</dt>
              {/*
                * Keyed on the figure itself, so the emphasis replays whenever
                * the number changes and at no other time.
                *
                * The one place in the app worth animating a value: this is what
                * the customer is about to be asked for, it changes on every
                * scan, and a total that silently becomes a different total is
                * how the wrong amount gets read out.
                */}
              <dd
                key={total}
                className="animate-value-bump origin-right text-2xl font-semibold text-slate-900"
              >
                {money(total)}
              </dd>
            </div>

            {/*
              * The old phone, as a line of its own under the total.
              *
              * Not folded into the discount: a discount is the shop giving
              * money away, and this is the shop buying something. Keeping them
              * apart is what lets the receipt, the day's takings and the margin
              * all still mean what they say.
              */}
            {tradeIn && (
              <div className="flex items-start justify-between gap-2 rounded-lg bg-amber-50 px-2 py-1.5">
                <dt className="min-w-0 text-amber-900">
                  {t('Traded in')}
                  <span className="block truncate text-xs text-amber-700">
                    {tradeIn.modelName} · {tradeIn.imei}
                  </span>
                  <button
                    type="button"
                    onClick={() => setTradeIn(null)}
                    className="text-xs font-medium text-amber-800 underline"
                  >
                    {t('Take it off')}
                  </button>
                </dt>
                <dd className="tnum shrink-0 font-semibold text-amber-900">
                  −{money(tradeInValue)}
                </dd>
              </div>
            )}

            {tradeIn && (
              <div className="flex items-baseline justify-between border-t border-slate-100 pt-2">
                <dt className="font-semibold text-slate-900">
                  {owedToCustomer > 0 ? t('You pay the customer') : t('To pay')}
                </dt>
                <dd
                  className={cx(
                    'text-2xl font-semibold',
                    owedToCustomer > 0 ? 'text-red-700' : 'text-slate-900',
                  )}
                >
                  {money(owedToCustomer > 0 ? owedToCustomer : due)}
                </dd>
              </div>
            )}

            {rate > 0 && (
              <div className="flex items-baseline justify-between">
                <dt className="text-xs text-slate-400">{t('In LBP')}</dt>
                <dd className="tnum text-base font-medium text-slate-600">
                  {lbp(toLbp(owedToCustomer > 0 ? owedToCustomer : due))}
                </dd>
              </div>
            )}
          </dl>

          <Button
            size="xl"
            className="mt-4 w-full"
            disabled={cart.length === 0}
            variant={owedToCustomer > 0 ? 'danger' : undefined}
            onClick={() => (owedToCustomer > 0 ? payTheCustomer() : setPaymentOpen(true))}
          >
            {owedToCustomer > 0
              ? `${t('Pay the customer')} ${money(owedToCustomer)}`
              : `${t('Charge')} ${money(due)}`}
          </Button>
          <p className="mt-2 text-center text-[11px] text-slate-400">
            <kbd className="rounded bg-slate-100 px-1 font-sans">F2</kbd> charge ·{' '}
            <kbd className="rounded bg-slate-100 px-1 font-sans">F3</kbd> hold ·{' '}
            <kbd className="rounded bg-slate-100 px-1 font-sans">F4</kbd> held sales ·{' '}
            <kbd className="rounded bg-slate-100 px-1 font-sans">F6</kbd> repair
            <br />
            <kbd className="rounded bg-slate-100 px-1 font-sans">F7</kbd> SIM ·{' '}
            <kbd className="rounded bg-slate-100 px-1 font-sans">F8</kbd> credit
          </p>
        </div>
      </aside>

      <PaymentSheet
        open={paymentOpen}
        total={due}
        customer={customer}
        submitting={submitting}
        onClose={() => setPaymentOpen(false)}
        onConfirm={handleConfirmPayment}
      />

      {pricing && (
        <LinePrice
          item={pricing}
          onClose={() => setPricing(null)}
          onSet={(price) => {
            setLinePrice(pricing.lineKey, price);
            setPricing(null);
          }}
        />
      )}

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
          /*
           * Nothing is saved by the dialog in this mode — it hands the phone
           * back here and the sale carries both. A trade-in written down
           * against a sale that then failed is a shop holding stock it never
           * bought.
           */
          saleTotal={total}
          onTakeAgainstSale={
            cart.length > 0
              ? (taken) => {
                  setTradeIn(taken);
                  setBuyingHandset(false);
                }
              : null
          }
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

      {heldDialog === 'hold' && (
        <HoldSaleDialog
          cart={cart}
          context={saleContext()}
          customer={customer}
          total={total}
          onClose={() => setHeldDialog(null)}
          onHeld={({ count }) => {
            // The counter is free again, so the screen has to be too.
            setCart([]);
            setDiscountValue(0);
            setDiscountMode('percent');
            setCustomer(null);
            // The old phone goes with it: a trade-in left attached to a cleared
            // counter would be taken in against the next customer.
            setTradeIn(null);
            setBuyer({ name: '', phone: '' });
            setAccounts([]);
            setHeldCount(count);
            setHeldDialog(null);
          }}
        />
      )}

      {heldDialog === 'list' && (
        <HeldSalesDialog
          onClose={() => setHeldDialog(null)}
          onCountChange={setHeldCount}
          onResume={({ held, issues, count }) => applyHeldSale(held, issues, count)}
        />
      )}

      {resumeIssues && <ResumeIssues issues={resumeIssues} onClose={() => setResumeIssues(null)} />}

      {takingRepair && <TakeInRepair onClose={() => setTakingRepair(false)} />}

      {showingSales && (
        <SittingSales
          onClose={() => setShowingSales(false)}
          /* A void or a return moves the drawer, so the panel above has to
             catch up the same way it does after a sale. */
          onChanged={() => setSalesMade((n) => n + 1)}
        />
      )}

      {sellingSim && (
        <SellSim
          onClose={() => setSellingSim(false)}
          onPicked={({ sim, price, buyer: who, idPhoto }) => {
            /*
             * A SIM never merges with anything: it is one card with one number,
             * and its own buyer.
             */
            setCart((prev) => [
              ...prev,
              {
                lineKey: `sim:${sim.id}`,
                productId: sim.product_id,
                unitId: sim.id,
                name: sim.product_name,
                imei: sim.msisdn,
                price,
                stock: 1,
                quantity: 1,
                idPhoto,
              },
            ]);
            if (who?.name || who?.phone) setBuyer({ name: who.name, phone: who.phone });
          }}
        />
      )}

      {sendingCredit && (
        <SendCredit
          onClose={() => setSendingCredit(false)}
          onPicked={({ walletId, carrierName, msisdn, amount, price, quote }) => {
            setCart((prev) => [
              ...prev,
              {
                lineKey: `credit:${Date.now()}`,
                productId: null,
                unitId: null,
                name: `${carrierName} credit — $${amount}`,
                imei: `${msisdn} · ${quote.smsCount} SMS`,
                price,
                stock: 1,
                quantity: 1,
                creditSend: { walletId, msisdn, amount },
              },
            ]);
          }}
        />
      )}

      {receipt && <Receipt receipt={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

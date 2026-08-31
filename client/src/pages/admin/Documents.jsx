import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  Check,
  ClipboardList,
  FileText,
  History,
  LayoutGrid,
  Pencil,
  Plus,
  Printer,
  Receipt,
  Tag,
  Trash2,
  TrendingUp,
  Truck,
} from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import Letterhead from '../../components/Letterhead';
import { useSettings, lbp } from '../../context/SettingsContext';
import { useAuth } from '../../context/AuthContext';
import ProductLineSearch, { AddFreeTextButton } from '../../components/ProductLineSearch';
import HistoryFilter from '../../components/HistoryFilter';
import { useHistoryFilter } from '../../lib/history';
import ProductQuickCreate from '../../components/ProductQuickCreate';
import PartyQuickCreate from '../../components/PartyQuickCreate';
import { A4, usePageSize } from '../../lib/pageSize';
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
  cx,
  money,
  useToast,
} from '../../components/ui';
import WhatsAppButton from '../../components/WhatsAppButton';

/** Each type's identity: icon, wording, and what confirming it will do. */
export const TYPE_META = {
  quotation: {
    label: 'Quotation',
    icon: FileText,
    tint: 'bg-violet-50 text-violet-700 ring-violet-200',
    active: 'bg-violet-600 text-white ring-violet-600',
    effect: 'An offer — nothing moves',
    party: 'customer',
  },
  sales_order: {
    label: 'Sales order',
    icon: ClipboardList,
    tint: 'bg-blue-50 text-blue-700 ring-blue-200',
    active: 'bg-blue-600 text-white ring-blue-600',
    effect: 'A commitment — nothing moves',
    party: 'customer',
  },
  sales_invoice: {
    label: 'Sales invoice',
    icon: Receipt,
    tint: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    active: 'bg-emerald-600 text-white ring-emerald-600',
    effect: 'Stock out, customer billed',
    party: 'customer',
  },
  purchase_invoice: {
    label: 'Purchase invoice',
    icon: Truck,
    tint: 'bg-amber-50 text-amber-700 ring-amber-200',
    active: 'bg-amber-600 text-white ring-amber-600',
    effect: 'Stock in, supplier owed',
    party: 'supplier',
  },
};

const STATUS_TONES = { draft: 'neutral', confirmed: 'good', cancelled: 'critical' };

function TypeIcon({ type, size = 16 }) {
  const Icon = TYPE_META[type]?.icon || FileText;
  return <Icon size={size} />;
}

/* ---------------------------------------------------------- create / edit */

/**
 * The same form creates a document and edits one.
 *
 * Editing keeps the type — the number already says what it is, and changing it
 * would change what the document does — so the type picker only appears when
 * creating.
 */
function DocumentForm({ existing, startAs = null, page = false, onClose, onSaved }) {
  const toast = useToast();
  const { rate, toLbp, taxRate } = useSettings();
  /*
   * Behind the same permission as the Profit screen and the drawer's profit
   * figure. A cashier writing a quotation for a customer should not be shown
   * the shop's margin on it — it is on screen at a counter, and the customer is
   * standing on the other side of it.
   */
  const { can } = useAuth();
  const canSeeProfit = can('reports');
  // Adding a contact is its own permission — the same one the Customers and
  // Suppliers screens sit behind. Offering a button that always 403s would be
  // worse than not offering one.
  const canAddParty = can('parties');
  const editing = !!existing;
  const doc = existing?.document;

  const [docType, setDocType] = useState(doc?.doc_type || startAs || 'purchase_invoice');
  const [parties, setParties] = useState([]);
  const [partyId, setPartyId] = useState(doc?.party_id ? String(doc.party_id) : '');
  const [products, setProducts] = useState([]);
  const [lines, setLines] = useState([]);
  const [discountPercent, setDiscountPercent] = useState(doc?.discount_percent ?? 0);
  /*
   * How the document is settled. `account` leaves the whole total owing; `full`
   * settles it at the counter; `part` takes something now and leaves the rest.
   * The amount is held as typed so a half-entered figure is never rounded away
   * mid-keystroke.
   */
  const [settleAs, setSettleAs] = useState(() => {
    if (!doc || !doc.paid_total) return 'account';
    return doc.outstanding <= 0 ? 'full' : 'part';
  });
  const [payMethod, setPayMethod] = useState(doc?.payment_method || 'cash');
  const [payCurrency, setPayCurrency] = useState(doc?.paid_lbp > 0 ? 'LBP' : 'USD');
  const [payAmount, setPayAmount] = useState(() => {
    if (!doc?.paid_total) return '';
    return String(doc.paid_lbp > 0 ? doc.paid_lbp : doc.paid_usd);
  });
  const [notes, setNotes] = useState(doc?.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [quickCreate, setQuickCreate] = useState(null);
  const [newParty, setNewParty] = useState(false);
  /*
   * What this customer was charged last time, product by product.
   *
   * A shop here does not have one price for a thing — it has a price for the
   * public and a price it quoted this man in March, and going back on the
   * second is how a regular stops being one. Asked once when the customer is
   * picked rather than once per line, and only for the documents that sell:
   * what a shop *pays* is on the purchase side and lives with the costs.
   */
  const [lastPrices, setLastPrices] = useState({});

  /*
   * Whether this document is priced for the trade.
   *
   * The same fact as the switch on the register: a shop here has a price for
   * the public and a price for the man who runs the repair place two streets
   * over, and which one applies is a fact about the customer rather than about
   * any one line. A quotation to another shop is priced trade all the way
   * down, and retyping every line by hand is how a figure gets missed.
   *
   * Only for what the shop sells. A purchase invoice is already priced at what
   * the shop *pays*, and a trade price on it would be two answers to the same
   * question.
   */
  const [trade, setTrade] = useState(false);

  const meta = TYPE_META[docType];
  const partyType = meta.party;
  const isInvoice = docType.endsWith('invoice');
  const sells = docType !== 'purchase_invoice';
  /*
   * Which figure off the product a new line starts at.
   *
   * `wholesale_price` is null for most of a catalogue, and the reads below all
   * fall back to `price` — which is the behaviour that matters: switching a
   * document to trade must not price everything without a trade price at zero.
   */
  const priceField = !sells ? 'cost' : trade ? 'wholesale_price' : 'price';

  const loadProducts = useCallback(
    () => api.get('/products').then((res) => setProducts(res.data.products.filter((p) => p.active))),
    [],
  );

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  /* Picking a different type means a different list to choose from. */
  const lastPartyType = useRef(partyType);
  useEffect(() => {
    if (lastPartyType.current !== partyType) {
      lastPartyType.current = partyType;
      setPartyId('');
    }
    api.get(`/${partyType}s`).then((res) => setParties(res.data.parties));
  }, [partyType]);

  /*
   * Lines carry the whole product so the row can show its thumbnail, but the
   * saved document only stores an id — so they are rebuilt once the catalogue
   * has loaded. A product archived since is kept as a free-text line rather
   * than dropped, which would silently change the document.
   */
  useEffect(() => {
    if (!editing || products.length === 0) return;
    setLines(
      existing.items.map((item, i) => {
        const product = products.find((p) => p.id === item.product_id) || null;
        return {
          key: `e${item.id ?? i}`,
          product,
          name: item.name,
          quantity: String(item.quantity),
          price: String(item.price),
        };
      }),
    );
  }, [editing, existing, products]);

  /*
   * What this customer paid last time, fetched when they are picked.
   *
   * Nothing is applied automatically — the shop may well have put its prices
   * up since, and quietly re-pricing a line to a figure from March would be
   * worse than not knowing. It is shown beside the price, with one tap to use
   * it, which is the decision the person writing the invoice is actually
   * making.
   */
  useEffect(() => {
    if (partyType !== 'customer' || !partyId) {
      setLastPrices({});
      return;
    }
    let live = true;
    api
      .get(`/customers/${partyId}/last-prices`)
      .then((res) => live && setLastPrices(res.data.prices || {}))
      // A customer with no history is the common case, and an error here must
      // not stop an invoice being written.
      .catch(() => live && setLastPrices({}));
    return () => {
      live = false;
    };
  }, [partyType, partyId]);

  /*
   * Changing which figure the lines are priced from re-prices them — switching
   * between a cost-based and a price-based type, and switching a selling
   * document between retail and trade.
   *
   * The first run is skipped so opening an edit form does not overwrite the
   * prices the document was actually agreed at.
   */
  const lastPriceField = useRef(priceField);
  useEffect(() => {
    if (lastPriceField.current === priceField) return;
    lastPriceField.current = priceField;
    setLines((prev) =>
      prev.map((l) => (l.product ? { ...l, price: String(l.product[priceField] ?? l.product.price ?? 0) } : l)),
    );
  }, [priceField]);

  /*
   * Typing in a delivery, without the mouse.
   *
   * The loop a shop actually performs is: find the product, say how many, say
   * what it cost, find the next product. Every one of those was a click —
   * search, then reach for the quantity box, then reach for the price box,
   * then reach back to the search. Twenty lines off a supplier's note is sixty
   * reaches for a mouse that is usually behind the till roll.
   *
   * So: picking a product puts the cursor in that line's quantity with the
   * figure selected, Enter moves to the price, and Enter again comes back to
   * the search for the next one. Hands never leave the keyboard, and a barcode
   * scanner — which is a keyboard that types a number and presses Enter —
   * lands in exactly the same loop.
   */
  /* Arrived with the kind already chosen, so the tiles are a smaller thing. */
  const compactTypes = Boolean(startAs) && !editing;

  const searchRef = useRef(null);
  const formRef = useRef(null);
  const [focusLine, setFocusLine] = useState(null);

  const fieldOf = (key, field) =>
    formRef.current?.querySelector(`[data-line="${CSS.escape(key)}"][data-field="${field}"]`);

  useEffect(() => {
    if (!focusLine) return;
    const box = fieldOf(focusLine, 'quantity');
    if (box) {
      box.focus();
      /* Selected, not appended to: the line arrives saying 1 and what the shop
         is about to type is how many there really are. */
      box.select();
    }
    setFocusLine(null);
  }, [focusLine, lines.length]);

  /** Enter walks the line: quantity to price, price back to the search. */
  function onLineKey(e, key, field) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (field === 'quantity') {
      const price = fieldOf(key, 'price');
      if (price) {
        price.focus();
        price.select();
        return;
      }
    }
    searchRef.current?.focus();
  }

  function addProduct(product) {
    setLines((prev) => {
      const existing = prev.findIndex((l) => l.product?.id === product.id);
      if (existing !== -1) {
        /* Scanned twice: the count goes up, and the cursor still lands on it,
           because the next thing anybody does is correct that count. */
        setFocusLine(prev[existing].key);
        return prev.map((l, i) =>
          i === existing ? { ...l, quantity: String(Number(l.quantity || 0) + 1) } : l,
        );
      }
      const key = `p${product.id}-${Date.now()}`;
      setFocusLine(key);
      return [
        ...prev,
        {
          key,
          product,
          name: product.name,
          quantity: '1',
          price: String(product[priceField] ?? product.price ?? 0),
        },
      ];
    });
  }

  function addFreeText() {
    setLines((prev) => [
      ...prev,
      { key: `f${Date.now()}`, product: null, name: '', quantity: '1', price: '' },
    ]);
  }

  const updateLine = (key, patch) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const priced = lines.map((l) => {
    const typed = Number(l.price) || 0;
    /*
     * A delivery that costs more than the last one.
     *
     * The moment to notice a supplier's price going up is while the invoice is
     * being typed, with the paper still in your hand — not at the end of the
     * month when the margin has already gone. It is a flag rather than a
     * refusal: prices do go up, and the shop still has to book the delivery in.
     */
    const was = l.product?.last_cost;
    const dearer =
      docType === 'purchase_invoice' && was != null && typed > was + 0.005 ? was : null;

    // And on the way out: what this customer was charged last time.
    const before = l.product ? lastPrices[l.product.id] : null;
    return {
      ...l,
      lineTotal: (Number(l.quantity) || 0) * typed,
      dearer,
      lastPaid: partyType === 'customer' && before ? before : null,
    };
  });
  const dearerLines = priced.filter((l) => l.dearer !== null && l.product);
  const subtotal = priced.reduce((sum, l) => sum + l.lineTotal, 0);
  const discount = subtotal * ((Number(discountPercent) || 0) / 100);
  const tax = (subtotal - discount) * taxRate;
  const total = subtotal - discount + tax;

  /*
   * What the shop makes on this document, while it is still being written.
   *
   * The moment to know whether a quotation is worth sending is before it is
   * sent — a discount agreed on the phone can quietly take a line below what
   * the phone cost, and finding that out at the end of the month is finding it
   * out too late.
   *
   * Costs come from the catalogue rather than from anything typed here, so
   * changing the selling price on a line moves the margin and nothing else.
   * Tax is left out of both halves: it is the government's, never the shop's,
   * and counting it as revenue would flatter every figure on this panel.
   */
  const costOf = (l) =>
    (Number(l.quantity) || 0) * (Number(l.product?.cost ?? l.cost ?? 0) || 0);
  const totalCost = priced.reduce((sum, l) => sum + costOf(l), 0);
  const revenue = subtotal - discount;
  const profit = revenue - totalCost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  /*
   * A line with no cost recorded is not a line with no cost.
   *
   * Counting it as zero would show the full price as profit, which is the one
   * wrong answer that looks like good news. So the panel says how many lines it
   * could not account for rather than quietly averaging them in.
   */
  const linesWithoutCost = priced.filter(
    (l) => l.lineTotal > 0 && !(Number(l.product?.cost ?? l.cost ?? 0) > 0),
  ).length;

  /*
   * What the payment comes to in dollars. A part payment is entered in whichever
   * currency actually changed hands, so pounds are converted here at the same
   * rate the server will use.
   */
  const partAmountUsd =
    payCurrency === 'LBP' && rate > 0 ? (Number(payAmount) || 0) / rate : Number(payAmount) || 0;
  const paidUsd = settleAs === 'account' ? 0 : settleAs === 'full' ? total : partAmountUsd;
  const outstanding = Math.max(0, total - paidUsd);
  const overpaid = paidUsd > total + 0.01;

  const linesValid =
    lines.length > 0 &&
    lines.every((l) => (l.product || l.name.trim()) && Number(l.quantity) > 0 && Number(l.price) >= 0);
  const paymentValid = settleAs !== 'part' || (partAmountUsd > 0 && !overpaid);
  const valid = partyId && linesValid && paymentValid;

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);

    // Paying in full is sent as a dollar figure — the total is already in USD,
    // so converting it to pounds and back would only introduce rounding.
    const payments =
      settleAs === 'account'
        ? []
        : settleAs === 'full'
          ? [{ currency: 'USD', amount: Number(total.toFixed(2)) }]
          : [{ currency: payCurrency, amount: Number(payAmount) }];

    const payload = {
      partyId: Number(partyId),
      discountPercent: Number(discountPercent) || 0,
      payments,
      paymentMethod: payments.length ? payMethod : null,
      notes: notes || null,
      items: lines.map((l) => ({
        productId: l.product?.id ?? null,
        name: l.product ? undefined : l.name,
        quantity: Number(l.quantity),
        price: Number(l.price),
        imeis: l.imeis || null,
      })),
    };

    try {
      const res = editing
        ? await api.put(`/documents/${doc.id}`, payload)
        : await api.post('/documents', { docType, ...payload });
      toast(`${meta.label} ${res.data.document.doc_number} ${editing ? 'updated' : 'created'}`);
      onSaved(res.data.document.id);
    } catch (err) {
      setError(err.response?.data?.error || `Could not ${editing ? 'save' : 'create'} the document`);
    } finally {
      setSaving(false);
    }
  }

  const actions = (
    <>
      <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
        Cancel
      </Button>
      <Button type="submit" className="flex-1" disabled={!valid} loading={saving}>
        {editing ? 'Save changes' : 'Create draft'}
      </Button>
    </>
  );

  /*
   * The same form either way.
   *
   * Written once and given two frames rather than copied into a page and left
   * to drift from the dialog — a document form that behaves differently
   * depending on how it was opened is two forms to keep correct.
   */
  const body = (
        <form ref={formRef} onSubmit={submit} className="space-y-4">
          {/*
            * Type is picked by icon — it decides everything else on this form.
            *
            * Arriving from "New purchase invoice" the choice has already been
            * made, so the four tall tiles are a question being asked twice, and
            * the inch and a half they take is an inch and a half of the lines
            * below pushed off the screen. They shrink to a row of chips: still
            * there to change your mind, no longer the loudest thing on a form
            * about a delivery.
            */}
          {!editing && (
            <div
              className={cx(
                compactTypes ? 'flex flex-wrap gap-1.5' : 'grid grid-cols-2 gap-2 sm:grid-cols-4',
              )}
            >
              {Object.entries(TYPE_META).map(([key, m]) => {
                const Icon = m.icon;
                const selected = docType === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setDocType(key)}
                    className={cx(
                      'pressable rounded-xl ring-1 transition',
                      compactTypes
                        ? 'flex items-center gap-1.5 px-2.5 py-1.5 text-left'
                        : 'flex flex-col items-center gap-1.5 px-2 py-3 text-center',
                      selected ? m.active : `${m.tint} hover:brightness-95`,
                    )}
                  >
                    <Icon size={compactTypes ? 15 : 20} />
                    <span className="text-xs leading-tight font-medium">{m.label}</span>
                    {!compactTypes && (
                      <span
                        className={cx(
                          'text-[10px] leading-tight',
                          selected ? 'opacity-90' : 'opacity-70',
                        )}
                      >
                        {m.effect}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/*
           * Editing something already confirmed is a correction to the books,
           * not a draft change — say so before it is saved, not after.
           */}
          {editing && doc.status === 'confirmed' && (
            <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                {isInvoice ? (
                  <>
                    This {meta.label.toLowerCase()} is confirmed. Saving puts back the stock it moved and
                    clears the balance it created, then applies both again at the new figures — the
                    correction shows in the stock history and on the account.
                  </>
                ) : (
                  <>
                    This {meta.label.toLowerCase()} is confirmed, but a {meta.label.toLowerCase()} moves
                    neither stock nor money — only the paperwork changes.
                  </>
                )}
              </span>
            </p>
          )}

          <div>
            {/*
             * Beside the label, not flung to the far side of the dialog.
             *
             * `justify-between` put it a whole screen away from the picker it
             * belongs to, where it reads as a heading for the right-hand column
             * rather than as an action on this field. Sat next to the word it
             * qualifies, it is obviously part of choosing a supplier.
             */}
            <div className="mb-1.5 flex items-center gap-3">
              <label htmlFor="doc-party" className="block text-sm font-medium text-slate-700">
                {partyType === 'supplier' ? 'Supplier' : 'Customer'}
              </label>
              {canAddParty && (
                <button
                  type="button"
                  onClick={() => setNewParty(true)}
                  className="-my-1 flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm font-medium text-brand-700 transition hover:bg-brand-50"
                >
                  <Plus size={14} /> New {partyType}
                </button>
              )}
            </div>
            <select
              id="doc-party"
              value={partyId}
              onChange={(e) => setPartyId(e.target.value)}
              className="h-10 w-full rounded-lg bg-white px-3 text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none"
            >
              <option value="">Choose a {partyType}…</option>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-slate-700">Add items</p>
              {/*
                * Retail or trade for the whole document.
                *
                * Beside the search rather than at the top of the form, because
                * this is the decision that changes what the next line comes in
                * at — and the lines already written move with it, since the
                * price is a fact about who is being sold to rather than about
                * any one of them.
                *
                * Not offered on a purchase invoice: those are already priced at
                * what the shop pays.
                */}
              {sells && (
                <div className="flex shrink-0 rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
                  {[
                    ['Retail', false],
                    ['Wholesale', true],
                  ].map(([label, on]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setTrade(on)}
                      aria-pressed={trade === on}
                      className={
                        trade === on
                          ? 'rounded-md bg-white px-2.5 py-1 text-slate-900 shadow-sm'
                          : 'rounded-md px-2.5 py-1 text-slate-500 transition hover:text-slate-800'
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <ProductLineSearch
              products={products}
              priceField={priceField}
              onPick={addProduct}
              onCreateNew={(name) => setQuickCreate(name)}
              inputRef={searchRef}
              /* The cursor goes to the new line's quantity instead — see the
                 loop above addProduct. */
              keepFocus={false}
            />

            {/*
              * Said out loud as well as coloured in.
              *
              * The row tint answers "which line", and a shop working down a
              * supplier's invoice at speed needs "there is one" first — the
              * cost going up is the whole reason to look twice at a delivery
              * that otherwise just gets booked in.
              */}
            {dearerLines.length > 0 && (
              <div className="mt-3 flex gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-800 ring-1 ring-red-200">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <p>
                  <span className="font-medium">
                    {dearerLines.length === 1
                      ? `${dearerLines[0].product.name} costs more than last time.`
                      : `${dearerLines.length} lines cost more than last time.`}
                  </span>{' '}
                  {dearerLines
                    .map((l) => `${l.product.name} was ${money(l.dearer)}, now ${money(Number(l.price) || 0)}`)
                    .join('; ')}
                  . Book it in at the new price if that is what the supplier
                  charged — or tap the old figure to put the line back.
                </p>
              </div>
            )}

            {lines.length > 0 && (
              <div className="mt-3 overflow-hidden rounded-xl ring-1 ring-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Item</th>
                      <th className="w-20 px-2 py-2 text-right font-medium">Qty</th>
                      <th className="w-28 px-2 py-2 text-right font-medium">
                        {priceField === 'cost' ? 'Cost' : trade ? 'Wholesale' : 'Price'}
                      </th>
                      <th className="w-24 px-2 py-2 text-right font-medium">Total</th>
                      <th className="w-10 px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {priced.map((l) => (
                      <tr key={l.key} className={cx(l.dearer !== null && 'bg-red-50')}>
                        <td className="px-3 py-2">
                          {l.product ? (
                            <div className="flex items-center gap-2">
                              <ProductThumb product={l.product} size="sm" />
                              <div className="min-w-0 flex-1">
                                <p className="truncate font-medium text-slate-800">{l.product.name}</p>
                                <p className="text-xs text-slate-400">{l.product.sku}</p>
                                {/*
                                  * A delivery is where the IMEIs actually arrive
                                  * — off the boxes, in front of the supplier's
                                  * invoice. Booking them in from another screen
                                  * afterwards means doing the job twice.
                                  */}
                                {/*
                                  * Silence is the worst answer here. A phone
                                  * that was never flagged as serialised simply
                                  * showed no IMEI box and no reason, which
                                  * reads as the feature being broken.
                                  */}
                                {docType === 'purchase_invoice' && !l.product.tracks_units && (
                                  <p className="mt-1 text-xs text-slate-400">
                                    Counted as a quantity. To enter IMEIs, tick{' '}
                                    <span className="text-slate-500">Track each one by IMEI</span> on this
                                    product first.
                                  </p>
                                )}
                                {docType === 'purchase_invoice' && l.product.tracks_units && (
                                  <div className="mt-1.5">
                                    <textarea
                                      value={l.imeis || ''}
                                      onChange={(e) => updateLine(l.key, { imeis: e.target.value })}
                                      rows={Math.max(2, Math.min(Number(l.quantity) || 1, 6))}
                                      aria-label={`IMEIs for ${l.product.name}`}
                                      placeholder={'351234567890123, 351234567890124'}
                                      className="w-full rounded-lg bg-white px-2 py-1.5 font-mono text-xs ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none"
                                    />
                                    <p
                                      className={cx(
                                        'mt-0.5 text-xs',
                                        imeiCount(l.imeis) === (Number(l.quantity) || 0)
                                          ? 'text-brand-700'
                                          : 'text-amber-700',
                                      )}
                                    >
                                      {imeiCount(l.imeis)} of {Number(l.quantity) || 0} handsets — one per
                                      line, both numbers of a dual-SIM separated by a comma
                                    </p>
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : (
                            <input
                              value={l.name}
                              onChange={(e) => updateLine(l.key, { name: e.target.value })}
                              placeholder="Description (e.g. delivery)"
                              aria-label="Line description"
                              className="h-8 w-full rounded-lg bg-white px-2 text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none"
                            />
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <input
                            /*
                             * Text, not `number`. Browsers refuse `select()` on
                             * a number input — it silently does nothing — so
                             * the cursor landed on a quantity of 1 with the 1
                             * still there, and typing 12 gave 112. `inputMode`
                             * keeps the numeric keypad on a phone, which is the
                             * only thing `type=number` was buying here.
                             */
                            type="text"
                            inputMode="decimal"
                            value={l.quantity}
                            onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                            onKeyDown={(e) => onLineKey(e, l.key, 'quantity')}
                            data-line={l.key}
                            data-field="quantity"
                            aria-label={`Quantity for ${l.product?.name || l.name || 'line'}`}
                            className="h-8 w-full rounded-lg bg-white px-2 text-right text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-600 focus:outline-none"
                          />
                        </td>
                        <td className="px-2 py-2">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={l.price}
                            onChange={(e) => updateLine(l.key, { price: e.target.value })}
                            onKeyDown={(e) => onLineKey(e, l.key, 'price')}
                            data-line={l.key}
                            data-field="price"
                            aria-label={`Unit price for ${l.product?.name || l.name || 'line'}`}
                            className={cx(
                              'h-8 w-full rounded-lg bg-white px-2 text-right text-sm ring-1 focus:ring-2 focus:outline-none',
                              l.dearer !== null
                                ? 'ring-red-400 focus:ring-red-500'
                                : 'ring-edge focus:ring-brand-600',
                            )}
                          />

                          {/* What the supplier charged last time, and the way
                              back to it if the new figure was a slip. */}
                          {l.dearer !== null && (
                            <button
                              type="button"
                              onClick={() => updateLine(l.key, { price: String(l.dearer) })}
                              title="Put the line back to what it cost last time"
                              aria-label={`Was ${money(l.dearer)} last time — use that for ${l.product?.name || 'this line'}`}
                              className="mt-1 flex w-full items-center justify-end gap-1 text-right text-xs font-medium text-red-700 hover:underline"
                            >
                              <TrendingUp size={11} className="shrink-0" />
                              was {money(l.dearer)}
                            </button>
                          )}

                          {/* And on a sale: what this customer paid last time.
                              Never applied on its own — see the fetch above. */}
                          {l.dearer === null && l.lastPaid && (
                            <button
                              type="button"
                              onClick={() => updateLine(l.key, { price: String(l.lastPaid.price) })}
                              title={`Last charged on ${l.lastPaid.reference}`}
                              aria-label={`Last time ${money(l.lastPaid.price)} — use that for ${l.product?.name || 'this line'}`}
                              className={cx(
                                'mt-1 flex w-full items-center justify-end gap-1 text-right text-xs hover:underline',
                                Math.abs(l.lastPaid.price - (Number(l.price) || 0)) < 0.005
                                  ? 'text-slate-400'
                                  : 'font-medium text-brand-700',
                              )}
                            >
                              <History size={11} className="shrink-0" />
                              last {money(l.lastPaid.price)}
                            </button>
                          )}
                        </td>
                        <td className="tnum px-2 py-2 text-right font-medium text-slate-800">
                          {money(l.lineTotal)}
                        </td>
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                            aria-label="Remove line"
                            className="rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-2 flex items-center gap-1">
              <AddFreeTextButton onClick={addFreeText} />
              <button
                type="button"
                onClick={() => setQuickCreate('')}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-brand-700 transition hover:bg-brand-50"
              >
                <Plus size={14} /> New product
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <Input
                label="Discount %"
                type="number"
                min="0"
                max="100"
                value={discountPercent}
                onChange={(e) => setDiscountPercent(e.target.value)}
              />
              <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>

            <dl className="space-y-1 self-end rounded-xl bg-slate-50 px-4 py-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Subtotal</dt>
                <dd className="tnum text-slate-700">{money(subtotal)}</dd>
              </div>
              {discount > 0 && (
                <div className="flex justify-between">
                  <dt className="text-slate-500">Discount</dt>
                  <dd className="tnum text-slate-700">−{money(discount)}</dd>
                </div>
              )}
              {/* Nothing to show when the shop charges none — see Receipt.jsx. */}
              {tax > 0 && (
                <div className="flex justify-between">
                  <dt className="text-slate-500">Tax</dt>
                  <dd className="tnum text-slate-700">{money(tax)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold">
                <dt className="text-slate-900">Total</dt>
                <dd className="tnum text-slate-900">{money(total)}</dd>
              </div>
              {rate > 0 && (
                <div className="flex justify-between text-xs">
                  <dt className="text-slate-400">In LBP</dt>
                  <dd className="tnum text-slate-500">{lbp(toLbp(total))}</dd>
                </div>
              )}

              {/*
                * Behind the same permission as every other profit figure in the
                * app, and not on a purchase invoice — what you make on your own
                * buying is not a number that exists.
                */}
              {canSeeProfit && docType !== 'purchase_invoice' && lines.length > 0 && (
                <div className="mt-2 border-t border-slate-200 pt-2">
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Cost</dt>
                    <dd className="tnum text-slate-500">{money(totalCost)}</dd>
                  </div>
                  <div className="flex justify-between font-semibold">
                    <dt className={profit < 0 ? 'text-red-700' : 'text-emerald-700'}>
                      {profit < 0 ? 'Loss' : 'Profit'}
                    </dt>
                    <dd className={cx('tnum', profit < 0 ? 'text-red-700' : 'text-emerald-700')}>
                      {money(Math.abs(profit))}
                      <span className="ml-1.5 text-xs font-normal opacity-70">
                        {margin.toFixed(1)}%
                      </span>
                    </dd>
                  </div>
                  {linesWithoutCost > 0 && (
                    <p className="mt-1 text-xs text-amber-700">
                      {linesWithoutCost} line{linesWithoutCost === 1 ? '' : 's'} without a cost
                      price — the real profit is lower than this.
                    </p>
                  )}
                </div>
              )}
              {isInvoice && settleAs !== 'account' && (
                <>
                  <div className="flex justify-between border-t border-slate-200 pt-1">
                    <dt className="text-slate-500">Paid</dt>
                    <dd className="tnum text-slate-700">−{money(paidUsd)}</dd>
                  </div>
                  <div className="flex justify-between font-semibold">
                    <dt className={outstanding > 0 ? 'text-slate-900' : 'text-brand-700'}>
                      {outstanding > 0 ? 'Still owing' : 'Settled'}
                    </dt>
                    <dd className={cx('tnum', outstanding > 0 ? 'text-slate-900' : 'text-brand-700')}>
                      {money(outstanding)}
                    </dd>
                  </div>
                </>
              )}
            </dl>
          </div>

          {/*
           * Not everything is bought on credit. A delivery paid in cash on the
           * spot should leave no payable behind, and the money that went out
           * still has to be recorded.
           */}
          {isInvoice && (
            <fieldset className="rounded-xl ring-1 ring-slate-200">
              <legend className="ml-3 px-1 text-sm font-medium text-slate-700">
                {docType === 'purchase_invoice' ? 'How you paid the supplier' : 'How the customer paid'}
              </legend>

              <div className="space-y-3 px-3 pt-1 pb-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {[
                    ['account', 'On account', partyType === 'supplier' ? 'Pay later' : 'They pay later'],
                    ['full', 'Paid in full', 'Nothing left owing'],
                    ['part', 'Part paid', 'Some now, rest later'],
                  ].map(([key, label, hint]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSettleAs(key)}
                      aria-pressed={settleAs === key}
                      className={cx(
                        'rounded-lg px-3 py-2 text-left ring-1 transition',
                        settleAs === key
                          ? 'bg-brand-600 text-white ring-brand-600'
                          : 'bg-white text-slate-600 ring-slate-200 hover:ring-edge',
                      )}
                    >
                      <span className="block text-sm font-medium">{label}</span>
                      <span className={cx('block text-xs', settleAs === key ? 'opacity-90' : 'text-slate-400')}>
                        {hint}
                      </span>
                    </button>
                  ))}
                </div>

                {settleAs !== 'account' && (
                  <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">
                    <Select
                      label="Method"
                      name="payMethod"
                      value={payMethod}
                      onChange={(e) => setPayMethod(e.target.value)}
                    >
                      <option value="cash">Cash</option>
                      <option value="card">Card</option>
                      <option value="transfer">Bank transfer</option>
                    </Select>

                    {settleAs === 'part' && (
                      <>
                        <Input
                          label="Amount paid now"
                          name="payAmount"
                          type="number"
                          min="0"
                          step={payCurrency === 'LBP' ? '1000' : '0.01'}
                          value={payAmount}
                          onChange={(e) => setPayAmount(e.target.value)}
                          hint={
                            payCurrency === 'LBP' && partAmountUsd > 0 ? `= ${money(partAmountUsd)}` : undefined
                          }
                        />
                        <Select
                          label="Currency"
                          name="payCurrency"
                          value={payCurrency}
                          onChange={(e) => setPayCurrency(e.target.value)}
                        >
                          <option value="USD">USD</option>
                          <option value="LBP">LBP</option>
                        </Select>
                      </>
                    )}
                  </div>
                )}

                {overpaid && (
                  <p className="text-sm text-red-600">
                    That is more than the {money(total)} total. Use “Paid in full” instead.
                  </p>
                )}
              </div>
            </fieldset>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          {/*
            * At the end of the document, not floating over it.
            *
            * They were pinned to the bottom of the window so Save could not
            * scroll away — which sounds right and reads wrong: a bar sitting on
            * top of the invoice takes a strip of the screen on every line
            * typed, to save a keystroke on the one moment the form is finished.
            * The form is short enough to reach the end of, and the end of a
            * document is where anybody looks for the thing that files it.
            */}
          {page ? (
            <div className="mt-2 flex gap-2 border-t border-edge px-1 pt-4">{actions}</div>
          ) : (
            <ModalActions>{actions}</ModalActions>
          )}
        </form>
  );

  return (
    <>
      {page ? (
        body
      ) : (
        <Modal
          open
          onClose={onClose}
          title={editing ? `Edit ${doc.doc_number}` : 'New document'}
          subtitle={editing ? meta.label : undefined}
          size="xl"
        >
          {body}
        </Modal>
      )}

      <ProductQuickCreate
        open={quickCreate !== null}
        initialName={quickCreate || ''}
        onClose={() => setQuickCreate(null)}
        onCreated={(product) => {
          setQuickCreate(null);
          loadProducts();
          addProduct(product);
        }}
      />

      {/*
       * The new contact is put straight onto the document. Adding somebody and
       * then having to find them again in the list is the same trip to another
       * screen, only shorter.
       */}
      <PartyQuickCreate
        open={newParty}
        partyType={partyType}
        onClose={() => setNewParty(false)}
        onCreated={(party) => {
          setNewParty(false);
          setParties((prev) =>
            [...prev.filter((p) => p.id !== party.id), party].sort((a, b) =>
              a.name.localeCompare(b.name),
            ),
          );
          setPartyId(String(party.id));
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ detail */

function DocumentDetail({ id, onClose, onChanged, onDeleted }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { rate, toLbp } = useSettings();
  // A business paper goes on a sheet, whatever the till roll last printed.
  usePageSize(A4);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const load = useCallback(() => {
    api.get(`/documents/${id}`).then((res) => setData(res.data));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function remove() {
    setError('');
    setBusy(true);
    try {
      const res = await api.delete(`/documents/${id}`);
      toast(`${res.data.deleted} deleted`);
      onDeleted();
    } catch (err) {
      setConfirmingDelete(false);
      setError(err.response?.data?.error || 'Could not delete this document');
      setBusy(false);
    }
  }

  async function act(path, body, successMessage) {
    setError('');
    setBusy(true);
    try {
      await api.post(`/documents/${id}/${path}`, body);
      toast(successMessage);
      if (path === 'convert') {
        onChanged();
        onClose();
        return;
      }
      load();
      onChanged();
    } catch (err) {
      setError(err.response?.data?.error || 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <Modal open onClose={onClose} title="Loading…">
        <Skeleton className="h-40" />
      </Modal>
    );
  }

  const { document: doc, items, convertedTo } = data;
  const meta = TYPE_META[doc.doc_type];
  const canConvert = doc.doc_type === 'quotation' || doc.doc_type === 'sales_order';
  const liveSuccessor = convertedTo.find((c) => c.status !== 'cancelled');

  if (editing) {
    return (
      <DocumentForm
        existing={data}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          load();
          onChanged();
        }}
      />
    );
  }

  if (confirmingDelete) {
    return (
      <Modal open onClose={() => setConfirmingDelete(false)} title={`Delete ${doc.doc_number}?`}>
        <p className="text-sm text-slate-600">
          {doc.status === 'confirmed' && doc.doc_type.endsWith('invoice')
            ? `This ${meta.label.toLowerCase()} is confirmed, so it is reversed first — stock goes back and
               the balance is cleared — and then the paperwork is deleted. The reversal stays in the stock
               history and on the account.`
            : `The ${meta.label.toLowerCase()} and its ${items.length} line${
                items.length === 1 ? '' : 's'
              } will be deleted. Nothing else changes.`}
        </p>
        <p className="mt-2 text-sm text-slate-500">This cannot be undone.</p>

        <div className="mt-5 flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={() => setConfirmingDelete(false)}>
            Keep it
          </Button>
          <Button variant="danger" className="flex-1" loading={busy} onClick={remove}>
            <Trash2 size={15} /> Delete {doc.doc_number}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${meta.label} ${doc.doc_number}`}
      subtitle={`${doc.party_name || '—'} · ${doc.issue_date}`}
      size="lg"
    >
      <div className="print-document">
      {/*
        * The shop's own details at the top, because this is the copy that goes
        * to the customer — an invoice with no name, address or tax number on it
        * is not a document anybody would accept.
        */}
      <Letterhead
        variant="sheet"
        className="mb-4 border-b border-slate-200 pb-4"
        subtitle={`${meta.label} ${doc.doc_number}`}
      />

      {/*
        * Who it is for, and what it is, side by side.
        *
        * Every business paper in the world is laid out this way, and for a
        * reason: the person holding it looks left to check it is addressed to
        * them and right to find the number to quote back.
        */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-[12rem]">
          <p className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            {doc.party_type === 'supplier' ? 'From' : 'Billed to'}
          </p>
          <p className="mt-1 font-semibold text-slate-900">{doc.party_name || '—'}</p>
          {doc.party_phone && <p className="text-sm text-slate-600">{doc.party_phone}</p>}
          {doc.party_address && (
            <p className="max-w-[18rem] text-sm whitespace-pre-line text-slate-600">{doc.party_address}</p>
          )}
        </div>

        <dl className="min-w-[13rem] rounded-xl bg-slate-50 px-4 py-3 text-sm ring-1 ring-slate-200">
          <div className="flex justify-between gap-6">
            <dt className="text-slate-500">Number</dt>
            <dd className="font-mono font-medium text-slate-900">{doc.doc_number}</dd>
          </div>
          <div className="mt-1 flex justify-between gap-6">
            <dt className="text-slate-500">Date</dt>
            <dd className="tnum text-slate-800">{doc.issue_date}</dd>
          </div>
          {doc.valid_until && (
            <div className="mt-1 flex justify-between gap-6">
              <dt className="text-slate-500">Valid until</dt>
              <dd className="tnum text-slate-800">{doc.valid_until}</dd>
            </div>
          )}
          {rate > 0 && (
            <div className="mt-1 flex justify-between gap-6">
              <dt className="text-slate-500">Rate</dt>
              <dd className="tnum text-slate-800">{Number(rate).toLocaleString('en-US')} LL</dd>
            </div>
          )}
        </dl>
      </div>

      {/* The badges are the shop's own working state, not part of the paper. */}
      <div className="no-print mb-3 flex flex-wrap items-center gap-2">
        <span className={cx('rounded-lg p-1.5 ring-1', meta.tint)}>
          <TypeIcon type={doc.doc_type} size={15} />
        </span>
        <Badge tone={STATUS_TONES[doc.status]}>{doc.status}</Badge>
        {doc.doc_type.endsWith('invoice') &&
          (doc.outstanding <= 0 ? (
            <Badge tone="good">Paid {doc.payment_method}</Badge>
          ) : doc.paid_total > 0 ? (
            <Badge tone="warning">Part paid</Badge>
          ) : (
            <Badge tone="info">On account</Badge>
          ))}
        {doc.converted_from_number && (
          <span className="text-xs text-slate-400">from {doc.converted_from_number}</span>
        )}
        {convertedTo.map((c) => (
          <span key={c.id} className="text-xs text-slate-400">
            → {c.doc_number}
          </span>
        ))}
      </div>

      {/*
        * The lines.
        *
        * Numbered, because "the third one" is how somebody on the phone refers
        * to a line and counting down an unnumbered list is how the wrong one
        * gets changed. The code sits under the name rather than beside it: on a
        * narrow sheet a long name and a long SKU on one line wrap into each
        * other and neither can be read.
        *
        * Every figure is right-aligned and tabular, so the decimal points form
        * a column somebody can add up by eye — which is what a customer
        * checking an invoice actually does.
        */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] border-collapse text-sm">
          <thead>
            <tr className="border-y border-slate-300 text-left text-[11px] tracking-wide text-slate-500 uppercase">
              <th className="w-8 py-2 pr-2 text-right font-semibold">#</th>
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="w-16 py-2 px-2 text-right font-semibold">Qty</th>
              <th className="w-28 py-2 px-2 text-right font-semibold">Unit price</th>
              <th className="w-28 py-2 pl-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i, n) => (
              <tr key={i.id} className={cx('doc-row border-b border-slate-100', n % 2 === 1 && 'bg-slate-50/60')}>
                <td className="tnum py-2.5 pr-2 text-right align-top text-xs text-slate-400">{n + 1}</td>
                <td className="py-2.5 pr-3 align-top">
                  <p className="font-medium text-slate-900">{i.name}</p>
                  {i.sku && <p className="font-mono text-[11px] text-slate-400">{i.sku}</p>}
                </td>
                <td className="tnum py-2.5 px-2 text-right align-top text-slate-700">{i.quantity}</td>
                <td className="tnum py-2.5 px-2 text-right align-top text-slate-700">
                  {money(i.price)}
                  {rate > 0 && (
                    <span className="block text-[11px] text-slate-400">{lbp(toLbp(i.price))}</span>
                  )}
                </td>
                <td className="tnum py-2.5 pl-2 text-right align-top font-semibold text-slate-900">
                  {money(i.line_total)}
                  {rate > 0 && (
                    <span className="block text-[11px] font-normal text-slate-400">
                      {lbp(toLbp(i.line_total))}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        * Totals to the right, under the column they are the sum of, and half
        * the width of the sheet — a total spread across two hundred
        * millimetres reads as unrelated to the figures above it.
        */}
      <dl className="doc-totals mt-4 ml-auto w-full max-w-[20rem] space-y-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-slate-500">Subtotal</dt>
          <dd className="tnum text-slate-700">{money(doc.subtotal)}</dd>
        </div>
        {doc.discount > 0 && (
          <div className="flex justify-between">
            <dt className="text-slate-500">Discount</dt>
            <dd className="tnum text-slate-700">−{money(doc.discount)}</dd>
          </div>
        )}
        {/* What this document actually carried, not today's setting. */}
        {doc.tax > 0 && (
          <div className="flex justify-between">
            <dt className="text-slate-500">Tax</dt>
            <dd className="tnum text-slate-700">{money(doc.tax)}</dd>
          </div>
        )}
        <div className="mt-1 flex justify-between border-t-2 border-slate-800 pt-1.5 text-base font-semibold">
          <dt className="text-slate-900">Total</dt>
          <dd className="tnum text-slate-900">{money(doc.total)}</dd>
        </div>
        {rate > 0 && (
          <div className="flex justify-between text-xs">
            <dt className="text-slate-400">In LBP</dt>
            <dd className="tnum text-slate-500">{lbp(toLbp(doc.total))}</dd>
          </div>
        )}

        {doc.paid_total > 0 && (
          <>
            <div className="flex justify-between border-t border-slate-100 pt-1">
              <dt className="text-slate-500">
                Paid {doc.payment_method}
                {doc.paid_lbp > 0 && doc.paid_usd > 0 && ' (part in LBP)'}
              </dt>
              <dd className="tnum text-slate-700">−{money(doc.paid_total)}</dd>
            </div>
            <div className="flex justify-between font-semibold">
              <dt className={doc.outstanding > 0 ? 'text-slate-900' : 'text-brand-700'}>
                {doc.outstanding > 0 ? 'Still owing' : 'Settled in full'}
              </dt>
              <dd className={cx('tnum', doc.outstanding > 0 ? 'text-slate-900' : 'text-brand-700')}>
                {money(doc.outstanding)}
              </dd>
            </div>
          </>
        )}
      </dl>

      {doc.notes && (
        <div className="mt-5 border-t border-slate-200 pt-3">
          <p className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Notes</p>
          <p className="mt-1 text-sm whitespace-pre-line text-slate-600">{doc.notes}</p>
        </div>
      )}

      {/*
        * Somewhere to sign.
        *
        * A quotation is an offer until somebody accepts it, and a delivery is
        * disputed later by whoever did not sign for it. Two ruled lines cost
        * nothing and settle both arguments.
        */}
      <div className="doc-signature mt-10 hidden justify-between gap-10 text-xs text-slate-500 print:flex">
        <div className="flex-1 border-t border-slate-400 pt-1">
          {doc.doc_type === 'purchase_invoice' ? 'Received by' : 'For ' + (doc.party_name || 'the customer')}
        </div>
        <div className="flex-1 border-t border-slate-400 pt-1">For the shop</div>
      </div>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="no-print mt-5 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => window.print()}>
          <Printer size={15} /> Print
        </Button>

        {/*
          * Only what a customer is meant to receive. A purchase invoice is the
          * shop's own record of what it bought and at what price — the supplier
          * wrote it, and sending it back with the shop's margins attached is
          * not something to make one click away.
          */}
        {doc.party_type === 'customer' && (
          <WhatsAppButton path={`/documents/${doc.id}/whatsapp`} label="Send on WhatsApp" />
        )}

        {doc.status === 'draft' && (
          <Button loading={busy} onClick={() => act('confirm', null, `${doc.doc_number} confirmed`)}>
            <Check size={15} /> Confirm
          </Button>
        )}

        {canConvert && doc.status !== 'cancelled' && (
          <Button
            variant="secondary"
            loading={busy}
            onClick={() =>
              act(
                'convert',
                { docType: doc.doc_type === 'quotation' ? 'sales_order' : 'sales_invoice' },
                'Converted',
              )
            }
          >
            <ArrowRight size={15} />
            {doc.doc_type === 'quotation' ? 'To sales order' : 'To invoice'}
          </Button>
        )}

        {/* Labelling stock is the usual next step after receiving it. */}
        {doc.doc_type === 'purchase_invoice' && doc.status === 'confirmed' && (
          <Button variant="secondary" onClick={() => navigate(`/admin/labels?fromDocument=${doc.id}`)}>
            <Tag size={15} /> Print labels
          </Button>
        )}

        <Button variant="secondary" onClick={() => setEditing(true)}>
          <Pencil size={15} /> Edit
        </Button>

        {/*
         * "Void", not "Cancel" — in every other dialog Cancel means "close
         * without doing anything", and this one voids the document. Kept out of
         * the danger variant too, so Delete is the only red button on the row.
         */}
        {doc.status !== 'cancelled' && (
          <Button
            variant="secondary"
            loading={busy}
            onClick={() => act('cancel', null, `${doc.doc_number} cancelled`)}
          >
            <Ban size={15} /> Void
          </Button>
        )}

        {/*
         * Cancelling keeps the paperwork and reverses it; deleting removes it
         * altogether. A document another was created from stays put until that
         * one is dealt with, so the button says why rather than failing later.
         */}
        <Button
          variant="danger"
          disabled={!!liveSuccessor}
          title={liveSuccessor ? `${liveSuccessor.doc_number} was created from this one` : undefined}
          onClick={() => setConfirmingDelete(true)}
        >
          <Trash2 size={15} /> Delete
        </Button>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------- list */

/** How many handsets the typed block actually names. */
function imeiCount(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean).length;
}

/*
 * The four kinds, as they appear in an address.
 *
 * The rail links to a word rather than to `?filter=purchase_invoice`, because
 * these are places in the app now — a screen a shop opens on purpose, not a
 * filter it happens to have set — and a shop that bookmarks one should get the
 * same thing back tomorrow.
 */
const KIND_PATHS = {
  'purchase-invoices': 'purchase_invoice',
  'sales-invoices': 'sales_invoice',
  quotations: 'quotation',
  'sales-orders': 'sales_order',
};

export default function Documents() {
  const { kind } = useParams();
  const navigate = useNavigate();
  const only = KIND_PATHS[kind] || null;

  const [documents, setDocuments] = useState(null);
  const [counts, setCounts] = useState({});
  const [filter, setFilter] = useState('all');
  /*
   * Arrived at from somewhere else, looking for one document.
   *
   * The Sales screen lists invoices beside register sales and sends anybody who
   * presses one here, because this is where an invoice can actually be edited,
   * converted and reversed. Landing on an unfiltered list of four hundred and
   * being told to find it again would make that a dead end.
   */
  const [params] = useSearchParams();
  /*
   * Arriving with a number in hand means the period is not the question — the
   * invoice could be from March. So that landing starts on everything, and a
   * shop opening the screen normally still starts on this month.
   */
  const arrivedFor = params.get('number') || '';
  const history = useHistoryFilter(arrivedFor ? 'all' : 'month', arrivedFor);
  /*
   * `?document=` is how the new-document page hands back what it just wrote.
   * Read as the opening value rather than watched, so closing the paper does
   * not immediately reopen it — the address is where you arrived from, not a
   * standing instruction.
   */
  const [viewing, setViewing] = useState(() => {
    const arrived = Number(params.get('document'));
    return Number.isInteger(arrived) && arrived > 0 ? arrived : null;
  });

  const load = useCallback(() => {
    // Load everything once so the tiles can show per-type counts.
    api.get('/documents').then((res) => {
      const all = res.data.documents;
      setDocuments(all);
      setCounts(
        all.reduce((acc, d) => {
          acc[d.doc_type] = (acc[d.doc_type] || 0) + 1;
          return acc;
        }, {}),
      );
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /*
   * The address wins where there is one. `filter` stays for the unfiltered
   * screen, which still exists — the Sales list sends anybody looking for one
   * invoice there, and it must not be narrowed to a kind they did not pick.
   */
  const showing = only || filter;

  const visible = (documents || []).filter(
    (d) =>
      (showing === 'all' || d.doc_type === showing) &&
      history.within(d.issue_date || d.created_at) &&
      history.matches(d.doc_number, d.party_name, d.notes),
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={only ? `${TYPE_META[only].label}s` : 'Documents'}
        subtitle={only ? TYPE_META[only].effect : 'Quotations, sales orders, sales invoices and purchase invoices'}
        actions={
          /* On a screen that is one kind, the button already knows which —
             the type tiles on the form were a third choice for a job the shop
             had already made twice. It goes to a screen of its own now, so it
             can be reloaded, bookmarked and kept open in a tab. */
          <Button onClick={() => navigate(kind ? `/admin/documents/new/${kind}` : '/admin/documents/new')}>
            <Plus size={16} /> {only ? `New ${TYPE_META[only].label.toLowerCase()}` : 'New document'}
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {/* Type tiles double as the filter — on the screen that shows all four.
            On one kind's own screen the rail is already the switcher, and a
            second one that disagreed with the address would be worse than
            none. */}
        <div className={cx('mb-4 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5', only ? 'hidden' : 'grid')}>
          <button
            onClick={() => setFilter('all')}
            className={cx(
              'flex flex-col items-start gap-1.5 rounded-xl px-4 py-3 text-left ring-1 transition',
              filter === 'all'
                ? 'bg-slate-900 text-white ring-slate-900'
                : 'bg-white text-slate-600 ring-slate-200 hover:ring-edge',
            )}
          >
            <LayoutGrid size={18} />
            <span className="text-sm font-medium">All</span>
            <span className={cx('tnum text-xs', filter === 'all' ? 'opacity-80' : 'text-slate-400')}>
              {documents?.length ?? '—'}
            </span>
          </button>

          {Object.entries(TYPE_META).map(([key, m]) => {
            const Icon = m.icon;
            const selected = filter === key;
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={cx(
                  'pressable flex flex-col items-start gap-1.5 rounded-xl px-4 py-3 text-left ring-1 transition',
                  selected ? m.active : `bg-white ring-slate-200 hover:ring-edge ${m.tint.split(' ')[1]}`,
                )}
              >
                <Icon size={18} />
                <span className="text-sm leading-tight font-medium">{m.label}</span>
                <span className={cx('tnum text-xs', selected ? 'opacity-80' : 'text-slate-400')}>
                  {counts[key] ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        <HistoryFilter
          filter={history}
          label="Search documents"
          placeholder="Search by number, name or note…"
        />

        <Card>
          {!documents ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No documents"
              description="Create a quotation, invoice or purchase invoice to get started."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Number</th>
                  <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Type</th>
                  <th className="px-3 py-2.5 font-medium">Party</th>
                  <th className="hidden px-3 py-2.5 font-medium md:table-cell">Date</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {visible.map((d) => (
                  <tr key={d.id} onClick={() => setViewing(d.id)} className="cursor-pointer hover:bg-slate-50/60">
                    <td className="px-5 py-2.5 font-medium text-slate-800">{d.doc_number}</td>
                    <td className="hidden px-3 py-2.5 sm:table-cell">
                      <span className="flex items-center gap-1.5 text-slate-500">
                        <span className={cx('rounded p-1', TYPE_META[d.doc_type]?.tint)}>
                          <TypeIcon type={d.doc_type} size={13} />
                        </span>
                        {TYPE_META[d.doc_type]?.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-500">{d.party_name || '—'}</td>
                    <td className="hidden px-3 py-2.5 text-slate-500 md:table-cell">{d.issue_date}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={STATUS_TONES[d.status]}>{d.status}</Badge>
                    </td>
                    <td className="tnum px-5 py-2.5 text-right font-semibold text-slate-900">
                      {money(d.total)}
                      {/* What is still owed matters more than what it cost. */}
                      {d.doc_type.endsWith('invoice') && d.paid_total > 0 && (
                        <span
                          className={cx(
                            'block text-xs font-normal',
                            d.outstanding > 0 ? 'text-amber-600' : 'text-brand-600',
                          )}
                        >
                          {d.outstanding > 0 ? `${money(d.outstanding)} owing` : 'paid'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>


      {viewing && (
        <DocumentDetail
          id={viewing}
          onClose={() => setViewing(null)}
          onChanged={load}
          onDeleted={() => {
            setViewing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------- new, on its own page */

/**
 * Raising a document on a screen of its own.
 *
 * This used to be a dialog, and a dialog is the wrong shape for the job. An
 * invoice is not a question with two answers — it is a supplier, a stock, a
 * currency and twenty lines typed off a delivery note, with a total that has to
 * be checked against a piece of paper on the counter. In a box floating over
 * the list it gets a fraction of the window, scrolls inside its own little
 * frame, and cannot be linked to, bookmarked, reloaded or left open in a tab
 * while somebody goes to look something up.
 *
 * On a page it has the whole window, it survives a reload, and the browser's
 * own back button means what it says. Each kind has its own address, so the
 * rail can link straight to "new purchase invoice" and a shop can keep one
 * open per tab the way it keeps one paper pad per job.
 */
export function DocumentNew() {
  const { kind } = useParams();
  const navigate = useNavigate();

  const startAs = KIND_PATHS[kind] || null;
  /* Back to the list this was started from, not to the top of the section. */
  const back = kind ? `/admin/documents/${kind}` : '/admin/documents';

  // A business paper is laid out for a sheet, whatever the till roll printed.
  usePageSize(A4);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={startAs ? `New ${TYPE_META[startAs].label.toLowerCase()}` : 'New document'}
        subtitle={startAs ? 'Saved as a draft — nothing moves until it is posted' : 'Pick what it is'}
        actions={
          <Button variant="secondary" onClick={() => navigate(back)}>
            <ArrowLeft size={16} /> Back to the list
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-6xl">
          <Card className="p-4 sm:p-6">
            <DocumentForm
              page
              startAs={startAs}
              onClose={() => navigate(back)}
              /* Straight to what was just written, rather than back to a list
                 to hunt for it. */
              onSaved={(id) => navigate(`${back}?document=${id}`)}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Check,
  ClipboardList,
  FileText,
  LayoutGrid,
  Pencil,
  Plus,
  Printer,
  Receipt,
  Search,
  Tag,
  Trash2,
  Truck,
} from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { useSettings, lbp } from '../../context/SettingsContext';
import ProductLineSearch, { AddFreeTextButton } from '../../components/ProductLineSearch';
import ProductQuickCreate from '../../components/ProductQuickCreate';
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
  cx,
  money,
  useToast,
} from '../../components/ui';

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
function DocumentForm({ existing, onClose, onSaved }) {
  const toast = useToast();
  const { rate, toLbp } = useSettings();
  const editing = !!existing;
  const doc = existing?.document;

  const [docType, setDocType] = useState(doc?.doc_type || 'purchase_invoice');
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

  const meta = TYPE_META[docType];
  const partyType = meta.party;
  const isInvoice = docType.endsWith('invoice');
  const priceField = docType === 'purchase_invoice' ? 'cost' : 'price';

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
   * Switching between a cost-based and a price-based type re-prices the lines.
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

  function addProduct(product) {
    setLines((prev) => {
      const existing = prev.findIndex((l) => l.product?.id === product.id);
      if (existing !== -1) {
        return prev.map((l, i) =>
          i === existing ? { ...l, quantity: String(Number(l.quantity || 0) + 1) } : l,
        );
      }
      return [
        ...prev,
        {
          key: `p${product.id}-${Date.now()}`,
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

  const priced = lines.map((l) => ({
    ...l,
    lineTotal: (Number(l.quantity) || 0) * (Number(l.price) || 0),
  }));
  const subtotal = priced.reduce((sum, l) => sum + l.lineTotal, 0);
  const discount = subtotal * ((Number(discountPercent) || 0) / 100);
  const tax = (subtotal - discount) * 0.08;
  const total = subtotal - discount + tax;

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

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={editing ? `Edit ${doc.doc_number}` : 'New document'}
        subtitle={editing ? meta.label : undefined}
        size="xl"
      >
        <form onSubmit={submit} className="space-y-4">
          {/* Type is picked by icon — it decides everything else on this form. */}
          {!editing && (
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(TYPE_META).map(([key, m]) => {
                const Icon = m.icon;
                const selected = docType === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setDocType(key)}
                    className={cx(
                      'flex flex-col items-center gap-1.5 rounded-xl px-2 py-3 text-center ring-1 transition',
                      selected ? m.active : `${m.tint} hover:brightness-95`,
                    )}
                  >
                    <Icon size={20} />
                    <span className="text-xs leading-tight font-medium">{m.label}</span>
                    <span className={cx('text-[10px] leading-tight', selected ? 'opacity-90' : 'opacity-70')}>
                      {m.effect}
                    </span>
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
            <label htmlFor="doc-party" className="mb-1.5 block text-sm font-medium text-slate-700">
              {partyType === 'supplier' ? 'Supplier' : 'Customer'}
            </label>
            <select
              id="doc-party"
              value={partyId}
              onChange={(e) => setPartyId(e.target.value)}
              className="h-10 w-full rounded-lg bg-white px-3 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
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
            <p className="mb-1.5 text-sm font-medium text-slate-700">Add items</p>
            <ProductLineSearch
              products={products}
              priceField={priceField}
              onPick={addProduct}
              onCreateNew={(name) => setQuickCreate(name)}
            />

            {lines.length > 0 && (
              <div className="mt-3 overflow-hidden rounded-xl ring-1 ring-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Item</th>
                      <th className="w-20 px-2 py-2 text-right font-medium">Qty</th>
                      <th className="w-28 px-2 py-2 text-right font-medium">
                        {priceField === 'cost' ? 'Cost' : 'Price'}
                      </th>
                      <th className="w-24 px-2 py-2 text-right font-medium">Total</th>
                      <th className="w-10 px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {priced.map((l) => (
                      <tr key={l.key}>
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
                                      className="w-full rounded-lg bg-white px-2 py-1.5 font-mono text-xs ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
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
                              className="h-8 w-full rounded-lg bg-white px-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                            />
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={l.quantity}
                            onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                            aria-label={`Quantity for ${l.product?.name || l.name || 'line'}`}
                            className="h-8 w-full rounded-lg bg-white px-2 text-right text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                          />
                        </td>
                        <td className="px-2 py-2">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={l.price}
                            onChange={(e) => updateLine(l.key, { price: e.target.value })}
                            aria-label={`Unit price for ${l.product?.name || l.name || 'line'}`}
                            className="h-8 w-full rounded-lg bg-white px-2 text-right text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                          />
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
              <div className="flex justify-between">
                <dt className="text-slate-500">Tax</dt>
                <dd className="tnum text-slate-700">{money(tax)}</dd>
              </div>
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
                <div className="grid grid-cols-3 gap-2">
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
                          : 'bg-white text-slate-600 ring-slate-200 hover:ring-slate-300',
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
                  <div className="grid grid-cols-3 items-start gap-3">
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

          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={!valid} loading={saving}>
              {editing ? 'Save changes' : 'Create draft'}
            </Button>
          </div>
        </form>
      </Modal>

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
    </>
  );
}

/* ------------------------------------------------------------------ detail */

function DocumentDetail({ id, onClose, onChanged, onDeleted }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { rate, toLbp } = useSettings();
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
      <div className="mb-3 flex flex-wrap items-center gap-2">
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

      <table className="w-full text-sm">
        <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
          <tr>
            <th className="py-1.5 font-medium">Item</th>
            <th className="py-1.5 text-right font-medium">Qty</th>
            <th className="py-1.5 text-right font-medium">Price</th>
            <th className="py-1.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {items.map((i) => (
            <tr key={i.id}>
              <td className="py-1.5 text-slate-700">
                {i.name}
                {i.sku && <span className="ml-1 text-xs text-slate-400">{i.sku}</span>}
              </td>
              <td className="tnum py-1.5 text-right text-slate-600">{i.quantity}</td>
              <td className="tnum py-1.5 text-right text-slate-600">{money(i.price)}</td>
              <td className="tnum py-1.5 text-right font-medium text-slate-800">{money(i.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-sm">
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
        <div className="flex justify-between">
          <dt className="text-slate-500">Tax</dt>
          <dd className="tnum text-slate-700">{money(doc.tax)}</dd>
        </div>
        <div className="flex justify-between text-base font-semibold">
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

      {doc.notes && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{doc.notes}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="no-print mt-5 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => window.print()}>
          <Printer size={15} /> Print
        </Button>

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

export default function Documents() {
  const [documents, setDocuments] = useState(null);
  const [counts, setCounts] = useState({});
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState(null);

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

  const term = search.trim().toLowerCase();
  const visible = (documents || []).filter(
    (d) =>
      (filter === 'all' || d.doc_type === filter) &&
      (!term ||
        d.doc_number.toLowerCase().includes(term) ||
        (d.party_name || '').toLowerCase().includes(term)),
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Documents"
        subtitle="Quotations, sales orders, sales invoices and purchase invoices"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> New document
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {/* Type tiles double as the filter. */}
        <div className="mb-4 grid grid-cols-5 gap-3">
          <button
            onClick={() => setFilter('all')}
            className={cx(
              'flex flex-col items-start gap-1.5 rounded-xl px-4 py-3 text-left ring-1 transition',
              filter === 'all'
                ? 'bg-slate-900 text-white ring-slate-900'
                : 'bg-white text-slate-600 ring-slate-200 hover:ring-slate-300',
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
                  'flex flex-col items-start gap-1.5 rounded-xl px-4 py-3 text-left ring-1 transition',
                  selected ? m.active : `bg-white ring-slate-200 hover:ring-slate-300 ${m.tint.split(' ')[1]}`,
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

        <Card>
          <div className="border-b border-slate-100 px-5 py-3">
            <div className="relative">
              <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by number or name…"
                className="h-9 w-full rounded-lg bg-slate-100 pr-3 pl-9 text-sm ring-1 ring-transparent transition focus:bg-white focus:ring-brand-600 focus:outline-none"
              />
            </div>
          </div>

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
                  <th className="px-3 py-2.5 font-medium">Type</th>
                  <th className="px-3 py-2.5 font-medium">Party</th>
                  <th className="px-3 py-2.5 font-medium">Date</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {visible.map((d) => (
                  <tr key={d.id} onClick={() => setViewing(d.id)} className="cursor-pointer hover:bg-slate-50/60">
                    <td className="px-5 py-2.5 font-medium text-slate-800">{d.doc_number}</td>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-1.5 text-slate-500">
                        <span className={cx('rounded p-1', TYPE_META[d.doc_type]?.tint)}>
                          <TypeIcon type={d.doc_type} size={13} />
                        </span>
                        {TYPE_META[d.doc_type]?.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-500">{d.party_name || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-500">{d.issue_date}</td>
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

      {creating && (
        <DocumentForm
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            load();
            setViewing(id);
          }}
        />
      )}

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

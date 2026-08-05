import { useEffect, useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import api from '../api';
import ProductQuickCreate from './ProductQuickCreate';
import { useSettings, lbp } from '../context/SettingsContext';
import { Button, Input, Modal, Select, cx, money, useToast } from './ui';

const CONDITIONS = [
  ['used', 'Used'],
  ['refurbished', 'Refurbished'],
  ['new', 'New — sealed'],
];

/**
 * Buy a handset over the counter.
 *
 * The mirror of a sale, and the form says so: money leaves the drawer, a phone
 * joins the shelf. The two figures the shop will care about later are what it
 * paid and which model it will be sold as, so those come first.
 */
export default function BuyHandsetModal({ onClose, onSaved }) {
  const toast = useToast();
  const { rate, toLbp } = useSettings();

  /*
   * The modal fetches its own catalogue so the register can open it without
   * having loaded one — a trade-in is taken at the counter, not from a screen
   * that happens to have the products to hand.
   */
  const [products, setProducts] = useState([]);
  const [modelTerm, setModelTerm] = useState('');
  const [creating, setCreating] = useState(null);

  const loadProducts = () =>
    api
      .get('/products', { params: { activeOnly: 'true' } })
      .then((res) => setProducts(res.data.products.filter((p) => p.tracks_units)));

  useEffect(() => {
    loadProducts();
  }, []);
  const [form, setForm] = useState({
    productId: '',
    imei: '',
    condition: 'used',
    paidUsd: '',
    paidLbp: '',
    sellerName: '',
    sellerPhone: '',
    note: '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // What the handset will have cost the shop, however the money went out.
  const cost =
    (Number(form.paidUsd) || 0) + (rate > 0 ? (Number(form.paidLbp) || 0) / rate : 0);
  const model = products.find((p) => p.id === Number(form.productId));
  const chosen = model;

  const matches = useMemo(() => {
    const t = modelTerm.trim().toLowerCase();
    return products.filter((p) => !t || p.name.toLowerCase().includes(t)).slice(0, 6);
  }, [products, modelTerm]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.post('/repairs/trade-ins', {
        ...form,
        productId: Number(form.productId),
        paidUsd: Number(form.paidUsd) || 0,
        paidLbp: Number(form.paidLbp) || 0,
      });
      toast(`${res.data.unit.imei} bought in at ${money(res.data.cost)}`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not take it in');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={saving ? undefined : onClose} title="Buy a handset" size="lg">
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label htmlFor="model" className="mb-1 block text-sm font-medium text-slate-700">
            Which model will you sell it as?
          </label>

          {chosen ? (
            <div className="flex items-center gap-2 rounded-xl bg-brand-50 px-3 py-2.5 ring-1 ring-brand-200">
              <span className="flex-1 font-medium text-brand-900">{chosen.name}</span>
              <span className="text-sm text-brand-700">sells at {money(chosen.price)}</span>
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, productId: '' }))}
                className="text-sm font-medium text-brand-700 underline"
              >
                change
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
                <input
                  id="model"
                  value={modelTerm}
                  onChange={(e) => setModelTerm(e.target.value)}
                  placeholder="Search the model, or type a new one…"
                  className="h-10 w-full rounded-xl bg-white pr-3 pl-9 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                />
              </div>

              {/*
                * A used phone often turns up that the shop has never stocked
                * new. Without a way to create the model here, the trade-in is
                * blocked on a trip to the catalogue and back.
                */}
              <ul className="mt-1.5 space-y-1">
                {matches.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setForm((f) => ({ ...f, productId: String(p.id) }));
                        setModelTerm('');
                      }}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-slate-50"
                    >
                      <span className="text-slate-700">{p.name}</span>
                      <span className="text-xs text-slate-400">{money(p.price)}</span>
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    onClick={() => setCreating(modelTerm.trim())}
                    className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-brand-700 transition hover:bg-brand-50"
                  >
                    <Plus size={14} />
                    {modelTerm.trim() ? `New model “${modelTerm.trim()}”` : 'New model…'}
                  </button>
                </li>
              </ul>
            </>
          )}

          <p className="mt-1 text-xs text-slate-500">
            Only models tracked by IMEI can be bought in — a used phone is a specific device.
          </p>
        </div>

        <Input
          label="IMEI"
          value={form.imei}
          onChange={set('imei')}
          required
          className="font-mono"
          hint="Both numbers of a dual-SIM, separated by a comma"
        />
        <div>
          <label htmlFor="cond" className="mb-1 block text-sm font-medium text-slate-700">
            Condition
          </label>
          <Select id="cond" value={form.condition} onChange={set('condition')}>
            {CONDITIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>

        <Input
          label="Paid in dollars"
          type="number"
          step="0.01"
          min="0"
          value={form.paidUsd}
          onChange={set('paidUsd')}
        />
        <Input
          label="Paid in pounds"
          type="number"
          step="1000"
          min="0"
          value={form.paidLbp}
          onChange={set('paidLbp')}
        />

        {cost > 0 && (
          <p className="col-span-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
            Costs the shop <span className="font-semibold">{money(cost)}</span>
            {rate > 0 && <span className="text-slate-400"> · {lbp(toLbp(cost))}</span>}
            {model && (
              <span className={cx('ml-1', model.price > cost ? 'text-brand-700' : 'text-red-600')}>
                {'— '}
                {model.price > cost ? `${money(model.price - cost)} margin` : 'above what it sells for'}
              </span>
            )}
          </p>
        )}

        <Input label="Seller's name" value={form.sellerName} onChange={set('sellerName')} />
        <Input label="Phone number" value={form.sellerPhone} onChange={set('sellerPhone')} />

        <Input
          label="Note"
          value={form.note}
          onChange={set('note')}
          className="col-span-2"
          placeholder="Battery health, scratches, what came with it…"
        />

        {error && (
          <p className="col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        <p className="col-span-2 text-xs text-slate-500">
          The money comes out of the open cashbox, so the count at close still balances.
        </p>

        <div className="col-span-2 flex gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving} disabled={!form.productId || !form.imei}>
            Buy it in
          </Button>
        </div>
      </form>

      {creating !== null && (
        <ProductQuickCreate
          open
          initialName={creating}
          trackUnits
          onClose={() => setCreating(null)}
          onCreated={async (product) => {
            setCreating(null);
            await loadProducts();
            setForm((f) => ({ ...f, productId: String(product.id) }));
            setModelTerm('');
          }}
        />
      )}
    </Modal>
  );
}


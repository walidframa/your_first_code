import { useCallback, useEffect, useState } from 'react';
import { HandCoins, Plus } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { useSettings, lbp } from '../../context/SettingsContext';
import { Button, Card, EmptyState, Input, Modal, Select, Skeleton, cx, money, useToast } from '../../components/ui';

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
function BuyModal({ products, onClose, onSaved }) {
  const toast = useToast();
  const { rate, toLbp } = useSettings();
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
          <Select id="model" value={form.productId} onChange={set('productId')} required>
            <option value="">Choose a product…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · sells at {money(p.price)}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-slate-500">
            Only products tracked by IMEI can be bought in — a used phone is a specific device.
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
    </Modal>
  );
}

export default function TradeIns() {
  const [rows, setRows] = useState(null);
  const [products, setProducts] = useState([]);
  const [buying, setBuying] = useState(false);

  const load = useCallback(async () => {
    const [list, prods] = await Promise.all([
      api.get('/repairs/trade-ins/list'),
      api.get('/products', { params: { activeOnly: 'true' } }),
    ]);
    setRows(list.data.tradeIns);
    setProducts(prods.data.products.filter((p) => p.tracks_units));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Trade-ins"
        subtitle="Handsets bought over the counter"
        actions={
          <Button onClick={() => setBuying(true)} disabled={products.length === 0}>
            <Plus size={16} /> Buy a handset
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {products.length === 0 && rows !== null && (
          <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
            No product is tracked by IMEI yet. Tick <strong>Track each one by IMEI</strong> on the models
            you buy and sell, and they become available here.
          </p>
        )}

        {!rows ? (
          <Skeleton className="h-64" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={HandCoins}
            title="Nothing bought in yet"
            description="A handset bought over the counter joins the shelf and sells like any other."
          />
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Bought</th>
                  <th className="px-3 py-2 font-medium">Handset</th>
                  <th className="px-3 py-2 font-medium">From</th>
                  <th className="px-3 py-2 text-right font-medium">Paid</th>
                  <th className="px-5 py-2 font-medium">Since then</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className="px-5 py-2.5 text-slate-500">{String(t.created_at).slice(0, 10)}</td>
                    <td className="px-3 py-2.5">
                      <p className="text-slate-800">{t.product_name}</p>
                      <p className="font-mono text-xs text-slate-400">{t.imei}</p>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">
                      {t.seller_name || '—'}
                      {t.seller_phone && (
                        <span className="block text-xs text-slate-400">{t.seller_phone}</span>
                      )}
                    </td>
                    <td className="tnum px-3 py-2.5 text-right text-slate-700">
                      {t.paid_usd > 0 && money(t.paid_usd)}
                      {t.paid_lbp > 0 && (
                        <span className="block text-xs text-slate-400">{lbp(t.paid_lbp)}</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5">
                      <span
                        className={cx(
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          t.unit_status === 'sold'
                            ? 'bg-slate-100 text-slate-500'
                            : 'bg-brand-50 text-brand-700',
                        )}
                      >
                        {t.unit_status === 'sold' ? 'Sold on' : 'On the shelf'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {buying && (
        <BuyModal
          products={products}
          onClose={() => setBuying(false)}
          onSaved={() => {
            setBuying(false);
            load();
          }}
        />
      )}
    </div>
  );
}

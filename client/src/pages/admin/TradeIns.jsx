import { useCallback, useEffect, useState } from 'react';
import { HandCoins, Plus } from 'lucide-react';
import BuyHandsetModal from '../../components/BuyHandsetModal';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { lbp } from '../../context/SettingsContext';
import { Button, Card, EmptyState, Skeleton, cx, money } from '../../components/ui';

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
        <BuyHandsetModal
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

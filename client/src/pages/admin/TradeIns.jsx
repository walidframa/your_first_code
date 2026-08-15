import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, HandCoins, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import BuyHandsetModal from '../../components/BuyHandsetModal';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import HistoryFilter from '../../components/HistoryFilter';
import { useHistoryFilter } from '../../lib/history';
import { lbp } from '../../context/SettingsContext';
import {
  Button,
  Card,
  EmptyState,
  Modal,
  ModalActions,
  Skeleton,
  cx,
  money,
  useToast,
} from '../../components/ui';

/**
 * Look at the ID recorded against one purchase.
 *
 * Fetched as a blob rather than pointed at with an `<img src>`, because the
 * request needs the signed-in token on it and an image tag cannot carry one.
 * The object URL is revoked on the way out so the picture does not sit in the
 * browser's memory after the dialog is shut.
 *
 * Whether the person looking is allowed to is the server's business, not this
 * component's — it asks, and reports what it is told. Hiding the button instead
 * would only hide the refusal.
 */
function IdPhotoViewer({ tradeIn, onClose, onRemoved }) {
  const toast = useToast();
  const [src, setSrc] = useState(null);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    let url = null;
    let live = true;

    api
      .get(`/repairs/trade-ins/${tradeIn.id}/id-photo`, { responseType: 'blob' })
      .then((res) => {
        if (!live) return;
        url = URL.createObjectURL(res.data);
        setSrc(url);
      })
      .catch((err) => {
        if (!live) return;
        setError(
          err.response?.status === 403
            ? 'Only somebody who may reveal saved passwords can open a seller’s ID.'
            : 'That ID could not be opened.',
        );
      });

    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [tradeIn.id]);

  async function remove() {
    setRemoving(true);
    try {
      await api.delete(`/repairs/trade-ins/${tradeIn.id}/id-photo`);
      toast('The ID was deleted');
      onRemoved();
    } catch {
      toast('That could not be deleted', 'error');
      setRemoving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Seller’s ID"
      subtitle={`${tradeIn.seller_name || 'Unnamed seller'} · ${tradeIn.product_name} · ${String(
        tradeIn.created_at,
      ).slice(0, 10)}`}
    >
      {error ? (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</p>
      ) : src ? (
        /* Contained rather than stretched: an ID photographed portrait on a
           phone would otherwise run off the bottom of the screen. */
        <img
          src={src}
          alt="The seller’s ID"
          className="max-h-[70vh] w-full rounded-xl bg-slate-50 object-contain ring-1 ring-slate-200"
        />
      ) : (
        <Skeleton className="h-72" />
      )}

      <ModalActions>
        {src && (
          <Button variant="secondary" loading={removing} onClick={remove}>
            <Trash2 size={15} /> Delete the ID
          </Button>
        )}
        <Button className="flex-1" onClick={onClose}>
          Close
        </Button>
      </ModalActions>
    </Modal>
  );
}

export default function TradeIns() {
  const [rows, setRows] = useState(null);
  const [products, setProducts] = useState([]);
  // A handset bought in six months ago is exactly the one somebody comes
  // looking for, usually with an IMEI or a name and nothing else.
  const history = useHistoryFilter('month');
  const [buying, setBuying] = useState(false);
  // Which purchase's ID is on screen, if any.
  const [viewing, setViewing] = useState(null);

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

  const shown = (rows || []).filter(
    (t) =>
      history.within(t.created_at) &&
      history.matches(t.imei, t.product_name, t.seller_name, t.seller_phone),
  );

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

        <HistoryFilter
          filter={history}
          label="Search buy-ins"
          placeholder="Search an IMEI, a handset, who sold it…"
        />

        {!rows ? (
          <Skeleton className="h-64" />
        ) : shown.length === 0 ? (
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
                {shown.map((t) => (
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
                      {/*
                        * Whether the purchase is documented is the thing worth
                        * seeing down a column of them — the shop scanning this
                        * list is looking for the row that has nothing, not
                        * reading anybody's ID.
                        */}
                      {t.has_id_photo ? (
                        <button
                          onClick={() => setViewing(t)}
                          className="mt-0.5 flex w-fit items-center gap-1 rounded text-xs font-medium text-brand-700 underline-offset-2 hover:underline"
                        >
                          <BadgeCheck size={12} /> ID on file
                        </button>
                      ) : (
                        <span className="mt-0.5 flex items-center gap-1 text-xs text-amber-700">
                          <ShieldAlert size={12} /> no ID
                        </span>
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

      {viewing && (
        <IdPhotoViewer
          tradeIn={viewing}
          onClose={() => setViewing(null)}
          onRemoved={() => {
            setViewing(null);
            load();
          }}
        />
      )}

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

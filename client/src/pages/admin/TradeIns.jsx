import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, HandCoins, Pencil, Plus, ShieldAlert, Trash2, Undo2 } from 'lucide-react';
import BuyHandsetModal from '../../components/BuyHandsetModal';
import api from '../../api';
import { useLive } from '../../lib/live';
import PageHeader from '../../components/PageHeader';
import HistoryFilter from '../../components/HistoryFilter';
import { useHistoryFilter } from '../../lib/history';
import { lbp } from '../../context/SettingsContext';
import {
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  ModalActions,
  Select,
  Skeleton,
  cx,
  money,
  useToast,
} from '../../components/ui';
import { useConfirm } from '../../components/ConfirmProvider';

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
  const confirm = useConfirm();

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
    const agreed = await confirm({
      title: 'Delete this ID?',
      body: 'The photo of the seller\u2019s ID is what proves who the shop bought this handset from. It cannot be recovered.',
      confirmLabel: 'Delete the ID',
    });
    if (!agreed) return;

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

const CONDITIONS = [
  ['used', 'Used'],
  ['refurbished', 'Refurbished'],
  ['new', 'New'],
];

/**
 * Put a purchase right.
 *
 * A name typed wrong, a digit missing off the IMEI, a price agreed as $60 and
 * written as $75. While the handset is on the shelf everything is editable,
 * the money included, and the cashbox follows by the difference. Once it has
 * been sold on, only who sold it and the note can change.
 */
function EditTradeInDialog({ tradeIn, products, onClose, onSaved }) {
  const toast = useToast();
  const sold = tradeIn.unit_status === 'sold';
  const [form, setForm] = useState({
    productId: String(tradeIn.product_id ?? ''),
    imei: [tradeIn.imei, tradeIn.imei2].filter(Boolean).join(', '),
    condition: tradeIn.condition || 'used',
    paidUsd: String(tradeIn.paid_usd ?? 0),
    paidLbp: String(tradeIn.paid_lbp ?? 0),
    sellerName: tradeIn.seller_name || '',
    sellerPhone: tradeIn.seller_phone || '',
    note: tradeIn.note || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const body = { sellerName: form.sellerName, sellerPhone: form.sellerPhone, note: form.note };
      if (!sold) {
        Object.assign(body, {
          productId: Number(form.productId),
          imei: form.imei,
          condition: form.condition,
          paidUsd: Number(form.paidUsd) || 0,
          paidLbp: Number(form.paidLbp) || 0,
        });
      }
      await api.put(`/repairs/trade-ins/${tradeIn.id}`, body);
      toast('Purchase updated');
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={saving ? undefined : onClose} title="Edit this purchase" subtitle={tradeIn.product_name} size="lg">
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        {sold && (
          <p className="col-span-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            This handset has been sold on, so only who sold it and the note can change.
          </p>
        )}
        {!sold && (
          <>
            <div className="col-span-2">
              <Select label="Sold as" value={form.productId} onChange={set('productId')}>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <Input
              label="IMEI"
              value={form.imei}
              onChange={set('imei')}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                document.getElementById('edit-cond')?.focus();
              }}
              className="font-mono"
              hint="Both numbers of a dual-SIM, separated by a comma"
            />
            <Select id="edit-cond" label="Condition" value={form.condition} onChange={set('condition')}>
              {CONDITIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            <Input label="Paid in dollars" type="number" step="0.01" min="0" value={form.paidUsd} onChange={set('paidUsd')} />
            <Input label="Paid in LBP" type="number" step="1000" min="0" value={form.paidLbp} onChange={set('paidLbp')} />
            <p className="col-span-2 text-xs text-slate-500">
              Change what was paid and the cashbox moves by the difference.
            </p>
          </>
        )}
        <Input label="Seller's name" value={form.sellerName} onChange={set('sellerName')} />
        <Input label="Phone number" value={form.sellerPhone} onChange={set('sellerPhone')} />
        <Input label="Note" value={form.note} onChange={set('note')} className="col-span-2" />
        {error && <p className="col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <ModalActions className="col-span-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            Save
          </Button>
        </ModalActions>
      </form>
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
  const [undoing, setUndoing] = useState(null);
  const [editing, setEditing] = useState(null);
  const confirm = useConfirm();
  const toast = useToast();

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
  useLive(load);

  /*
   * A handset bought by mistake. Only while it is on the shelf — a sold one is
   * part of a sale now, and the server says so if asked. The money goes back
   * where it came from.
   */
  async function undo(t) {
    const agreed = await confirm({
      title: 'Undo this purchase?',
      body: `${t.product_name} (${t.imei}) comes off the shelf and the ${money(t.paid_usd)}${
        t.paid_lbp > 0 ? ` and ${lbp(t.paid_lbp)}` : ''
      } paid for it goes back into the cash. This cannot be undone.`,
      confirmLabel: 'Undo the purchase',
    });
    if (!agreed) return;

    setUndoing(t.id);
    try {
      await api.delete(`/repairs/trade-ins/${t.id}`);
      toast('The purchase was undone and the money put back');
      await load();
    } catch (err) {
      toast(err.response?.data?.error || 'That could not be undone', 'error');
    } finally {
      setUndoing(null);
    }
  }

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

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
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
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
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
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(t)}
                        aria-label={`Edit the purchase of ${t.imei}`}
                        title="Edit"
                      >
                        <Pencil size={14} /> Edit
                      </Button>
                      {t.unit_status !== 'sold' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={undoing === t.id}
                          onClick={() => undo(t)}
                          title="Bought by mistake — take it off the shelf and put the money back"
                        >
                          <Undo2 size={14} /> Undo
                        </Button>
                      )}
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

      {editing && (
        <EditTradeInDialog
          tradeIn={editing}
          products={products}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
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

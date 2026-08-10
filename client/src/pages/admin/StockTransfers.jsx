import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Ban, PackageCheck, Plus, Search, Truck, X } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { useBranch } from '../../context/BranchContext';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  ModalActions,
  Select,
  Skeleton,
  cx,
  useToast,
} from '../../components/ui';

const STATUS_TONES = { draft: 'neutral', sent: 'warning', received: 'good', cancelled: 'critical' };

/**
 * Send stock to another shop.
 *
 * The catalogue is shared, so this is a list of quantities and nothing else —
 * no prices, no product to create at the other end. That is the whole point of
 * one company: the same product, moved.
 */
function SendDialog({ branches, from, onClose, onSent }) {
  const toast = useToast();
  const destinations = branches.filter((b) => b.id !== from.id && b.active);

  const [toBranchId, setToBranchId] = useState(destinations[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState([]);
  const [lines, setLines] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/products', { params: { activeOnly: 'true' } }).then((res) => setProducts(res.data.products));
  }, []);

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return [];
    return products
      .filter(
        (p) =>
          // Only what is actually on this shelf: you cannot send what is not here.
          !p.wallet_id &&
          p.stock > 0 &&
          !lines.some((l) => l.productId === p.id) &&
          (p.name.toLowerCase().includes(term) ||
            p.sku.toLowerCase().includes(term) ||
            (p.barcodes || []).some((c) => c.includes(term))),
      )
      .slice(0, 6);
  }, [products, search, lines]);

  function add(product) {
    setLines((l) => [...l, { productId: product.id, name: product.name, available: product.stock, quantity: 1 }]);
    setSearch('');
  }

  const setQuantity = (productId, quantity) =>
    setLines((l) =>
      l.map((line) =>
        line.productId === productId
          ? { ...line, quantity: Math.max(1, Math.min(Number(quantity) || 1, line.available)) }
          : line,
      ),
    );

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.post('/stock-transfers', {
        toBranchId: Number(toBranchId),
        note: note || null,
        items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      });
      toast(`${res.data.transfer.reference} sent`);
      onSent();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send that');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Send stock" subtitle={`Out of ${from.name}`} size="lg">
      <form onSubmit={submit} className="space-y-4">
        <Select
          label="To which branch"
          name="toBranchId"
          value={toBranchId}
          onChange={(e) => setToBranchId(e.target.value)}
          required
        >
          {destinations.length === 0 && <option value="">No other branch to send to</option>}
          {destinations.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-slate-700">What is going</span>
          <div className="relative">
            <Search
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search or scan what you are sending…"
              aria-label="Find a product to send"
              className="h-10 w-full rounded-lg bg-white pr-3 pl-9 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
            />
          </div>

          {matches.length > 0 && (
            <ul className="mt-1 overflow-hidden rounded-lg ring-1 ring-slate-200">
              {matches.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => add(p)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50"
                  >
                    <span className="min-w-0 truncate">
                      {p.name} <span className="text-xs text-slate-400">{p.sku}</span>
                    </span>
                    <span className="tnum shrink-0 text-xs text-slate-500">{p.stock} here</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {lines.length > 0 && (
            <ul className="mt-2 space-y-1">
              {lines.map((line) => (
                <li key={line.productId} className="flex items-center gap-3 rounded-lg bg-slate-50 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{line.name}</span>
                  <span className="text-xs text-slate-400">{line.available} here</span>
                  <input
                    type="number"
                    min="1"
                    max={line.available}
                    value={line.quantity}
                    onChange={(e) => setQuantity(line.productId, e.target.value)}
                    aria-label={`How many ${line.name}`}
                    className="tnum h-8 w-16 rounded-lg bg-white px-2 text-right text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setLines((l) => l.filter((x) => x.productId !== line.productId))}
                    aria-label={`Take ${line.name} off`}
                    className="rounded p-1 text-slate-400 hover:bg-white hover:text-red-600"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Input label="Note (optional)" name="note" value={note} onChange={(e) => setNote(e.target.value)} />

        <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
          This leaves the shelf here as soon as you send it, and only lands at the other branch when
          somebody there receives it. In between, it is in the car — counted at neither end, so it cannot
          be sold twice.
        </p>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving} disabled={lines.length === 0 || !toBranchId}>
            <Truck size={16} /> Send it
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/** Take delivery, counting what actually came out of the box. */
function ReceiveDialog({ transfer, onClose, onReceived }) {
  const toast = useToast();
  const [counts, setCounts] = useState(() =>
    Object.fromEntries(transfer.items.map((i) => [i.id, i.quantity])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const short = transfer.items.some((i) => Number(counts[i.id]) < i.quantity);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.post(`/stock-transfers/${transfer.id}/receive`, { counts });
      toast(`${transfer.reference} received`);
      onReceived();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not receive that');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Receive ${transfer.reference}`}
      subtitle={`From ${transfer.from_branch_name}`}
    >
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-500">
          Count what is actually in the box. It is usually what was sent — change a figure only if it is not.
        </p>

        <ul className="space-y-1">
          {transfer.items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 rounded-lg bg-slate-50 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                {item.name}
                {item.imei && <span className="ml-1.5 font-mono text-xs text-slate-400">{item.imei}</span>}
              </span>
              <span className="text-xs text-slate-400">{item.quantity} sent</span>
              <input
                type="number"
                min="0"
                max={item.quantity}
                value={counts[item.id]}
                onChange={(e) => setCounts((c) => ({ ...c, [item.id]: e.target.value }))}
                aria-label={`How many ${item.name} arrived`}
                className="tnum h-8 w-16 rounded-lg bg-white px-2 text-right text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
              />
            </li>
          ))}
        </ul>

        {short && (
          <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
            Less arrived than was sent. The difference is recorded against {transfer.from_branch_name} as
            short, so somebody can go and ask about it — it is not quietly written off.
          </p>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            <PackageCheck size={16} /> Receive it
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

export default function StockTransfers() {
  const toast = useToast();
  const { branch, branches, refresh: refreshBranches } = useBranch();
  const [transfers, setTransfers] = useState(null);
  const [sending, setSending] = useState(false);
  const [receiving, setReceiving] = useState(null);

  const load = useCallback(async () => {
    const res = await api.get('/stock-transfers');
    setTransfers(res.data.transfers);
  }, []);

  useEffect(() => {
    load();
  }, [load, branch?.id]);

  async function cancel(transfer) {
    try {
      await api.post(`/stock-transfers/${transfer.id}/cancel`);
      toast(`${transfer.reference} cancelled — the stock is back`);
      await load();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not cancel that', 'error');
    }
  }

  async function openReceive(row) {
    const res = await api.get(`/stock-transfers/${row.id}`);
    setReceiving(res.data.transfer);
  }

  const done = async () => {
    setSending(false);
    setReceiving(null);
    await load();
    await refreshBranches();
  };

  const incoming = (transfers || []).filter(
    (t) => t.status === 'sent' && t.to_branch_id === branch?.id,
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Move stock"
        subtitle="Send goods to another branch — the same products, on a different shelf"
        actions={
          <Button onClick={() => setSending(true)} disabled={branches.length < 2}>
            <Plus size={16} /> Send stock
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {branches.length < 2 && (
          <Card className="mb-4 px-5 py-4">
            <p className="text-sm text-slate-600">
              There is only one branch, so there is nowhere to send anything yet. Open a second one under{' '}
              <strong>Branches</strong> and its shelf can be stocked from this one — no product needs
              entering twice.
            </p>
          </Card>
        )}

        {/* What is waiting to be unpacked comes first: it is stock this shop
            cannot sell until somebody receives it. */}
        {incoming.length > 0 && (
          <Card className="mb-4 ring-amber-200">
            <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3">
              <Truck size={16} className="text-amber-600" />
              <h2 className="text-sm font-semibold text-slate-900">
                On the way to {branch?.name} — {incoming.length} to unpack
              </h2>
            </div>
            <ul className="divide-y divide-slate-50">
              {incoming.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800">
                      {t.reference} <span className="text-slate-400">from {t.from_branch_name}</span>
                    </p>
                    <p className="text-xs text-slate-400">
                      {t.item_count} item{t.item_count === 1 ? '' : 's'} · sent{' '}
                      {new Date(`${t.sent_at}Z`).toLocaleString()}
                      {t.note ? ` · ${t.note}` : ''}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => openReceive(t)}>
                    <PackageCheck size={14} /> Receive
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          {!transfers ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : transfers.length === 0 ? (
            <EmptyState
              icon={Truck}
              title="Nothing has moved between branches"
              description="Sending stock keeps one catalogue and moves the shelf."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Reference</th>
                  <th className="px-3 py-2.5 font-medium">Route</th>
                  <th className="px-3 py-2.5 text-right font-medium">Items</th>
                  <th className="px-3 py-2.5 font-medium">Sent</th>
                  <th className="px-5 py-2.5 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {transfers.map((t) => (
                  <tr key={t.id} className={cx(t.status === 'cancelled' && 'opacity-55')}>
                    <td className="px-5 py-2.5 font-medium text-slate-800">{t.reference}</td>
                    <td className="px-3 py-2.5 text-slate-600">
                      <span className="inline-flex items-center gap-1.5">
                        {t.from_branch_name}
                        <ArrowRight size={13} className="text-slate-400" />
                        {t.to_branch_name}
                      </span>
                    </td>
                    <td className="tnum px-3 py-2.5 text-right text-slate-700">{t.item_count}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-400">
                      {t.sent_at ? new Date(`${t.sent_at}Z`).toLocaleString() : '—'}
                    </td>
                    <td className="px-5 py-2.5">
                      <div className="flex items-center justify-end gap-2">
                        <Badge tone={STATUS_TONES[t.status]}>
                          {t.status === 'sent' ? 'on the way' : t.status}
                        </Badge>
                        {t.status === 'sent' && t.from_branch_id === branch?.id && (
                          <Button size="sm" variant="secondary" onClick={() => cancel(t)}>
                            <Ban size={13} /> Cancel
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {sending && branch && (
        <SendDialog branches={branches} from={branch} onClose={() => setSending(false)} onSent={done} />
      )}
      {receiving && (
        <ReceiveDialog transfer={receiving} onClose={() => setReceiving(null)} onReceived={done} />
      )}
    </div>
  );
}

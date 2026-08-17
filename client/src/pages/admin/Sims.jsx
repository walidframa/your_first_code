import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, Plus, ShieldAlert, Smartphone, Trash2 } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
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
  money,
  useToast,
} from '../../components/ui';

/**
 * Take a delivery of SIMs in.
 *
 * A supplier hands over a strip of cards and the shop types the numbers off
 * them — one per line, pasted straight from wherever the supplier sent them.
 * The whole batch goes in or none of it does, because a delivery half-entered
 * is worse than not entered: the shop believes it has SIMs it cannot find.
 */
function ReceiveSims({ products, onClose, onDone }) {
  const toast = useToast();
  const [productId, setProductId] = useState(String(products[0]?.id ?? ''));
  const [cost, setCost] = useState('');
  const [numbers, setNumbers] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const lines = numbers
    .split(/[\n,;]+/)
    .map((n) => n.trim())
    .filter(Boolean);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post('/sims/receive', {
        productId: Number(productId),
        cost: Number(cost) || 0,
        sims: lines,
      });
      toast(`${res.data.added} SIM${res.data.added === 1 ? '' : 's'} booked in`);
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not book those in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Book in SIMs" subtitle="One number per line">
      <form onSubmit={submit} className="space-y-3">
        <Select label="Which SIM" name="simProduct" value={productId} onChange={(e) => setProductId(e.target.value)}>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>

        <Input
          label="What each one cost"
          name="simCost"
          type="number"
          min="0"
          step="0.01"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          placeholder="0.00"
          hint="What the supplier charged, per card"
        />

        <div>
          <label htmlFor="simNumbers" className="mb-1.5 block text-sm font-medium text-slate-700">
            Phone numbers
          </label>
          <textarea
            id="simNumbers"
            name="simNumbers"
            rows={7}
            value={numbers}
            onChange={(e) => setNumbers(e.target.value)}
            placeholder={'03 111 222\n03 111 223\n76 444 555'}
            className="w-full rounded-lg bg-white px-3 py-2 font-mono text-sm ring-1 ring-slate-300 transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-500">
            {lines.length} number{lines.length === 1 ? '' : 's'}. Commas and semicolons work too — paste
            whatever the supplier sent.
          </p>
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={busy} disabled={lines.length === 0}>
            Book in {lines.length || ''}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/** The buyer's ID, for a SIM that has been sold. Behind `secrets`, like a password. */
function BuyerId({ sim, onClose, onRemoved }) {
  const toast = useToast();
  const [src, setSrc] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let url = null;
    let live = true;
    api
      .get(`/sims/sales/${sim.order_item_id}/id-photo`, { responseType: 'blob' })
      .then((res) => {
        if (!live) return;
        url = URL.createObjectURL(res.data);
        setSrc(url);
      })
      .catch((err) => {
        if (!live) return;
        setError(
          err.response?.status === 403
            ? 'Only somebody who may reveal saved passwords can open a buyer’s ID.'
            : 'That ID could not be opened.',
        );
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [sim.order_item_id]);

  async function remove() {
    setBusy(true);
    try {
      await api.delete(`/sims/sales/${sim.order_item_id}/id-photo`);
      toast('The ID was deleted');
      onRemoved();
    } catch {
      toast('That could not be deleted', 'error');
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="lg" title="Buyer’s ID" subtitle={`${sim.msisdn} · ${sim.order_number}`}>
      {error ? (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</p>
      ) : src ? (
        <img
          src={src}
          alt="The buyer’s ID"
          className="max-h-[70vh] w-full rounded-xl bg-slate-50 object-contain ring-1 ring-slate-200"
        />
      ) : (
        <Skeleton className="h-72" />
      )}

      <ModalActions>
        {src && (
          <Button variant="secondary" loading={busy} onClick={remove}>
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

/**
 * Every SIM the shop has held, and what became of it.
 *
 * The number is the column that matters — it is what a customer quotes when
 * they ring up about the line, and what the shop searches on.
 */
export default function Sims() {
  const [sims, setSims] = useState(null);
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [receiving, setReceiving] = useState(false);
  const [viewing, setViewing] = useState(null);

  const load = useCallback(async () => {
    const [list, prods] = await Promise.all([
      api.get('/sims', { params: { search: search || undefined, status: status || undefined } }),
      api.get('/sims/products'),
    ]);
    setSims(list.data.sims);
    setProducts(prods.data.products);
  }, [search, status]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="SIM cards"
        subtitle="Lines bought from a supplier and sold on"
        actions={
          <Button onClick={() => setReceiving(true)} disabled={products.length === 0}>
            <Plus size={16} /> Book in SIMs
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {products.length === 0 && sims !== null && (
          <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
            No product is marked as a SIM yet. Create one in <strong>Products</strong> — tick{' '}
            <strong>Sold as a SIM</strong>, near the bottom of the form — and it becomes available
            here.
          </p>
        )}

        <div className="mb-4 flex flex-wrap gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search a number…"
            className="h-10 w-64 rounded-lg bg-white px-3 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
          />
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-10 rounded-lg bg-white px-3 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
          >
            <option value="">All</option>
            <option value="in_stock">On the shelf</option>
            <option value="sold">Sold</option>
          </select>
        </div>

        {!sims ? (
          <Skeleton className="h-64" />
        ) : sims.length === 0 ? (
          <EmptyState
            icon={Smartphone}
            title="No SIMs yet"
            description="Book in a delivery and each number becomes a line you can sell."
          />
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Number</th>
                  <th className="px-3 py-2 font-medium">SIM</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-5 py-2 font-medium">Sold on</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {sims.map((s) => (
                  <tr key={s.id}>
                    <td className="tnum px-5 py-2.5 font-medium text-slate-800">{s.msisdn}</td>
                    <td className="px-3 py-2.5 text-slate-600">{s.product_name}</td>
                    <td className="tnum px-3 py-2.5 text-right text-slate-700">{money(s.cost)}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={s.status === 'in_stock' ? 'success' : 'neutral'}>
                        {s.status === 'in_stock' ? 'On the shelf' : s.status.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="px-5 py-2.5 text-slate-500">
                      {s.order_number ? (
                        <>
                          <span className="block text-xs">{s.order_number}</span>
                          {/*
                            * A line is registered to a person, so whether the
                            * shop has that person's ID is the thing worth
                            * seeing down a column of sales.
                            */}
                          {s.has_id_photo ? (
                            <button
                              onClick={() => setViewing(s)}
                              className={cx(
                                'mt-0.5 flex w-fit items-center gap-1 text-xs font-medium',
                                'text-brand-700 underline-offset-2 hover:underline',
                              )}
                            >
                              <BadgeCheck size={12} /> ID on file
                            </button>
                          ) : (
                            <span className="mt-0.5 flex items-center gap-1 text-xs text-amber-700">
                              <ShieldAlert size={12} /> no ID
                            </span>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {receiving && (
        <ReceiveSims
          products={products}
          onClose={() => setReceiving(false)}
          onDone={() => {
            setReceiving(false);
            load();
          }}
        />
      )}

      {viewing && (
        <BuyerId
          sim={viewing}
          onClose={() => setViewing(null)}
          onRemoved={() => {
            setViewing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

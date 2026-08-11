import { useCallback, useEffect, useState } from 'react';
import { Eye, Plus, Search, Trash2, Wrench } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import RepairSlip, { PrintSlipButton } from '../../components/RepairSlip';
import WhatsAppButton from '../../components/WhatsAppButton';
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

const FLOW = ['received', 'diagnosed', 'awaiting_parts', 'repairing', 'ready'];

const STATUS_LABEL = {
  received: 'Received',
  diagnosed: 'Diagnosed',
  awaiting_parts: 'Awaiting parts',
  repairing: 'In repair',
  ready: 'Ready',
  collected: 'Collected',
  cancelled: 'Cancelled',
};

const STATUS_STYLE = {
  received: 'bg-slate-100 text-slate-700',
  diagnosed: 'bg-sky-50 text-sky-700',
  awaiting_parts: 'bg-amber-50 text-amber-700',
  repairing: 'bg-violet-50 text-violet-700',
  ready: 'bg-brand-50 text-brand-700',
  collected: 'bg-slate-100 text-slate-400',
  cancelled: 'bg-red-50 text-red-600',
};

/** Take a device in over the counter. */
function IntakeModal({ onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    imei: '',
    customerName: '',
    customerPhone: '',
    device: '',
    fault: '',
    conditionNote: '',
    passcode: '',
    quoted: '',
  });
  const [warranty, setWarranty] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  /*
   * Check the IMEI as it is typed. Knowing the phone is under warranty before
   * the price conversation starts is the difference between a quote and an
   * apology.
   */
  async function checkImei() {
    if (!form.imei.trim()) return setWarranty(null);
    try {
      const res = await api.get(`/repairs/warranty/${form.imei.trim()}`);
      setWarranty(res.data);
      setForm((f) => ({ ...f, device: f.device || res.data.unit.product_name }));
    } catch {
      setWarranty({ unknown: true });
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.post('/repairs', {
        ...form,
        quoted: form.quoted === '' ? null : Number(form.quoted),
      });
      toast(`${res.data.ticket.ticket_number} opened`);
      onSaved(res.data.ticket.id);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not open the ticket');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={saving ? undefined : onClose} title="Take a device in" size="lg">
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Input
          label="Customer's name"
          value={form.customerName}
          onChange={set('customerName')}
          required
          autoFocus
        />
        <Input label="Phone number" value={form.customerPhone} onChange={set('customerPhone')} />

        <Input
          label="IMEI"
          value={form.imei}
          onChange={set('imei')}
          onBlur={checkImei}
          hint="If we sold it, the warranty is checked automatically"
        />
        <Input label="Device" value={form.device} onChange={set('device')} placeholder="e.g. Galaxy S22" />

        {warranty && (
          <div className="col-span-2">
            {warranty.unknown ? (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
                Not one of ours — taken in as a walk-in repair.
              </p>
            ) : (
              <p
                className={cx(
                  'rounded-lg px-3 py-2 text-sm',
                  warranty.warranty.active ? 'bg-brand-50 text-brand-800' : 'bg-amber-50 text-amber-800',
                )}
              >
                {warranty.unit.product_name} sold on {String(warranty.unit.sold_at ?? '').slice(0, 10)} ·{' '}
                {warranty.warranty.active
                  ? `under warranty until ${warranty.warranty.ends}`
                  : warranty.warranty.ends
                    ? `warranty ended ${warranty.warranty.ends}`
                    : 'sold with no warranty'}
              </p>
            )}
          </div>
        )}

        <div className="col-span-2">
          <label htmlFor="fault" className="mb-1 block text-sm font-medium text-slate-700">
            What is wrong with it
          </label>
          <textarea
            id="fault"
            value={form.fault}
            onChange={set('fault')}
            rows={2}
            required
            className="w-full rounded-xl px-3 py-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-500 focus:outline-none"
          />
        </div>

        <div className="col-span-2">
          <label htmlFor="cond" className="mb-1 block text-sm font-medium text-slate-700">
            Condition it came in
          </label>
          <textarea
            id="cond"
            value={form.conditionNote}
            onChange={set('conditionNote')}
            rows={2}
            placeholder="Scratches, cracked back, missing SIM tray…"
            className="w-full rounded-xl px-3 py-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-500">
            Written down in front of the customer, and printed on their ticket. This is the paragraph
            that settles arguments later.
          </p>
        </div>

        <Input
          label="Passcode"
          value={form.passcode}
          onChange={set('passcode')}
          hint="Encrypted — only an admin can read it back"
        />
        <Input label="Quoted" type="number" step="0.01" min="0" value={form.quoted} onChange={set('quoted')} />

        {error && (
          <p className="col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        <ModalActions className="col-span-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            Open ticket
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/** One job: its history, its parts, and handing it back. */
function TicketModal({ id, onClose, onChanged }) {
  const toast = useToast();
  const [detail, setDetail] = useState(null);
  const [products, setProducts] = useState([]);
  const [partId, setPartId] = useState('');
  const [charged, setCharged] = useState('');
  const [passcode, setPasscode] = useState(null);

  const load = useCallback(async () => {
    const [d, p] = await Promise.all([api.get(`/repairs/${id}`), api.get('/products')]);
    setDetail(d.data);
    setProducts(p.data.products.filter((x) => !x.tracks_units));
    setCharged(String(d.data.ticket.quoted ?? d.data.partsTotal ?? ''));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function move(status) {
    try {
      await api.patch(`/repairs/${id}`, { status });
      await load();
      onChanged();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not move it', 'error');
    }
  }

  async function fitPart() {
    if (!partId) return;
    try {
      await api.post(`/repairs/${id}/parts`, { productId: Number(partId) });
      setPartId('');
      await load();
      onChanged();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not fit that part', 'error');
    }
  }

  async function collect() {
    const amount = Number(charged) || 0;
    try {
      await api.post(`/repairs/${id}/collect`, {
        charged: amount,
        payments: amount > 0 ? [{ currency: 'USD', amount }] : [],
      });
      toast('Handed back');
      await load();
      onChanged();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not collect it', 'error');
    }
  }

  if (!detail) {
    return (
      <Modal open onClose={onClose} title="Repair" size="lg">
        <Skeleton className="h-64" />
      </Modal>
    );
  }

  const { ticket, parts, events, partsTotal } = detail;
  const closed = ['collected', 'cancelled'].includes(ticket.status);

  return (
    <Modal open onClose={onClose} title={ticket.ticket_number} subtitle={ticket.device} size="xl">
      <div className="grid grid-cols-2 gap-5">
        <div className="space-y-4">
          {!closed && (
            <div>
              <p className="mb-1.5 text-sm text-slate-600">Where it is up to</p>
              <div className="flex flex-wrap gap-1.5">
                {FLOW.map((s) => (
                  <button
                    key={s}
                    onClick={() => move(s)}
                    className={cx(
                      'rounded-lg px-2.5 py-1 text-xs font-medium transition',
                      ticket.status === s
                        ? 'bg-brand-600 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                    )}
                  >
                    {STATUS_LABEL[s]}
                  </button>
                ))}
                <button
                  onClick={() => move('cancelled')}
                  className="rounded-lg px-2.5 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50"
                >
                  Cancel job
                </button>
              </div>
            </div>
          )}

          <Card className="p-4">
            <p className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">Parts fitted</p>
            {parts.length === 0 ? (
              <p className="text-sm text-slate-400">Nothing fitted yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {parts.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">
                      {p.quantity > 1 ? `${p.quantity}× ` : ''}
                      {p.name}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tnum text-slate-600">{money(p.price * p.quantity)}</span>
                      {!closed && (
                        <button
                          onClick={async () => {
                            await api.delete(`/repairs/parts/${p.id}`);
                            await load();
                            onChanged();
                          }}
                          aria-label={`Remove ${p.name}`}
                          className="rounded p-0.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </span>
                  </li>
                ))}
                <li className="flex justify-between border-t border-slate-100 pt-1 font-semibold">
                  <span>Total</span>
                  <span className="tnum">{money(partsTotal)}</span>
                </li>
              </ul>
            )}

            {!closed && (
              <div className="mt-3 flex gap-2">
                <Select value={partId} onChange={(e) => setPartId(e.target.value)} aria-label="Part to fit">
                  <option value="">Fit a part…</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.stock} left
                    </option>
                  ))}
                </Select>
                <Button size="sm" onClick={fitPart} disabled={!partId}>
                  <Plus size={14} /> Fit
                </Button>
              </div>
            )}
          </Card>

          {!closed && (
            <Card className="p-4">
              <p className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">
                Hand it back
              </p>
              {ticket.under_warranty === 1 && (
                <p className="mb-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800">
                  Under warranty — collect at nothing to pay.
                </p>
              )}
              <div className="flex gap-2">
                <Input
                  label="Charge"
                  type="number"
                  step="0.01"
                  min="0"
                  value={ticket.under_warranty === 1 ? '0' : charged}
                  onChange={(e) => setCharged(e.target.value)}
                  disabled={ticket.under_warranty === 1}
                />
                <div className="flex items-end">
                  <Button onClick={collect}>Collected</Button>
                </div>
              </div>
              <p className="mt-1.5 text-xs text-slate-500">Cash goes into the open cashbox.</p>
            </Card>
          )}

          <Card className="p-4">
            <p className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">History</p>
            <ul className="space-y-1.5 text-sm">
              {events.map((e) => (
                <li key={e.id} className="flex gap-2">
                  <span className="w-28 shrink-0 text-xs text-slate-400">
                    {String(e.created_at).slice(5, 16).replace('T', ' ')}
                  </span>
                  <span className="text-slate-700">
                    {STATUS_LABEL[e.status]}
                    {e.note ? ` — ${e.note}` : ''}
                    {e.user_name ? <span className="text-slate-400"> · {e.user_name}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          {ticket.passcode_enc && (
            <div>
              {passcode === null ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    try {
                      const r = await api.get(`/repairs/${id}/passcode`);
                      setPasscode(r.data.passcode ?? '—');
                    } catch {
                      toast('Only an admin can read the passcode', 'error');
                    }
                  }}
                >
                  <Eye size={14} /> Show passcode
                </Button>
              ) : (
                <p className="font-mono text-sm text-slate-800">Passcode: {passcode}</p>
              )}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <RepairSlip detail={detail} />
          {/*
            * Sending it again is most useful here rather than at intake: this
            * is the screen open when the phone becomes ready to collect, and
            * the message carries the status.
            */}
          <div className="flex justify-center gap-2">
            <PrintSlipButton />
            <WhatsAppButton path={`/repairs/${detail.ticket.id}/whatsapp`} label="WhatsApp" size="sm" />
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default function Repairs() {
  const [tickets, setTickets] = useState(null);
  const [filter, setFilter] = useState('open');
  const [q, setQ] = useState('');
  const [intake, setIntake] = useState(false);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    const res = await api.get('/repairs', { params: { status: filter, q: q || undefined } });
    setTickets(res.data.tickets);
  }, [filter, q]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Repairs"
        subtitle="Devices in the shop, and what is happening to them"
        actions={
          <Button onClick={() => setIntake(true)}>
            <Plus size={16} /> Take a device in
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mb-4 flex gap-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ticket number, name, phone or IMEI…"
              aria-label="Search repairs"
              className="h-10 w-full rounded-xl bg-white pr-3 pl-9 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-brand-500 focus:outline-none"
            />
          </div>
          <div className="w-44">
            <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Status filter">
              <option value="open">On the bench</option>
              {Object.entries(STATUS_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {!tickets ? (
          <Skeleton className="h-64" />
        ) : tickets.length === 0 ? (
          <EmptyState
            icon={Wrench}
            title="Nothing on the bench"
            description="Take a device in and it appears here until it is collected."
          />
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Ticket</th>
                  <th className="px-3 py-2 font-medium">Device</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Fault</th>
                  <th className="px-3 py-2 text-right font-medium">Parts</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {tickets.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => setOpenId(t.id)}
                    className="cursor-pointer transition hover:bg-slate-50"
                  >
                    <td className="px-5 py-2.5 font-mono text-xs text-slate-700">
                      {t.ticket_number}
                      {t.under_warranty === 1 && (
                        <span className="ml-1.5 rounded bg-brand-50 px-1 py-0.5 text-[10px] font-medium text-brand-700">
                          warranty
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-slate-800">{t.device}</td>
                    <td className="px-3 py-2.5 text-slate-600">
                      {t.customer_name}
                      {t.customer_phone && (
                        <span className="block text-xs text-slate-400">{t.customer_phone}</span>
                      )}
                    </td>
                    <td className="max-w-[16rem] truncate px-3 py-2.5 text-slate-500">{t.fault}</td>
                    <td className="tnum px-3 py-2.5 text-right text-slate-600">
                      {t.part_count ? money(t.parts_total) : '—'}
                    </td>
                    <td className="px-5 py-2.5">
                      <span
                        className={cx(
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          STATUS_STYLE[t.status],
                        )}
                      >
                        {STATUS_LABEL[t.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {intake && (
        <IntakeModal
          onClose={() => setIntake(false)}
          onSaved={(id) => {
            setIntake(false);
            setOpenId(id);
            load();
          }}
        />
      )}

      {openId && <TicketModal id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

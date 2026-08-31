import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Eye, Plus, Trash2, Wrench } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import RepairSlip, { PrintSlipButton } from '../../components/RepairSlip';
import WhatsAppButton from '../../components/WhatsAppButton';
import CustomerField from '../../components/CustomerField';
import HistoryFilter from '../../components/HistoryFilter';
import { useHistoryFilter } from '../../lib/history';
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

/* Not a status — a payment, filed in the same history column. */
const EVENT_LABEL = { ...STATUS_LABEL, payment: 'Paid' };

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
    customerId: null,
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
        <CustomerField
          value={form}
          onChange={(next) => setForm((f) => ({ ...f, ...next }))}
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
            className="w-full rounded-xl px-3 py-2 text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-500 focus:outline-none"
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
            className="w-full rounded-xl px-3 py-2 text-sm ring-1 ring-edge focus:ring-2 focus:ring-brand-500 focus:outline-none"
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
  const [payNow, setPayNow] = useState('');
  const [passcode, setPasscode] = useState(null);

  const load = useCallback(async () => {
    const [d, p] = await Promise.all([api.get(`/repairs/${id}`), api.get('/products')]);
    setDetail(d.data);
    setProducts(p.data.products.filter((x) => !x.tracks_units));
    setCharged(String(d.data.ticket.charged ?? d.data.ticket.quoted ?? d.data.partsTotal ?? ''));
    setPayNow(d.data.outstanding > 0 ? String(d.data.outstanding) : '');
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

  /*
   * Take the money now, and leave the phone on the bench.
   *
   * The whole point of this screen having two buttons: what is paid and where
   * the job is up to are different facts, and a shop whose customers pay on
   * drop-off needs to record the first without asserting the second.
   */
  async function takePayment() {
    const amount = Number(payNow) || 0;
    if (amount <= 0) return;
    try {
      await api.post(`/repairs/${id}/payment`, {
        charged: Number(charged) || null,
        payments: [{ currency: 'USD', amount }],
      });
      toast(`${money(amount)} taken`);
      setPayNow('');
      await load();
      onChanged();
    } catch (err) {
      toast(err.response?.data?.error || 'Could not record that payment', 'error');
    }
  }

  async function collect() {
    const amount = Number(charged) || 0;
    const due = Math.max(0, Number(outstanding) || 0);
    try {
      await api.post(`/repairs/${id}/collect`, {
        charged: amount,
        // Only what is actually still owed — a job paid for at intake is handed
        // back at nothing to pay, and charging it again would put the money in
        // the drawer twice.
        payments: due > 0 ? [{ currency: 'USD', amount: due }] : [],
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

  const { ticket, parts, events, partsTotal, outstanding } = detail;
  const closed = ['collected', 'cancelled'].includes(ticket.status);
  const paid = Number(ticket.paid_usd || 0) > 0 || Number(ticket.paid_lbp || 0) > 0;

  return (
    <Modal open onClose={onClose} title={ticket.ticket_number} subtitle={ticket.device} size="xl">
      <div className="grid grid-cols-2 gap-5">
        <div className="space-y-4">
          {/*
            * Always offered, including on a job that has been paid for and
            * handed back. Money and progress are separate facts now, and a
            * phone that comes straight back through the door on Friday needs
            * to go back on the bench rather than stay frozen at "collected".
            */}
          <div>
            <p className="mb-1.5 text-sm text-slate-600">
              {closed ? 'Put it back on the bench' : 'Where it is up to'}
            </p>
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
              {ticket.status !== 'cancelled' && (
                <button
                  onClick={() => move('cancelled')}
                  className="rounded-lg px-2.5 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50"
                >
                  Cancel job
                </button>
              )}
            </div>
            {closed && (
              <p className="mt-1.5 text-xs text-slate-400">
                {ticket.status === 'collected' ? 'Handed back' : 'Cancelled'}
                {paid ? ' · what was paid stays paid' : ''}.
              </p>
            )}
          </div>

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
                The money
              </p>
              {ticket.under_warranty === 1 && (
                <p className="mb-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800">
                  Under warranty — collect at nothing to pay.
                </p>
              )}
              <div className="flex gap-2">
                <Input
                  label="Charge for the job"
                  type="number"
                  step="0.01"
                  min="0"
                  value={ticket.under_warranty === 1 ? '0' : charged}
                  onChange={(e) => setCharged(e.target.value)}
                  disabled={ticket.under_warranty === 1}
                />
                <div className="flex items-end">
                  <Button onClick={collect}>Hand it back</Button>
                </div>
              </div>

              {ticket.under_warranty !== 1 && (
                <>
                  {/*
                    * The drop-off payment. Most of this shop's customers pay
                    * when they hand the phone over, and the only way to record
                    * that used to be to mark the job collected — which said the
                    * phone had gone home when it was sitting on the bench.
                    */}
                  <div className="mt-3 flex gap-2 border-t border-slate-100 pt-3">
                    <Input
                      label="Take money now"
                      type="number"
                      step="0.01"
                      min="0"
                      value={payNow}
                      onChange={(e) => setPayNow(e.target.value)}
                      hint="The phone stays on the bench"
                    />
                    <div className="flex items-start pt-6">
                      <Button variant="secondary" onClick={takePayment} disabled={!(Number(payNow) > 0)}>
                        Take it
                      </Button>
                    </div>
                  </div>

                  {paid && (
                    <p className="tnum mt-2 text-sm text-slate-600">
                      Paid so far {money(ticket.paid_usd)}
                      {ticket.paid_lbp > 0 ? ` + ${Number(ticket.paid_lbp).toLocaleString('en-US')} LL` : ''}
                      {outstanding > 0 ? (
                        <span className="text-amber-700"> · {money(outstanding)} still to pay</span>
                      ) : (
                        <span className="text-brand-700"> · nothing left to pay</span>
                      )}
                    </p>
                  )}
                </>
              )}
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
                    {EVENT_LABEL[e.status] || e.status}
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
  /*
   * Arrived pointing at one ticket — from a customer's account, say, which now
   * lists the phones they have left here. A link that lands on a filtered board
   * and leaves you to find the ticket you clicked is not a link, so the search
   * is filled in and the board is opened at everything rather than at whatever
   * happens to be on the bench today.
   */
  const [params] = useSearchParams();
  const asked = params.get('q') || '';

  const [tickets, setTickets] = useState(null);
  const [filter, setFilter] = useState(asked ? '' : 'open');
  const [intake, setIntake] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [profit, setProfit] = useState(null);
  /*
   * A device left in March is still a device the shop had, and until now the
   * only way to it was a status nobody remembered choosing.
   */
  const history = useHistoryFilter(asked ? 'all' : 'month', asked);
  const q = history.term;

  /*
   * The period goes to the server, not to a filter over what it sent back.
   *
   * The list is capped at the newest two hundred. Narrowing *those* by date
   * meant asking for March and being shown however much of March fell inside
   * the most recent two hundred tickets — with nothing on screen to say the
   * rest had been left out.
   */
  const { from, to } = history.range;

  const load = useCallback(async () => {
    const params = { status: filter || undefined, q: q || undefined, from: from || undefined, to: to || undefined };
    const [list, earned] = await Promise.all([
      api.get('/repairs', { params }),
      // The owner's figure. A cashier has no `reports` permission and simply
      // does not get one, which is not an error worth showing them.
      api.get('/repairs/profit', { params: { from: from || undefined, to: to || undefined } }).catch(() => null),
    ]);
    setTickets(list.data.tickets);
    setProfit(earned?.data ?? null);
  }, [filter, q, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const shown = tickets || [];

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

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <HistoryFilter
          filter={history}
          label="Search repairs"
          placeholder="Ticket number, name, phone or IMEI…"
        >
          <div className="w-44">
            <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Status filter">
              <option value="open">On the bench</option>
              <option value="">Every ticket</option>
              {Object.entries(STATUS_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
        </HistoryFilter>

        {/*
          * What the bench made over whatever period is on screen.
          *
          * Two figures, because a repair takes money and finishes on two
          * different days: profit belongs to the day the phone went home, and
          * the drawer was filled on the day it was paid. Reporting one number
          * would have to be wrong about one of them.
          */}
        {profit && (
          <Card className="mb-4 flex flex-wrap items-end gap-x-8 gap-y-3 px-5 py-4">
            <div>
              <p className="text-xs text-slate-500">Profit on jobs handed back</p>
              <p
                className={cx(
                  'tnum text-2xl font-semibold',
                  profit.profit < 0 ? 'text-red-600' : 'text-slate-900',
                )}
              >
                {money(profit.profit)}
              </p>
              <p className="mt-0.5 text-xs text-slate-400">
                {money(profit.revenue)} charged less {money(profit.partsCost)} of parts ·{' '}
                {profit.jobs} {profit.jobs === 1 ? 'job' : 'jobs'}
              </p>
            </div>

            <div>
              <p className="text-xs text-slate-500">Money taken</p>
              <p className="tnum text-2xl font-semibold text-slate-700">{money(profit.taken.total)}</p>
              <p className="mt-0.5 text-xs text-slate-400">
                across {profit.taken.jobs} {profit.taken.jobs === 1 ? 'job' : 'jobs'}
                {profit.taken.lbp > 0 &&
                  ` · ${Number(profit.taken.lbp).toLocaleString('en-US')} LL of it in pounds`}
              </p>
            </div>

            {/*
              * Said plainly rather than folded into the figure. A warranty job
              * is charged nothing and its parts cost real money, so it shows as
              * a loss — which is what a warranty is, and hiding it would hide
              * the cost of the promise.
              */}
            {profit.warrantyJobs > 0 && (
              <p className="text-xs text-slate-500">
                {profit.warrantyJobs} under warranty, charged nothing
              </p>
            )}
            {profit.unknownCostParts > 0 && (
              <p className="text-xs text-amber-700">
                {profit.unknownCostParts} {profit.unknownCostParts === 1 ? 'part has' : 'parts have'}{' '}
                no cost recorded, so the profit is flattered by whatever they cost
              </p>
            )}
          </Card>
        )}

        {!tickets ? (
          <Skeleton className="h-64" />
        ) : shown.length === 0 ? (
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
                  <th className="hidden px-3 py-2 font-medium sm:table-cell">Customer</th>
                  <th className="hidden px-3 py-2 font-medium md:table-cell">Fault</th>
                  <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Parts</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {shown.map((t) => (
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
                    <td className="px-3 py-2.5 text-slate-800">
                      {t.device}
                      <span className="block text-xs text-slate-400 sm:hidden">{t.customer_name}</span>
                    </td>
                    <td className="hidden px-3 py-2.5 text-slate-600 sm:table-cell">
                      {t.customer_name}
                      {t.customer_phone && (
                        <span className="block text-xs text-slate-400">{t.customer_phone}</span>
                      )}
                    </td>
                    <td className="hidden max-w-[16rem] truncate px-3 py-2.5 text-slate-500 md:table-cell">{t.fault}</td>
                    <td className="tnum hidden px-3 py-2.5 text-right text-slate-600 sm:table-cell">
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

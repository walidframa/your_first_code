import { useCallback, useEffect, useState } from 'react';
import { Banknote, Printer } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import { lbp } from '../../context/SettingsContext';
import { Badge, Button, Card, EmptyState, Modal, Skeleton, cx, money } from '../../components/ui';

const KIND_LABELS = {
  opening_float: 'Opening float',
  sale: 'Cash sales',
  refund: 'Refunds',
  customer_payment: 'Customer payments',
  supplier_payment: 'Supplier payments',
  document: 'Invoices paid in cash',
  cash_in: 'Cash in',
  cash_out: 'Cash out',
  bank_drop: 'To the bank',
  correction: 'Over / short',
};

const REASON_LABELS = {
  petty_cash: 'petty cash',
  owner_funds: 'owner’s money',
  owner_draw: 'owner took out',
  bank_drop: 'to the bank',
  customer_payment: 'customer payment',
  supplier: 'supplier',
  expense: 'expense',
  wages: 'wages',
  refund: 'refund',
  correction: 'correction',
  short: 'short',
  over: 'over',
  other: 'other',
};

/*
 * Money missing is a different problem from money over: one is a loss, the
 * other a mistake somewhere in the recording. They should not look alike.
 */
const diffTone = (value) => (value === 0 ? 'text-brand-700' : value < 0 ? 'text-red-600' : 'text-amber-600');

/** Over/short in the currency it happened in — never the two added together. */
function Difference({ usd, lbpAmount }) {
  if (usd === null || usd === undefined) return <span className="text-slate-400">—</span>;
  const exact = usd === 0 && lbpAmount === 0;
  if (exact) return <Badge tone="good">exact</Badge>;

  const parts = [];
  if (usd !== 0) parts.push(`${usd > 0 ? '+' : ''}${money(usd)}`);
  if (lbpAmount !== 0) parts.push(`${lbpAmount > 0 ? '+' : ''}${lbp(lbpAmount)}`);
  const short = usd < 0 || lbpAmount < 0;

  return <Badge tone={short ? 'critical' : 'warning'}>{parts.join(' · ')}</Badge>;
}

/** The Z-report: one sitting of the till, start to finish. */
function SessionReport({ id, onClose }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get(`/cash/sessions/${id}`).then((res) => setData(res.data));
  }, [id]);

  if (!data) {
    return (
      <Modal open onClose={onClose} title="Loading…">
        <Skeleton className="h-56" />
      </Modal>
    );
  }

  const { session, byKind, expected, sales, salesTotal, refunds, movements } = data;
  const closed = session.status === 'closed';

  return (
    <Modal
      open
      onClose={onClose}
      title={`Cashbox #${session.id}`}
      subtitle={`Opened ${new Date(`${session.opened_at}Z`).toLocaleString()} by ${session.opened_by_name}`}
      size="lg"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={closed ? 'neutral' : 'good'}>{session.status}</Badge>
        {closed && <Difference usd={session.over_short_usd} lbpAmount={session.over_short_lbp} />}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">
            The drawer
          </p>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-50">
              {byKind.map((k) => (
                <tr key={k.kind}>
                  <td className="py-1.5 text-slate-600">
                    {KIND_LABELS[k.kind] || k.kind}
                    <span className="ml-1 text-xs text-slate-400">×{k.count}</span>
                  </td>
                  <td className="tnum py-1.5 text-right text-slate-800">{money(k.usd)}</td>
                  <td className="tnum py-1.5 text-right text-slate-500">{lbp(k.lbp)}</td>
                </tr>
              ))}
              <tr className="border-t border-slate-200 font-semibold">
                <td className="py-1.5 text-slate-900">{closed ? 'Left in the drawer' : 'In the drawer now'}</td>
                <td className="tnum py-1.5 text-right text-slate-900">{money(expected.usd)}</td>
                <td className="tnum py-1.5 text-right text-slate-600">{lbp(expected.lbp)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">
            Sales in this sitting
          </p>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-50">
              {sales.map((s) => (
                <tr key={s.payment_method}>
                  <td className="py-1.5 text-slate-600">
                    {s.payment_method}
                    <span className="ml-1 text-xs text-slate-400">×{s.orders}</span>
                  </td>
                  <td className="tnum py-1.5 text-right text-slate-800">{money(s.total)}</td>
                </tr>
              ))}
              {refunds.orders > 0 && (
                <tr>
                  <td className="py-1.5 text-slate-600">
                    refunded<span className="ml-1 text-xs text-slate-400">×{refunds.orders}</span>
                  </td>
                  <td className="tnum py-1.5 text-right text-red-600">−{money(refunds.total)}</td>
                </tr>
              )}
              <tr className="border-t border-slate-200 font-semibold">
                <td className="py-1.5 text-slate-900">Taken</td>
                <td className="tnum py-1.5 text-right text-slate-900">{money(salesTotal)}</td>
              </tr>
            </tbody>
          </table>

          {closed && (
            <table className="mt-4 w-full text-sm">
              <tbody className="divide-y divide-slate-50">
                <tr>
                  <td className="py-1.5 text-slate-500">Expected</td>
                  <td className="tnum py-1.5 text-right">{money(session.expected_usd)}</td>
                  <td className="tnum py-1.5 text-right text-slate-500">{lbp(session.expected_lbp)}</td>
                </tr>
                <tr>
                  <td className="py-1.5 text-slate-500">Counted</td>
                  <td className="tnum py-1.5 text-right">{money(session.counted_usd)}</td>
                  <td className="tnum py-1.5 text-right text-slate-500">{lbp(session.counted_lbp)}</td>
                </tr>
                <tr className="font-semibold">
                  <td className="py-1.5 text-slate-900">Difference</td>
                  <td className={cx('tnum py-1.5 text-right', diffTone(session.over_short_usd))}>
                    {money(session.over_short_usd)}
                  </td>
                  <td className={cx('tnum py-1.5 text-right', diffTone(session.over_short_lbp))}>
                    {lbp(session.over_short_lbp)}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      </div>

      {session.closing_note && (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{session.closing_note}</p>
      )}

      <p className="mt-5 mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">
        Every movement
      </p>
      <div className="max-h-64 overflow-y-auto rounded-xl ring-1 ring-slate-100">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-50">
            {movements.map((m) => (
              <tr key={m.id}>
                <td className="px-3 py-1.5 text-xs text-slate-400">
                  {new Date(`${m.created_at}Z`).toLocaleTimeString([], { timeStyle: 'short' })}
                </td>
                <td className="px-2 py-1.5 text-slate-600">
                  {KIND_LABELS[m.kind] || m.kind}
                  {m.reason && <span className="ml-1 text-xs text-slate-400">{REASON_LABELS[m.reason] || m.reason}</span>}
                </td>
                <td className="max-w-[12rem] truncate px-2 py-1.5 text-xs text-slate-400">
                  {m.order_number || m.doc_number || m.note || ''}
                </td>
                <td
                  className={cx(
                    'tnum px-2 py-1.5 text-right',
                    m.amount_usd < 0 ? 'text-red-600' : 'text-slate-700',
                  )}
                >
                  {m.amount_usd !== 0 ? money(m.amount_usd) : ''}
                </td>
                <td
                  className={cx(
                    'tnum px-3 py-1.5 text-right',
                    m.amount_lbp < 0 ? 'text-red-600' : 'text-slate-500',
                  )}
                >
                  {m.amount_lbp !== 0 ? lbp(m.amount_lbp) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="no-print mt-5">
        <Button variant="secondary" onClick={() => window.print()}>
          <Printer size={15} /> Print
        </Button>
      </div>
    </Modal>
  );
}

export default function CashSessions() {
  const [sessions, setSessions] = useState(null);
  const [viewing, setViewing] = useState(null);

  const load = useCallback(() => {
    api.get('/cash/sessions').then((res) => setSessions(res.data.sessions));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Cashbox" subtitle="Every sitting of the till, and how it counted" />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <Card>
          {!sessions ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <EmptyState
              icon={Banknote}
              title="The cashbox has never been opened"
              description="Open it from the register to start tracking the drawer."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Opened</th>
                  <th className="px-3 py-2.5 font-medium">By</th>
                  <th className="px-3 py-2.5 font-medium">Closed</th>
                  <th className="px-3 py-2.5 text-right font-medium">Counted</th>
                  <th className="px-5 py-2.5 text-right font-medium">Difference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {sessions.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => setViewing(s.id)}
                    className="cursor-pointer hover:bg-slate-50/60"
                  >
                    <td className="px-5 py-2.5 font-medium text-slate-800">
                      {new Date(`${s.opened_at}Z`).toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-slate-500">{s.opened_by_name}</td>
                    <td className="px-3 py-2.5 text-slate-500">
                      {s.closed_at ? (
                        new Date(`${s.closed_at}Z`).toLocaleTimeString([], { timeStyle: 'short' })
                      ) : (
                        <Badge tone="good">open now</Badge>
                      )}
                    </td>
                    <td className="tnum px-3 py-2.5 text-right text-slate-700">
                      {s.counted_usd === null ? (
                        '—'
                      ) : (
                        <>
                          {money(s.counted_usd)}
                          <span className="block text-xs text-slate-400">{lbp(s.counted_lbp)}</span>
                        </>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <Difference usd={s.over_short_usd} lbpAmount={s.over_short_lbp} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {viewing && <SessionReport id={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

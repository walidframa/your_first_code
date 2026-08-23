import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import api from '../api';
import { lbp } from '../context/SettingsContext';
import { Button, Badge, Modal, Skeleton, cx, money, useToast } from './ui';
import { when, atTime } from '../lib/when';

/*
 * Money missing is a different problem from money over: one is a loss, the
 * other a mistake somewhere in the recording. They should not look alike.
 */
const tone = (value) => (value === 0 ? 'text-brand-700' : value < 0 ? 'text-red-600' : 'text-amber-600');

const stamp = (value) => when(value);
const clock = (value) =>
  atTime(value, '');

function Section({ title, children, className }) {
  return (
    <section className={className}>
      <p className="mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">{title}</p>
      {children}
    </section>
  );
}

/**
 * A difference, said the way a shopkeeper says it.
 *
 * "exact" rather than "$0.00": a zero in a column of figures still has to be
 * read to know it is nothing, and this is the one line on the page that is
 * looked at first.
 */
function Diff({ value, format }) {
  if (value === 0) return <span className="text-brand-700">exact</span>;
  return (
    <span className={tone(value)}>
      {value > 0 ? '+' : ''}
      {format(value)} {value > 0 ? 'over' : 'short'}
    </span>
  );
}

/**
 * The cashbox report, on screen.
 *
 * The same report the PDF draws, from the same endpoint, so the copy in the
 * folder and the copy on the till agree. Everything here is read-only: by the
 * time a sitting has a report it has already happened, and a page that could
 * change it would be a page that could quietly rewrite a count.
 */
export default function CashReport({ sessionId, onClose }) {
  const toast = useToast();
  const [report, setReport] = useState(null);
  const [failed, setFailed] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get(`/cash/sessions/${sessionId}/report`)
      .then((res) => alive && setReport(res.data.report))
      .catch((err) => alive && setFailed(err.response?.data?.error || 'Could not load the report'));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  /*
   * The file comes from the server, so it is the same document however it was
   * asked for — and the request carries the bearer token, which is why it is
   * fetched and handed to the browser rather than being a plain link.
   */
  async function download() {
    setDownloading(true);
    try {
      /*
       * The phone's own timezone, told to the server, because the server has
       * no way of working it out — and a PDF that disagrees with the screen
       * about when a sitting opened is worse than one that says UTC.
       */
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await api.get(`/cash/sessions/${sessionId}/report.pdf`, {
        responseType: 'blob',
        params: tz ? { tz } : undefined,
      });
      const name =
        /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] ||
        `cashbox-${sessionId}.pdf`;

      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Freed on the next tick: revoking immediately can beat the download.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      toast('Could not produce the PDF', 'error');
    } finally {
      setDownloading(false);
    }
  }

  if (failed) {
    return (
      <Modal open onClose={onClose} title="Cashbox report">
        <p className="text-sm text-red-600">{failed}</p>
      </Modal>
    );
  }

  if (!report) {
    return (
      <Modal open onClose={onClose} title="Cashbox report">
        <Skeleton className="h-64" />
      </Modal>
    );
  }

  const { session, closed, expected, counted, difference, combined, profit } = report;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Cashbox report — ${report.account.name}`}
      subtitle={`Sitting #${session.id} · opened ${stamp(session.opened_at)} by ${session.opened_by_name}`}
      size="xl"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={closed ? 'neutral' : 'good'}>{closed ? 'closed' : 'open now'}</Badge>
        {closed && (
          <span className="text-sm">
            <Diff value={difference.usd} format={money} />
            <span className="mx-1.5 text-slate-300">·</span>
            <Diff value={difference.lbp} format={lbp} />
          </span>
        )}
        {report.rate > 0 && (
          <span className="tnum ml-auto text-xs text-slate-400">
            1 USD = {Number(report.rate).toLocaleString('en-US')} LL
          </span>
        )}
      </div>

      {/*
        * Profit sits at the top when it is there at all, because it is the one
        * figure the owner opens this report for. It is absent entirely for
        * anyone without the permission — see the route.
        */}
      {profit && (
        <div className="mb-4 grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-4">
          {[
            ['Revenue', profit.revenue, 'text-slate-900'],
            ['Cost of goods', -profit.cost, 'text-slate-600'],
            ['Gross profit', profit.grossProfit, 'text-slate-900'],
            ['Net profit', profit.netProfit, profit.netProfit < 0 ? 'text-red-600' : 'text-brand-700'],
          ].map(([label, value, colour]) => (
            <div key={label}>
              <p className="text-[11px] tracking-wide text-slate-500 uppercase">{label}</p>
              <p className={cx('tnum text-lg font-semibold', colour)}>{money(value)}</p>
            </div>
          ))}
          {profit.unknownCostLines > 0 && (
            <p className="col-span-full text-xs text-amber-700">
              {profit.unknownCostLines} sold line{profit.unknownCostLines === 1 ? '' : 's'} had no cost
              recorded, so this is overstated by whatever those goods cost.
            </p>
          )}
        </div>
      )}

      {closed && (
        <Section title="The count" className="mb-5">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
              <tr>
                <th className="py-1.5 font-medium" />
                <th className="py-1.5 text-right font-medium">Expected</th>
                <th className="py-1.5 text-right font-medium">Counted</th>
                <th className="py-1.5 text-right font-medium">Difference</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {[
                ['Dollars', expected.usd, counted.usd, difference.usd, money],
                ['Lebanese pounds (LBP)', expected.lbp, counted.lbp, difference.lbp, lbp],
              ].map(([label, was, got, diff, format]) => (
                <tr key={label}>
                  <td className="py-2 text-slate-600">{label}</td>
                  <td className="tnum py-2 text-right text-slate-500">{format(was)}</td>
                  <td className="tnum py-2 text-right text-slate-800">{format(got)}</td>
                  <td className="tnum py-2 text-right font-semibold">
                    <Diff value={diff} format={format} />
                  </td>
                </tr>
              ))}
              {combined && (
                <tr className="border-t-2 border-slate-200">
                  <td className="py-2 font-medium text-slate-700">Altogether, in dollars</td>
                  <td className="tnum py-2 text-right text-slate-500">{money(combined.expected)}</td>
                  <td className="tnum py-2 text-right text-slate-800">{money(combined.counted)}</td>
                  <td className="tnum py-2 text-right font-semibold">
                    <Diff value={combined.difference} format={money} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-500">
            Left for the next sitting {money(session.carried_usd)} · {lbp(session.carried_lbp)}. The rest was
            taken out. The difference is recorded against this sitting, so the next one starts from what is
            really in the drawer.
          </p>
          {session.closing_note && (
            <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
              {session.closing_note}
            </p>
          )}
        </Section>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <Section title={closed ? 'What moved through the drawer' : 'What is in the drawer'}>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-50">
              {report.byKind.map((k) => (
                <tr key={k.kind}>
                  <td className="py-1.5 text-slate-600">
                    {k.label}
                    <span className="ml-1 text-xs text-slate-400">×{k.count}</span>
                  </td>
                  <td className={cx('tnum py-1.5 text-right', k.usd < 0 ? 'text-red-600' : 'text-slate-800')}>
                    {money(k.usd)}
                  </td>
                  <td className={cx('tnum py-1.5 text-right', k.lbp < 0 ? 'text-red-600' : 'text-slate-500')}>
                    {lbp(k.lbp)}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-slate-200 font-semibold">
                <td className="py-1.5 text-slate-900">{closed ? 'Left in the drawer' : 'In the drawer now'}</td>
                <td className="tnum py-1.5 text-right text-slate-900">{money(expected.usd)}</td>
                <td className="tnum py-1.5 text-right text-slate-600">{lbp(expected.lbp)}</td>
              </tr>
            </tbody>
          </table>
        </Section>

        <Section title="Sales in this sitting">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-50">
              {report.sales.map((s) => (
                <tr key={s.payment_method}>
                  <td className="py-1.5 text-slate-600">
                    {s.payment_method}
                    <span className="ml-1 text-xs text-slate-400">×{s.orders}</span>
                  </td>
                  <td className="tnum py-1.5 text-right text-slate-800">{money(s.total)}</td>
                </tr>
              ))}
              {report.refunds.orders > 0 && (
                <tr>
                  <td className="py-1.5 text-slate-600">
                    refunded<span className="ml-1 text-xs text-slate-400">×{report.refunds.orders}</span>
                  </td>
                  <td className="tnum py-1.5 text-right text-red-600">−{money(report.refunds.total)}</td>
                </tr>
              )}
              <tr className="border-t border-slate-200 font-semibold">
                <td className="py-1.5 text-slate-900">Taken</td>
                <td className="tnum py-1.5 text-right text-slate-900">{money(report.salesTotal)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-400">
            Every sale made while this till was open, however it was paid.
          </p>
        </Section>
      </div>

      <Section title="Every movement" className="mt-5">
        <div className="max-h-64 overflow-y-auto rounded-xl ring-1 ring-slate-100">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-50">
              {report.movements.map((m) => (
                <tr key={m.id}>
                  <td className="px-3 py-1.5 text-xs text-slate-400">{clock(m.created_at)}</td>
                  <td className="px-2 py-1.5 text-slate-600">
                    {m.label}
                    {m.reasonLabel && <span className="ml-1 text-xs text-slate-400">{m.reasonLabel}</span>}
                  </td>
                  <td className="max-w-[12rem] truncate px-2 py-1.5 text-xs text-slate-400">
                    {m.order_number || m.doc_number || m.note || ''}
                  </td>
                  <td
                    className={cx('tnum px-2 py-1.5 text-right', m.amount_usd < 0 ? 'text-red-600' : 'text-slate-700')}
                  >
                    {m.amount_usd !== 0 ? money(m.amount_usd) : ''}
                  </td>
                  <td
                    className={cx('tnum px-3 py-1.5 text-right', m.amount_lbp < 0 ? 'text-red-600' : 'text-slate-500')}
                  >
                    {m.amount_lbp !== 0 ? lbp(m.amount_lbp) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/*
        * One button, not two. The browser's print of this page and the PDF the
        * server draws would be two different documents claiming to be the same
        * report — and the shop's printer is set up for 72mm receipt rolls. The
        * file is the thing to keep, and printing it is what a printer is for.
        */}
      <div className="no-print mt-5 flex items-center gap-3">
        <Button onClick={download} loading={downloading}>
          <Download size={15} /> Download PDF
        </Button>
        <p className="text-xs text-slate-400">An A4 page to file, print or send on.</p>
      </div>
    </Modal>
  );
}

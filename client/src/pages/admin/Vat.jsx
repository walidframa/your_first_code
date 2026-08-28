import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Receipt } from 'lucide-react';
import api from '../../api';
import PageHeader from '../../components/PageHeader';
import {
  Button, Card, Input, LoadError, Modal, ModalActions, Select, Skeleton, cx, money, useToast,
} from '../../components/ui';

/**
 * The tax return, in three numbers.
 *
 * Charged on what was sold, less paid on what was bought, and the difference.
 * Everything else on this screen exists to let a shopkeeper check those three
 * rather than only believe them — the sales they were charged on, the rate they
 * were charged at, and what is standing on the two accounts regardless of the
 * dates in the boxes.
 *
 * That last one is the reason this screen is not just a figure and a button.
 * A shop that has never settled a return is holding every quarter it has ever
 * traded on one account, and a screen showing only the quarter asked for would
 * let it believe it owed a tenth of what it does. So both are shown, side by
 * side, labelled as what they are.
 *
 * The figures come out of the ledger, not out of the sales table. A return
 * added up from orders a second time is a second answer to the same question,
 * and when the two disagree — the first time somebody voids a sale or writes a
 * correction by hand — nothing can say which is right.
 */

/** Two dates, from names a shopkeeper actually uses. */
function periods(today = new Date()) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const y = today.getFullYear();
  const m = today.getMonth();
  const q = Math.floor(m / 3) * 3;
  return [
    { label: 'This month', from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) },
    { label: 'This quarter', from: iso(new Date(Date.UTC(y, q, 1))), to: iso(new Date(Date.UTC(y, q + 3, 0))) },
    { label: 'Last quarter', from: iso(new Date(Date.UTC(y, q - 3, 1))), to: iso(new Date(Date.UTC(y, q, 0))) },
    { label: 'This year', from: iso(new Date(Date.UTC(y, 0, 1))), to: iso(new Date(Date.UTC(y, 11, 31))) },
    { label: 'Last year', from: iso(new Date(Date.UTC(y - 1, 0, 1))), to: iso(new Date(Date.UTC(y - 1, 11, 31))) },
  ];
}

export default function Vat() {
  const toast = useToast();
  const [report, setReport] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [failed, setFailed] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [settling, setSettling] = useState(false);

  const quick = useMemo(() => periods(), []);

  const load = useCallback(async () => {
    try {
      const [ret, chart] = await Promise.all([
        api.get('/ledger/vat', { params: { ...(from ? { from } : {}), ...(to ? { to } : {}) } }),
        api.get('/ledger/accounts', { params: { activeOnly: 'true' } }),
      ]);
      setReport(ret.data);
      /* Where the money moves through when the return is settled. Assets and
         liabilities only: paying the tax office out of "Sales" is not a thing
         that can happen, and offering it invites the mistake. */
      setAccounts(
        chart.data.accounts.filter(
          (a) =>
            !a.is_group &&
            (a.type === 'asset' || a.type === 'liability') &&
            /* Not the two accounts being cleared. Settling the tax payable
               into the tax payable is a no-op the shop would only find out
               about next quarter, when it is asked for the money again. */
            a.code !== '2200' &&
            a.code !== '1250' &&
            /* Nor Suspense, which means "we do not know" and is never an
               answer to where the money went. */
            a.code !== '9999',
        ),
      );
      setFailed(null);
    } catch (err) {
      setFailed(err);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  if (failed) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Tax return" />
        <Card className="m-4">
          <LoadError error={failed} what="the tax return" onRetry={load} />
        </Card>
      </div>
    );
  }

  const name = report?.taxName || 'Tax';

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={`${name} return`}
        subtitle="What you charged, what you paid, and the difference"
        actions={
          report && (report.output !== 0 || report.input !== 0) ? (
            <Button onClick={() => setSettling(true)}>
              <Receipt size={16} />
              Settle this period
            </Button>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mb-4 max-w-4xl space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            {/* Boxed to a width rather than left to fill the row: an `Input` is
                full-width by design, and two of them in a wrapping flex row
                each take a line of their own and look like a form rather than
                a pair of dates. */}
            <div className="w-40">
              <Input label="From" name="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="w-40">
              <Input label="To" name="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="mb-0.5"
              onClick={() => {
                setFrom('');
                setTo('');
              }}
            >
              Everything
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {quick.map((p) => (
              <Button
                key={p.label}
                variant={from === p.from && to === p.to ? 'subtle' : 'secondary'}
                size="sm"
                onClick={() => {
                  setFrom(p.from);
                  setTo(p.to);
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>

        {!report ? (
          <Card className="max-w-4xl p-5"><Skeleton className="h-56 w-full" /></Card>
        ) : (
          <div className="max-w-4xl space-y-4">
            {/* A shop that has tax switched off can still land here, and the
                figures it sees would be from before it was switched off. Say
                so, rather than showing zeroes that look like a bug. */}
            {!report.enabled && (
              <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <p>
                  {name} is switched off in settings, so nothing new is being charged. Anything below
                  is from when it was on.
                </p>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <Figure
                label={`${name} charged`}
                hint="On what you sold. Held for somebody else, never yours."
                value={report.output}
              />
              <Figure
                label={`${name} paid`}
                hint="On what you bought. Comes off what you owe."
                value={report.input}
              />
              <Figure
                label={report.due >= 0 ? 'You owe' : 'You are owed'}
                hint={report.due >= 0 ? 'Charged less paid.' : 'You paid more than you charged.'}
                value={Math.abs(report.due)}
                strong
                tone={report.due >= 0 ? 'owed' : 'refund'}
              />
            </div>

            <Card className="overflow-hidden">
              <table className="w-full text-sm">
                <tbody>
                  <Row label="Sales in this period, before tax" value={money(report.netSales)} />
                  <Row label="Rate you charge" value={`${report.rate}%`} />
                  <Row
                    label={`${name} charged, all time`}
                    value={money(report.standing.output)}
                    hint="Everything on the account, not just this period"
                  />
                  <Row
                    label={`${name} paid, all time`}
                    value={money(report.standing.input)}
                    hint="Everything on the account, not just this period"
                  />
                  <Row
                    label="Standing difference"
                    value={money(report.standing.output - report.standing.input)}
                    hint="What the books say is unsettled altogether"
                    strong
                  />
                </tbody>
              </table>
            </Card>

            <p className="text-xs text-slate-500">
              These figures are read out of the ledger, so they agree with the trial balance by
              construction. This screen does not file anything and does not decide what is taxable —
              it shows what your own books say.
            </p>
          </div>
        )}
      </div>

      {settling && report && (
        <SettleModal
          report={report}
          name={name}
          accounts={accounts}
          from={from}
          to={to}
          onClose={() => setSettling(false)}
          onDone={() => {
            setSettling(false);
            toast(`${name} settled`);
            load();
          }}
          onError={(err) => toast(err.response?.data?.error || `Could not settle the ${name}`, 'error')}
        />
      )}
    </div>
  );
}

function Figure({ label, hint, value, strong, tone }) {
  return (
    <Card
      className={cx(
        'p-4',
        tone === 'owed' && 'bg-amber-50 ring-amber-200',
        tone === 'refund' && 'bg-emerald-50 ring-emerald-200',
      )}
    >
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={cx('tnum mt-1 font-semibold text-slate-900', strong ? 'text-3xl' : 'text-2xl')}>
        {money(value)}
      </p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </Card>
  );
}

function Row({ label, value, hint, strong }) {
  return (
    <tr className="border-t border-slate-100 first:border-t-0">
      <td className="px-3 py-2.5">
        <span className={cx('text-slate-800', strong && 'font-medium')}>{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </td>
      <td className={cx('tnum px-3 py-2.5 text-right text-slate-900', strong && 'font-semibold')}>{value}</td>
    </tr>
  );
}

/**
 * Settling is a real entry, so the modal says what it will write before it
 * writes it.
 *
 * Paying the tax office and telling the books it was paid are the same act; a
 * shop that does the first without the second is shown the same money owed
 * again next quarter and pays it twice.
 */
function SettleModal({ report, name, accounts, from, to, onClose, onDone, onError }) {
  const [through, setThrough] = useState(
    accounts.some((a) => a.code === '1120') ? '1120' : accounts[0]?.code || '',
  );
  const [saving, setSaving] = useState(false);

  const account = accounts.find((a) => a.code === through);
  const paying = report.due >= 0;

  const submit = async () => {
    setSaving(true);
    try {
      await api.post('/ledger/vat/settle', {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        through,
      });
      onDone();
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Settle the ${name}`}
      subtitle={from || to ? `${from || 'the start'} to ${to || 'today'}` : 'Everything on the books'}
      footer={
        <ModalActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={saving} disabled={!through}>
            {paying ? 'Record the payment' : 'Record the refund'}
          </Button>
        </ModalActions>
      }
    >
      <div className="space-y-4">
        <Select
          label={paying ? 'Paid out of' : 'Refunded into'}
          value={through}
          onChange={(e) => setThrough(e.target.value)}
          hint="Paying from the drawer and paying from the bank are different facts. Only you know which happened."
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.code}>
              {a.code} — {a.name}
            </option>
          ))}
        </Select>

        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              <Row label={`${name} charged, cleared`} value={money(report.output)} />
              <Row label={`${name} paid, reclaimed`} value={money(report.input)} />
              <Row
                label={paying ? `Paid through ${account?.name || 'the account'}` : `Reclaimed into ${account?.name || 'the account'}`}
                value={money(Math.abs(report.due))}
                strong
              />
            </tbody>
          </table>
        </Card>

        <p className="text-xs text-slate-500">
          This writes one journal entry. Both tax accounts come back to nothing for this period, so
          settling again finds nothing left to clear.
        </p>
      </div>
    </Modal>
  );
}

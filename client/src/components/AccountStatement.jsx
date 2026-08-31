import { useCallback, useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import api from '../api';
import Letterhead from './Letterhead';
import { A4, usePageSize } from '../lib/pageSize';
import { Button, Input, Modal, ModalActions, Skeleton, cx, money } from './ui';

const DOC_LABEL = {
  quotation: 'Quotation',
  sales_order: 'Sales order',
  sales_invoice: 'Sales invoice',
  purchase_invoice: 'Purchase invoice',
  payment: 'Payment voucher',
  receipt: 'Receipt voucher',
  transfer: 'Transfer voucher',
};

const day = (value) => String(value || '').slice(0, 10);
const stamp = (value) => String(value || '').slice(0, 16).replace('T', ' ');

/**
 * The account, as a page somebody can be handed.
 *
 * A shop's answer to "what do I owe you?" was spread across four screens and
 * none of them was the answer: the invoices are in Documents, the counter sales
 * in Sales, the money in Vouchers, and the balance on the contact card. A
 * supplier standing there with a folder wants one column, in date order, with a
 * running total they can follow down the page to the line they disagree with.
 *
 * Two columns rather than one signed number, because that is how every account
 * anybody has ever been sent is laid out, and a page of negative numbers is a
 * page people read wrong. What each column means depends on which side of the
 * book this is, so it is said in the header rather than assumed.
 */
export default function AccountStatement({ partyType, partyId, path, name, onClose }) {
  const [range, setRange] = useState({ from: '', to: '' });
  const [statement, setStatement] = useState(null);
  const [error, setError] = useState('');

  // A4, and only while this is open — see lib/pageSize.js, which is the one
  // thing in the app allowed to decide what size the paper is.
  usePageSize(A4);

  const base = path || `/${partyType}s/${partyId}`;

  const load = useCallback(async () => {
    setStatement(null);
    setError('');
    try {
      const res = await api.get(`${base}/statement`, {
        params: { from: range.from || undefined, to: range.to || undefined },
      });
      setStatement(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not build the statement');
    }
  }, [base, range.from, range.to]);

  useEffect(() => {
    load();
  }, [load]);

  const supplier = statement?.partyType === 'supplier';
  /*
   * Positive is outstanding on both sides of the book, so the same figure means
   * opposite things and the words have to change with it.
   */
  const chargeHead = supplier ? 'Billed' : 'Charged';
  const creditHead = supplier ? 'Paid out' : 'Received';

  const closing = statement?.totals.closing ?? 0;
  const closingWords = supplier
    ? closing > 0
      ? 'owed to them'
      : 'they owe us'
    : closing > 0
      ? 'owed to us'
      : 'in credit';

  return (
    <Modal
      open
      onClose={onClose}
      title={`Statement — ${statement?.party.name || name || ''}`}
      size="xl"
      className="print:shadow-none print:ring-0"
    >
      <div className="no-print mb-4 flex flex-wrap items-end gap-3">
        <Input
          label="From"
          type="date"
          value={range.from}
          onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          hint="Leave empty to start at the beginning"
        />
        <Input
          label="To"
          type="date"
          value={range.to}
          onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
        />
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {!statement && !error ? (
        <Skeleton className="h-72" />
      ) : (
        statement && (
          /*
           * `print-document` rather than a class of its own: a statement is the
           * same printing problem an invoice already solved — a table that can
           * run past the bottom of a page, whose header has to repeat and whose
           * rows must not be cut in half at the fold.
           */
          <div className="print-document bg-white text-slate-900">
            <Letterhead variant="sheet" className="mb-4 border-b border-slate-200 pb-4" />

            <div className="mb-4 flex items-start justify-between gap-6">
              <div>
                <p className="text-xs tracking-wide text-slate-500 uppercase">Statement of account</p>
                <p className="text-lg font-semibold">{statement.party.name}</p>
                {statement.party.phone && <p className="text-sm text-slate-500">{statement.party.phone}</p>}
                {statement.party.address && (
                  <p className="text-sm text-slate-500">{statement.party.address}</p>
                )}
              </div>
              <div className="text-right text-sm text-slate-600">
                <p>
                  {statement.period.from || 'the beginning'} to {statement.period.to || 'today'}
                </p>
                <p className="text-xs text-slate-400">Printed {day(new Date().toISOString())}</p>
              </div>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-slate-300 text-left text-xs tracking-wide text-slate-600 uppercase">
                  <th className="py-2 pr-2 font-medium">Date</th>
                  <th className="px-2 py-2 font-medium">Reference</th>
                  <th className="px-2 py-2 font-medium">Detail</th>
                  <th className="px-2 py-2 text-right font-medium">{chargeHead}</th>
                  <th className="px-2 py-2 text-right font-medium">{creditHead}</th>
                  <th className="py-2 pl-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                <tr className="border-b border-slate-100 bg-slate-50">
                  <td className="py-2 pr-2 text-slate-500">{statement.period.from || '—'}</td>
                  <td className="px-2 py-2" />
                  <td className="px-2 py-2 font-medium text-slate-700">Balance brought forward</td>
                  <td className="px-2 py-2" />
                  <td className="px-2 py-2" />
                  <td className="tnum py-2 pl-2 text-right font-medium">{money(statement.opening)}</td>
                </tr>

                {statement.lines.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-400">
                      Nothing moved on this account in this period.
                    </td>
                  </tr>
                ) : (
                  statement.lines.map((line) => (
                    <tr key={line.id} className="border-b border-slate-100">
                      <td className="py-1.5 pr-2 whitespace-nowrap text-slate-500">{stamp(line.at)}</td>
                      <td className="px-2 py-1.5 font-mono text-xs text-slate-700">
                        {line.reference || '—'}
                      </td>
                      <td className="px-2 py-1.5 text-slate-700">
                        {line.label}
                        {line.note && line.note !== line.reference && (
                          <span className="text-slate-400"> · {line.note}</span>
                        )}
                      </td>
                      <td className="tnum px-2 py-1.5 text-right">
                        {line.charge ? money(line.charge) : ''}
                      </td>
                      <td className="tnum px-2 py-1.5 text-right">
                        {line.credit ? money(line.credit) : ''}
                      </td>
                      <td className="tnum py-1.5 pl-2 text-right font-medium">{money(line.balance)}</td>
                    </tr>
                  ))
                )}

                <tr className="border-y-2 border-slate-800 font-semibold">
                  <td className="py-2 pr-2" />
                  <td className="px-2 py-2" />
                  <td className="px-2 py-2">Totals for the period</td>
                  <td className="tnum px-2 py-2 text-right">{money(statement.totals.charged)}</td>
                  <td className="tnum px-2 py-2 text-right">{money(statement.totals.paid)}</td>
                  <td className="tnum py-2 pl-2 text-right">{money(statement.totals.closing)}</td>
                </tr>
              </tbody>
            </table>

            <p
              className={cx(
                'mt-4 inline-block rounded-lg px-3 py-2 text-sm font-medium',
                Math.abs(closing) < 0.005
                  ? 'bg-slate-100 text-slate-700'
                  : closing > 0
                    ? 'bg-amber-50 text-amber-900'
                    : 'bg-brand-50 text-brand-800',
              )}
            >
              {Math.abs(closing) < 0.005
                ? 'This account is settled.'
                : `${money(Math.abs(closing))} ${closingWords} as at ${statement.period.to || day(new Date().toISOString())}.`}
            </p>

            {/*
              * An invoice paid in cash at the counter never touched the balance,
              * so it is not a line above — but the customer has it in their
              * folder and will ask why it is missing. Listed, and kept out of
              * the running total it did not change.
              */}
            {statement.alsoOnFile.length > 0 && (
              <div className="mt-5">
                <p className="mb-1.5 text-xs tracking-wide text-slate-500 uppercase">
                  Also on file, settled at the time
                </p>
                <ul className="divide-y divide-rule text-sm">
                  {statement.alsoOnFile.map((row) => (
                    <li key={`${row.kind}-${row.reference}`} className="flex justify-between gap-3 py-1.5">
                      <span className="text-slate-600">
                        <span className="font-mono text-xs text-slate-500">{row.reference}</span>{' '}
                        {DOC_LABEL[row.docType] || row.docType}
                        <span className="text-slate-400"> · {day(row.at)}</span>
                        {row.status === 'cancelled' && <span className="text-red-600"> · cancelled</span>}
                      </span>
                      <span className="tnum shrink-0 text-slate-700">{money(row.total)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )
      )}

      <ModalActions className="no-print">
        <Button variant="secondary" onClick={() => window.print()} disabled={!statement}>
          <Printer size={16} /> Print
        </Button>
        <Button className="flex-1" onClick={onClose}>
          Close
        </Button>
      </ModalActions>
    </Modal>
  );
}

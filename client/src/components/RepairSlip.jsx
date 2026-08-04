import { Printer } from 'lucide-react';
import { Button } from './ui';

const STATUS_LABEL = {
  received: 'Received',
  diagnosed: 'Diagnosed',
  awaiting_parts: 'Awaiting parts',
  repairing: 'In repair',
  ready: 'Ready to collect',
  collected: 'Collected',
  cancelled: 'Cancelled',
};

function line() {
  return <div className="my-1.5 border-t border-dashed border-black" />;
}

/**
 * The slip the customer walks out with.
 *
 * Printed on the receipt printer, so it is one narrow column of plain text —
 * no rules, no shading, nothing that depends on colour. What matters is that
 * the ticket number is unmistakable and the condition it came in is written
 * down, because that is the paragraph that settles arguments later.
 */
export default function RepairSlip({ detail, shopName = 'Front Desk POS' }) {
  const { ticket, parts, partsTotal } = detail;

  return (
    <div className="repair-slip mx-auto max-w-[300px] bg-white p-4 font-mono text-[13px] leading-snug text-black">
      <div className="text-center">
        <p className="text-[15px] font-bold uppercase">{shopName}</p>
        <p className="mt-0.5 text-[12px]">Repair ticket</p>
      </div>

      {line()}

      <p className="text-center text-[22px] font-bold tracking-wider">{ticket.ticket_number}</p>
      <p className="mt-0.5 text-center text-[12px]">{STATUS_LABEL[ticket.status]}</p>

      {line()}

      {/*
        * A grid, not a fixed-width label span: in a monospace face at this size
        * "Customer" is wider than a guessed column, so the value either ran
        * into the label or the label wrapped onto its own line.
        */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        <dt>Taken in</dt>
        <dd>{String(ticket.created_at).slice(0, 16).replace('T', ' ')}</dd>
        <dt>Customer</dt>
        <dd>{ticket.customer_name}</dd>
        {ticket.customer_phone && (
          <>
            <dt>Phone</dt>
            <dd>{ticket.customer_phone}</dd>
          </>
        )}
      </dl>

      {line()}

      <div className="space-y-0.5">
        <p className="font-bold">{ticket.device}</p>
        {ticket.imei && <p className="text-[12px]">IMEI {ticket.imei}</p>}
        <p className="mt-1">
          <span className="font-bold">Fault: </span>
          {ticket.fault}
        </p>
        {/*
          * The state it arrived in, in the customer's presence. The scratch
          * that was already there is only "already there" if it was written
          * down before the phone went behind the counter.
          */}
        {ticket.condition_note && (
          <p className="mt-1">
            <span className="font-bold">Condition in: </span>
            {ticket.condition_note}
          </p>
        )}
        {ticket.under_warranty === 1 && (
          <p className="mt-1 font-bold uppercase">*** Under warranty ***</p>
        )}
      </div>

      {parts.length > 0 && (
        <>
          {line()}
          <p className="font-bold">Parts</p>
          {parts.map((p) => (
            <p key={p.id} className="flex justify-between gap-2">
              <span>
                {p.quantity > 1 ? `${p.quantity}× ` : ''}
                {p.name}
              </span>
              <span>{p.price ? `$${(p.price * p.quantity).toFixed(2)}` : '—'}</span>
            </p>
          ))}
          <p className="flex justify-between font-bold">
            <span>Parts total</span>
            <span>${partsTotal.toFixed(2)}</span>
          </p>
        </>
      )}

      {line()}

      <p className="flex justify-between text-[15px] font-bold">
        <span>{ticket.status === 'collected' ? 'Paid' : 'Estimate'}</span>
        <span>
          {ticket.under_warranty === 1 && !ticket.charged
            ? 'No charge'
            : ticket.charged !== null && ticket.status === 'collected'
              ? `$${Number(ticket.charged).toFixed(2)}`
              : ticket.quoted !== null && ticket.quoted !== undefined
                ? `$${Number(ticket.quoted).toFixed(2)}`
                : 'to be quoted'}
        </span>
      </p>

      {line()}

      <p className="text-center text-[11px] leading-tight">
        Please bring this ticket when collecting.
        <br />
        Uncollected devices are held for 90 days.
      </p>
    </div>
  );
}

/** The print button, which the slip itself must not carry into the paper. */
export function PrintSlipButton({ children = 'Print ticket' }) {
  return (
    <Button variant="secondary" className="no-print" onClick={() => window.print()}>
      <Printer size={15} /> {children}
    </Button>
  );
}

import { Printer } from 'lucide-react';
import { lbp } from '../context/SettingsContext';
import { Button, Modal, ModalActions, money } from './ui';
import { useCompany } from './Letterhead';
import { ROLL, usePageSize } from '../lib/pageSize';

const REASONS = {
  supplier: 'Paying a supplier',
  wages: 'Wages',
  rent: 'Rent',
  utilities: 'Utilities',
  owner_draw: 'Owner took money out',
  refund: 'Refund',
  wallet_top_up: 'Buying credit',
  customer: 'Customer paying',
  owner_funds: "Owner's money in",
  deposit: 'Deposit',
  wallet_withdrawal: 'Credit taken back',
  other: 'Other',
};

const METHODS = { cash: 'Cash', bank: 'Bank transfer', card: 'Card', other: 'Other' };

function Rule() {
  return <div className="my-1.5 border-t border-dashed border-black" />;
}

/**
 * The slip that gets signed.
 *
 * A voucher is a piece of paper before it is a row: the person handed the money
 * signs to say they took it, and that signature is the whole reason the paper
 * exists. So the layout puts the amount where it cannot be misread and leaves
 * room at the bottom for two names and a pen.
 *
 * Printed on the same receipt printer as a repair ticket — one narrow column of
 * plain text, nothing that depends on colour.
 */
export function VoucherPaper({ voucher }) {
  const paying = voucher.kind === 'payment';
  const company = useCompany();
  // A slip goes on the till roll, and says so rather than relying on whatever
  // the last thing printed happened to leave the paper set to.
  usePageSize(ROLL);

  return (
    <div className="print-slip mx-auto max-w-[300px] bg-white p-4 font-mono text-[13px] leading-snug text-black">
      <div className="text-center">
        <p className="text-[15px] font-bold uppercase">{company.name}</p>
        {company.phones && <p className="text-[11px]">{company.phones}</p>}
        <p className="mt-0.5 text-[12px] font-bold uppercase">
          {paying ? 'Payment voucher' : 'Receipt voucher'}
        </p>
      </div>

      <Rule />

      <p className="text-center text-[20px] font-bold tracking-wider">{voucher.voucher_number}</p>
      {voucher.status === 'cancelled' && (
        <p className="mt-0.5 text-center text-[12px] font-bold uppercase">— Cancelled —</p>
      )}

      <Rule />

      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        <dt>Date</dt>
        <dd>{voucher.issued_on}</dd>
        <dt>{paying ? 'Paid to' : 'Received from'}</dt>
        <dd className="font-bold">{voucher.account_name}</dd>
        {voucher.reason && (
          <>
            <dt>For</dt>
            <dd>{REASONS[voucher.reason] || voucher.reason}</dd>
          </>
        )}
        {voucher.reference && (
          <>
            <dt>Ref</dt>
            <dd>{voucher.reference}</dd>
          </>
        )}
        <dt>By</dt>
        <dd>{METHODS[voucher.method] || voucher.method}</dd>
      </dl>

      <Rule />

      {/* The figure, in the size somebody can check across a counter. */}
      <div className="text-center">
        <p className="text-[11px] uppercase">Amount</p>
        {voucher.amount_usd > 0 && (
          <p className="text-[22px] font-bold">{money(voucher.amount_usd)}</p>
        )}
        {voucher.amount_lbp > 0 && (
          <p className="text-[16px] font-bold">{lbp(voucher.amount_lbp)}</p>
        )}
      </div>

      {voucher.note && (
        <>
          <Rule />
          <p className="text-[12px]">{voucher.note}</p>
        </>
      )}

      <Rule />

      {/* Two lines and a pen: the point of the whole document. */}
      <div className="mt-4 grid grid-cols-2 gap-3 text-[11px]">
        <div>
          <div className="border-t border-black pt-1">{paying ? 'Received by' : 'Paid by'}</div>
        </div>
        <div>
          <div className="border-t border-black pt-1">For the shop</div>
        </div>
      </div>

      <p className="mt-3 text-center text-[11px]">
        {voucher.user_name ? `Issued by ${voucher.user_name}` : ''}
      </p>
    </div>
  );
}

export default function VoucherSlip({ voucher, onClose }) {
  return (
    <Modal
      open
      onClose={onClose}
      title={voucher.voucher_number}
      subtitle={voucher.kind === 'payment' ? 'Payment voucher' : 'Receipt voucher'}
      footer={
        <ModalActions>
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Close
          </Button>
          <Button className="flex-1" onClick={() => window.print()}>
            <Printer size={16} /> Print
          </Button>
        </ModalActions>
      }
    >
      <div className="rounded-xl bg-slate-100 p-4">
        <VoucherPaper voucher={voucher} />
      </div>
    </Modal>
  );
}

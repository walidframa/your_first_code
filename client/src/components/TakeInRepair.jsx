import { useState } from 'react';
import { Wrench } from 'lucide-react';
import api from '../api';
import RepairSlip, { PrintSlipButton } from './RepairSlip';
import WhatsAppButton from './WhatsAppButton';
import CustomerField from './CustomerField';
import { Button, Input, Modal, ModalActions, useToast } from './ui';

/**
 * Taking a phone in, at the counter.
 *
 * A repair starts where the customer is standing, not in the back office — and
 * it ends with a piece of paper, because the ticket is what they bring back to
 * prove the phone on the shelf is theirs. So this is deliberately short: the
 * six things that have to be written down while somebody waits, and then the
 * slip, printed straight away.
 *
 * The fuller intake form is still in Admin → Repairs, for when the IMEI and the
 * scratch on the back matter enough to type them.
 */
export default function TakeInRepair({ onClose, onTaken }) {
  const toast = useToast();
  const [form, setForm] = useState({
    customerId: null,
    customerName: '',
    customerPhone: '',
    device: '',
    fault: '',
    passcode: '',
    quoted: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // The finished ticket: once it exists, this dialog becomes the slip.
  const [detail, setDetail] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.post('/repairs', {
        ...form,
        quoted: form.quoted === '' ? null : Number(form.quoted),
      });
      setDetail(res.data);
      toast(`${res.data.ticket.ticket_number} taken in`);
      onTaken?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not take that in');
    } finally {
      setSaving(false);
    }
  }

  /*
   * Straight to the paper. The customer is still at the counter and the whole
   * point of the ticket is that they walk out holding it — a dialog that closed
   * on save would mean finding the job again in a list to print it.
   */
  if (detail) {
    return (
      <Modal
        open
        onClose={onClose}
        title={`${detail.ticket.ticket_number} taken in`}
        subtitle="Print this and hand it over — it is what they bring back"
      >
        <RepairSlip detail={detail} />
        <ModalActions className="no-print">
          <PrintSlipButton>Print the ticket</PrintSlipButton>
          {/*
            * And to their phone, because the paper slip is the thing that goes
            * missing between dropping a phone off and coming back for it. The
            * number was just typed in above, so it is almost always known.
            */}
          <WhatsAppButton path={`/repairs/${detail.ticket.id}/whatsapp`} label="WhatsApp" />
          <Button className="flex-1" onClick={onClose}>
            Done
          </Button>
        </ModalActions>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="Take in a repair" subtitle="Write it down while they are here">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          {/*
            * A regular gets picked off the list and the ticket joins their
            * account; a stranger gets typed. See CustomerField.
            */}
          <CustomerField
            value={form}
            onChange={(next) => setForm((f) => ({ ...f, ...next }))}
            autoFocus
          />
          <Input
            label="Phone number"
            name="customerPhone"
            value={form.customerPhone}
            onChange={set('customerPhone')}
            placeholder="e.g. 03 123 456"
            hint="So you can ring when it is ready"
          />
          <Input
            label="Phone type"
            name="device"
            value={form.device}
            onChange={set('device')}
            placeholder="e.g. iPhone 12 Pro, black"
            required
            className="col-span-2"
          />
        </div>

        <div>
          <label htmlFor="fault" className="mb-1.5 block text-sm font-medium text-slate-700">
            What is wrong with it
          </label>
          <textarea
            id="fault"
            name="fault"
            rows={2}
            value={form.fault}
            onChange={set('fault')}
            required
            placeholder="e.g. screen cracked, does not charge, no sound on calls"
            className="w-full rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-edge transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Passcode / PIN"
            name="passcode"
            value={form.passcode}
            onChange={set('passcode')}
            placeholder="e.g. 1234, or a pattern"
            hint="Encrypted, and never printed on the ticket"
          />
          <Input
            label="Repair price"
            name="quoted"
            type="number"
            min="0"
            step="0.01"
            value={form.quoted}
            onChange={set('quoted')}
            placeholder="0.00"
            hint="Leave empty to quote after looking at it"
          />
        </div>

        {/*
          * Said plainly, because handing over a passcode is a real thing to ask
          * of somebody and they deserve to know where it goes.
          */}
        <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
          The passcode is stored encrypted and does not appear on the printed ticket. Only somebody who
          may reveal saved passwords can read it back.
        </p>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving}>
            <Wrench size={16} /> Take it in
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

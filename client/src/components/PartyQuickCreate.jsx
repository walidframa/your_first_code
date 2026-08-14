import { useEffect, useState } from 'react';
import api from '../api';
import { Button, Input, Modal, ModalActions, useToast } from './ui';

/**
 * Add a customer or a supplier without leaving the document you are writing.
 *
 * A walk-in asking for a quotation, or a delivery from a supplier the shop has
 * never bought from before, both arrive in the middle of writing the document
 * — and the old answer was to abandon it, cross to another screen, create the
 * contact, and start again. The lines typed so far were lost every time.
 *
 * Deliberately shorter than the full contact form. A name is all that is
 * required; the phone is asked for because it is what the shop actually rings,
 * and everything else — address, notes, credit limit — is left to the
 * customers and suppliers screens, where there is room to think about it.
 */
export default function PartyQuickCreate({ open, partyType, onClose, onCreated }) {
  const toast = useToast();
  const isCustomer = partyType === 'customer';
  const label = isCustomer ? 'customer' : 'supplier';

  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /* A fresh form each time it opens — the last one's half-typed name is not
   * this one's, and inheriting it silently creates the wrong contact. */
  useEffect(() => {
    if (!open) return;
    setForm({ name: '', phone: '', email: '' });
    setError('');
  }, [open, partyType]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.post(`/${partyType}s`, {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
      });
      toast(`${res.data.party.name} added`);
      onCreated(res.data.party);
    } catch (err) {
      /*
       * A 403 here is not a broken form. Creating contacts sits behind its own
       * permission, and a cashier who has not got it should be told which
       * screen — and which colleague — can, rather than shown a bare failure.
       */
      setError(
        err.response?.status === 403
          ? `You are not allowed to add a ${label}. Ask somebody with the customers and suppliers permission.`
          : err.response?.data?.error || `Could not add the ${label}`,
      );
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`New ${label}`}
      subtitle="They will be put on this document"
    >
      <form onSubmit={submit} className="space-y-4">
        <Input label="Name" name="name" value={form.name} onChange={set('name')} required autoFocus />
        <Input
          label="Phone"
          name="phone"
          value={form.phone}
          onChange={set('phone')}
          hint="Used for sending the document on WhatsApp"
        />
        <Input label="Email" name="email" type="email" value={form.email} onChange={set('email')} />

        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          {isCustomer
            ? 'Address, notes and a credit limit can be filled in later on the Customers screen.'
            : 'Address and notes can be filled in later on the Suppliers screen.'}
        </p>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <ModalActions>
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" className="flex-1" loading={saving} disabled={!form.name.trim()}>
            Add and use
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

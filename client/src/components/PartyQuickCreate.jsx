import { useEffect, useState } from 'react';
import api from '../api';
import { Button, Input, Modal, ModalActions, useToast } from './ui';
import useDuplicateParty from '../lib/useDuplicateParty';

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
  const [refused, setRefused] = useState(null);
  const { duplicate, message: duplicateMessage } = useDuplicateParty(partyType, {
    name: form.name,
    phone: form.phone,
    enabled: open,
  });

  /* A fresh form each time it opens — the last one's half-typed name is not
   * this one's, and inheriting it silently creates the wrong contact. */
  useEffect(() => {
    if (!open) return;
    setForm({ name: '', phone: '', email: '' });
    setError('');
    setRefused(null);
  }, [open, partyType]);

  const set = (key) => (e) => {
    setRefused(null);
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  async function submit(e, allowDuplicate = false) {
    e?.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.post(`/${partyType}s`, {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        allowDuplicate,
      });
      toast(`${res.data.party.name} added`);
      onCreated(res.data.party);
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.duplicate) {
        setRefused(err.response.data);
        setSaving(false);
        return;
      }
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

        {(refused || duplicate) && (
          <div
            role="alert"
            data-duplicate-party
            className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
          >
            <p className="font-medium">{refused?.error || duplicateMessage}</p>
            <p className="mt-0.5 text-xs text-amber-800">
              {(refused?.duplicate || duplicate).name}
              {(refused?.duplicate || duplicate).phone ? ` · ${(refused?.duplicate || duplicate).phone}` : ''}
              {' — '}pick them from the list instead, or add anyway if it really is somebody else.
            </p>
            {refused && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-2"
                loading={saving}
                onClick={(e) => submit(e, true)}
              >
                Add anyway — it is somebody else
              </Button>
            )}
          </div>
        )}

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

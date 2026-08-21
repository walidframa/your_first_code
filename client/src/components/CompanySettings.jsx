import { useEffect, useRef, useState } from 'react';
import { Building2, ImageUp, Save, Trash2 } from 'lucide-react';
import api from '../api';
import Letterhead from './Letterhead';
import { useSettings } from '../context/SettingsContext';
import { Button, Card, CardHeader, Input, Skeleton, useToast } from './ui';

/*
 * A logo goes on a receipt about 40mm wide and on an A4 letterhead about 35mm,
 * so a small PNG is all it ever needs. Stored inline as a data: URI rather than
 * uploaded, because a shop on one server should not need somewhere to put files
 * — and the size cap is what keeps that honest.
 */
const MAX_LOGO_BYTES = 400 * 1024;

const FIELDS = [
  ['company_name', 'Company name', 'e.g. Rami Mobile', { required: true }],
  ['company_tagline', 'Tagline', 'e.g. Phones, accessories and repairs'],
  ['company_phone', 'Phone', 'e.g. 03 123 456'],
  ['company_phone2', 'Second phone', 'e.g. 01 987 654'],
  ['company_email', 'Email', 'e.g. shop@example.com'],
  ['company_website', 'Website', 'e.g. facebook.com/ramimobile'],
  ['company_tax_number', 'VAT / MOF number', 'Printed on invoices'],
  /*
   * Not printed anywhere — it is what turns a number written down as 03 123 456
   * into one WhatsApp will accept. Here because it belongs with the shop's own
   * details, and because a shop outside Lebanon has to be able to change it.
   */
  [
    'phone_country_code',
    'Dialling code',
    'e.g. 961 for Lebanon',
    { hint: 'Used to send receipts on WhatsApp, not printed anywhere' },
  ],
];

/**
 * Who the shop is, on everything a customer keeps.
 *
 * The preview is the point of this screen: these fields are only ever seen on a
 * printed receipt or an invoice, so typing them into a form with no idea how
 * they will come out is how a phone number ends up wrapped across two lines on
 * every slip for a month.
 */
export default function CompanySettings() {
  const toast = useToast();
  const { settings, refresh } = useSettings();
  const fileRef = useRef(null);

  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!settings) return;
    setForm({
      ...Object.fromEntries(FIELDS.map(([key]) => [key, settings[key] || ''])),
      company_address: settings.company_address || '',
      company_logo_url: settings.company_logo_url || '',
      receipt_footer: settings.receipt_footer || '',
    });
  }, [settings]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  /*
   * Read the file in the browser and keep it as a data: URI. One less moving
   * part than an upload endpoint, and the logo then travels with the settings —
   * including into a backup.
   */
  function pickLogo(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('That is not an image');
      return;
    }
    // Checked before reading: base64 is about a third larger again, and the
    // limit that matters is what gets stored.
    if (file.size > MAX_LOGO_BYTES * 0.7) {
      setError('That logo is too big — keep it under about 280KB. It prints at 40mm wide.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setError('');
      setForm((f) => ({ ...f, company_logo_url: String(reader.result) }));
    };
    reader.onerror = () => setError('Could not read that file');
    reader.readAsDataURL(file);
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.put('/settings', form);
      await refresh();
      toast('Company details saved');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the company details');
    } finally {
      setSaving(false);
    }
  }

  if (!form) return <Skeleton className="h-72" />;

  const dirty = settings && FIELDS.concat([['company_address'], ['company_logo_url'], ['receipt_footer']])
    .some(([key]) => (form[key] || '') !== (settings[key] || ''));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card className="p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Building2 size={15} className="text-brand-600" /> Your company
        </h2>
        <p className="mt-0.5 mb-4 text-xs text-slate-500">
          Printed at the top of every receipt, invoice, repair ticket and voucher — so a customer
          holding one can find you again.
        </p>

        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map(([key, label, placeholder, options]) => (
              <Input
                key={key}
                label={label}
                name={key}
                placeholder={placeholder}
                value={form[key]}
                onChange={set(key)}
                hint={options?.hint}
                required={options?.required}
                className={key === 'company_name' ? 'sm:col-span-2' : undefined}
              />
            ))}
          </div>

          <div>
            <label htmlFor="company_address" className="mb-1.5 block text-sm font-medium text-slate-700">
              Address
            </label>
            <textarea
              id="company_address"
              name="company_address"
              rows={2}
              value={form.company_address}
              onChange={set('company_address')}
              placeholder={'e.g. Main Street, Achrafieh\nBeirut, Lebanon'}
              className="w-full rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-edge transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
            />
            <p className="mt-1 text-xs text-slate-500">Line breaks are kept, so it prints as you type it.</p>
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-medium text-slate-700">Logo</span>
            <div className="flex items-start gap-3">
              {form.company_logo_url ? (
                <img
                  src={form.company_logo_url}
                  alt="Company logo"
                  className="h-16 w-24 shrink-0 rounded-lg object-contain ring-1 ring-slate-200"
                />
              ) : (
                <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded-lg text-xs text-slate-400 ring-1 ring-dashed ring-edge">
                  none
                </div>
              )}
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
                    <ImageUp size={14} /> Choose an image
                  </Button>
                  {form.company_logo_url && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setForm((f) => ({ ...f, company_logo_url: '' }))}
                    >
                      <Trash2 size={14} /> Remove
                    </Button>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  onChange={pickLogo}
                  className="hidden"
                  aria-label="Choose a logo image"
                />
                <Input
                  label="…or paste a link"
                  name="company_logo_url"
                  value={form.company_logo_url.startsWith('data:') ? '' : form.company_logo_url}
                  onChange={set('company_logo_url')}
                  placeholder="https://…"
                  hint={
                    form.company_logo_url.startsWith('data:')
                      ? 'An image is stored in the app itself. Remove it to use a link instead.'
                      : 'Prints at about 40mm wide, so a small image is plenty.'
                  }
                  disabled={form.company_logo_url.startsWith('data:')}
                />
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="receipt_footer" className="mb-1.5 block text-sm font-medium text-slate-700">
              Receipt footer
            </label>
            <textarea
              id="receipt_footer"
              name="receipt_footer"
              rows={2}
              value={form.receipt_footer}
              onChange={set('receipt_footer')}
              placeholder="e.g. Exchange within 7 days with this receipt. Thank you!"
              className="w-full rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-edge transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <Button type="submit" loading={saving} disabled={!dirty}>
            <Save size={15} /> {dirty ? 'Save company details' : 'Saved'}
          </Button>
        </form>
      </Card>

      {/*
        * Shown as it will print. These fields are only ever seen on paper, and a
        * form with no preview is how a phone number ends up wrapping onto its
        * own line on every slip for a month before anybody notices.
        */}
      <Card className="h-fit">
        <CardHeader title="On a receipt" subtitle="How it comes out on the roll" />
        <div className="px-5 pb-5">
          <div className="rounded-lg bg-slate-50 p-4">
            <Letterhead className="border-b border-dashed border-slate-300 pb-3" />
            <p className="mt-3 text-center text-[11px] text-slate-400">— items and totals —</p>
            {form.receipt_footer.trim() && (
              <p className="mt-3 border-t border-dashed border-slate-300 pt-3 text-center text-[11px] whitespace-pre-line text-slate-500">
                {form.receipt_footer}
              </p>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Save first — the preview follows what is stored, not what is typed.
          </p>
        </div>
      </Card>
    </div>
  );
}

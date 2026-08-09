import { useSettings } from '../context/SettingsContext';
import { cx } from './ui';

/**
 * The shop's details as plain values.
 *
 * For the thermal slips, which are a monospace column printed by a blunt head
 * and lay themselves out — they need the facts, not a styled block.
 */
export function useCompany() {
  const { settings } = useSettings();
  return {
    name: settings?.company_name || 'Front Desk POS',
    tagline: settings?.company_tagline || '',
    address: settings?.company_address || '',
    phones: [settings?.company_phone, settings?.company_phone2].filter(Boolean).join(' · '),
    email: settings?.company_email || '',
    website: settings?.company_website || '',
    taxNumber: settings?.company_tax_number || '',
    logo: settings?.company_logo_url || '',
    receiptFooter: settings?.receipt_footer || '',
  };
}

/**
 * Who the shop is, at the top of anything a customer keeps.
 *
 * One component rather than a header written out in each of the receipt, the
 * invoice and the repair slip — because the moment they are written separately
 * is the moment the phone number gets changed in two of the three, and the
 * customer holding the third calls a line that no longer answers.
 *
 * `variant` is about the paper, not the styling: a thermal roll is 72mm of
 * cheap paper printed by a blunt head, so it gets a narrow centred block in
 * plain black; an A4 document gets the logo beside the details.
 */
export default function Letterhead({ variant = 'slip', className, subtitle }) {
  const { settings } = useSettings();
  if (!settings) return null;

  const {
    company_name: name,
    company_tagline: tagline,
    company_phone: phone,
    company_phone2: phone2,
    company_address: address,
    company_email: email,
    company_website: website,
    company_tax_number: taxNumber,
    company_logo_url: logo,
  } = settings;

  const phones = [phone, phone2].filter(Boolean).join(' · ');

  if (variant === 'sheet') {
    return (
      <header className={cx('flex items-start justify-between gap-6', className)}>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-slate-900">{name}</h1>
          {tagline && <p className="text-sm text-slate-500">{tagline}</p>}
          <div className="mt-1 space-y-0.5 text-xs text-slate-500">
            {address && <p className="whitespace-pre-line">{address}</p>}
            {phones && <p>{phones}</p>}
            {(email || website) && <p>{[email, website].filter(Boolean).join(' · ')}</p>}
            {taxNumber && <p>VAT / MOF: {taxNumber}</p>}
          </div>
        </div>
        {logo && (
          <img
            src={logo}
            alt=""
            className="max-h-16 max-w-[9rem] shrink-0 object-contain"
            /* A broken logo URL must not leave a torn-image icon on an invoice
               that is about to be handed to somebody. */
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        )}
        {subtitle && <p className="sr-only">{subtitle}</p>}
      </header>
    );
  }

  return (
    <header className={cx('text-center', className)}>
      {logo && (
        <img
          src={logo}
          alt=""
          className="mx-auto mb-1.5 max-h-14 max-w-[8rem] object-contain"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      )}
      <p className="text-sm font-semibold text-slate-900">{name}</p>
      {tagline && <p className="text-[11px] text-slate-500">{tagline}</p>}
      {address && <p className="text-[11px] whitespace-pre-line text-slate-500">{address}</p>}
      {phones && <p className="text-[11px] text-slate-500">{phones}</p>}
      {taxNumber && <p className="text-[11px] text-slate-500">VAT / MOF: {taxNumber}</p>}
      {subtitle && <p className="mt-1 text-[11px] text-slate-400">{subtitle}</p>}
    </header>
  );
}

/**
 * The line at the foot of a receipt — returns policy, opening hours, thank you.
 * Nothing at all when the shop has not set one, rather than an empty gap.
 */
export function ReceiptFooter({ className }) {
  const { settings } = useSettings();
  const text = settings?.receipt_footer?.trim();
  if (!text) return null;
  return (
    <p className={cx('text-center text-[11px] whitespace-pre-line text-slate-500', className)}>
      {text}
    </p>
  );
}

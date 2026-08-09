import { useRef, useState } from 'react';
import { Barcode, Star, X } from 'lucide-react';
import { cx } from './ui';

/**
 * Every barcode a product answers to.
 *
 * Scan one and it lands as a chip; scan the next and it lands beside it. That
 * is how the numbers actually arrive — the maker's EAN on the box, the
 * distributor's label stuck over it, the shop's own printed for loose stock —
 * and the alternative a one-field form pushes you towards is a second product
 * per barcode, which splits the stock of one thing in two.
 *
 * A scanner is a keyboard that types fast and presses Enter, so Enter is what
 * commits a code. It also commits on blur: plenty of people type a number and
 * then reach straight for Save, and a barcode left sitting in the box, unsaved,
 * would be the most annoying possible way to lose one.
 *
 * The first is the primary — the one printed on a label and sent to Shopify —
 * so it is marked, and any of the others can be promoted.
 */
export default function BarcodeField({ value = [], onChange, label = 'Barcodes', hint, autoFocus }) {
  const [typing, setTyping] = useState('');
  const [problem, setProblem] = useState('');
  const inputRef = useRef(null);

  function add(raw) {
    // Scanners append a newline, and a pasted code arrives padded. Neither is
    // part of the number, and a stored code with a space matches nothing.
    const code = String(raw || '').replace(/\s+/g, '');
    if (!code) return;

    if (value.includes(code)) {
      // Scanning the same box twice is a slip, not an error — say so and move on.
      setProblem(`${code} is already on this product`);
      setTyping('');
      return;
    }
    setProblem('');
    onChange([...value, code]);
    setTyping('');
  }

  const remove = (code) => onChange(value.filter((c) => c !== code));
  /** Promote to primary: the one that gets printed and pushed to Shopify. */
  const makePrimary = (code) => onChange([code, ...value.filter((c) => c !== code)]);

  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>

      {value.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {value.map((code, index) => (
            <li
              key={code}
              className={cx(
                'flex items-center gap-1.5 rounded-lg py-1 pr-1 pl-2 text-sm ring-1',
                index === 0 ? 'bg-brand-50 text-brand-800 ring-brand-200' : 'bg-slate-50 text-slate-700 ring-slate-200',
              )}
            >
              {index === 0 ? (
                <Star size={12} className="shrink-0 fill-current" aria-label="Primary barcode" />
              ) : (
                <button
                  type="button"
                  onClick={() => makePrimary(code)}
                  title="Make this the primary barcode"
                  aria-label={`Make ${code} the primary barcode`}
                  className="shrink-0 rounded text-slate-300 transition hover:text-amber-500"
                >
                  <Star size={12} />
                </button>
              )}
              <span className="font-mono">{code}</span>
              <button
                type="button"
                onClick={() => remove(code)}
                aria-label={`Remove barcode ${code}`}
                className="rounded p-0.5 text-slate-400 transition hover:bg-white hover:text-red-600"
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="relative">
        <Barcode
          size={16}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
        />
        <input
          ref={inputRef}
          name="barcode"
          value={typing}
          autoFocus={autoFocus}
          onChange={(e) => setTyping(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // The form would otherwise submit on the scanner's Enter, saving
              // the product halfway through entering its barcodes.
              e.preventDefault();
              add(typing);
            }
            // Backspace on an empty box takes the last one off, the way every
            // tag field does.
            if (e.key === 'Backspace' && !typing && value.length > 0) {
              remove(value[value.length - 1]);
            }
          }}
          onBlur={() => add(typing)}
          placeholder="Scan or type a barcode, then press Enter"
          aria-label="Add a barcode"
          className="h-10 w-full rounded-lg bg-white pr-3 pl-9 text-sm ring-1 ring-slate-300 transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
        />
      </div>

      <p className={cx('mt-1 text-xs', problem ? 'text-amber-700' : 'text-slate-500')}>
        {problem ||
          hint ||
          (value.length > 1
            ? `${value.length} barcodes — any of them finds this product. The starred one gets printed.`
            : 'Scan as many as you like — the same product can answer to several.')}
      </p>
    </div>
  );
}

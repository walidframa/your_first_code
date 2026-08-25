import { useRef, useState } from 'react';
import { Barcode, Sparkles, Star, X } from 'lucide-react';
import api from '../api';
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
  const [making, setMaking] = useState(false);
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

  /**
   * Invent one, for the things that arrive without a number.
   *
   * Loose stock, a used handset, a part out of a drawer — plenty of what a shop
   * sells has nothing printed on it, and until now the shop typed a number it
   * made up. That goes wrong twice: a number another product already answers
   * to, and a number that is not a valid EAN-13, which prints as a label this
   * app's own scanner then refuses to believe.
   *
   * Asked of the server rather than rolled here, because the one thing that
   * makes a generated code worth having is that nothing else carries it, and
   * only the server can know that.
   */
  async function generate() {
    setMaking(true);
    setProblem('');
    try {
      const res = await api.get('/products/next-barcode');
      add(res.data.barcode);
      inputRef.current?.focus();
    } catch (err) {
      setProblem(err.response?.data?.error || 'Could not make a barcode');
    } finally {
      setMaking(false);
    }
  }

  const remove = (code) => onChange(value.filter((c) => c !== code));
  /** Promote to primary: the one that gets printed and pushed to Shopify. */
  const makePrimary = (code) => onChange([code, ...value.filter((c) => c !== code)]);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="block text-sm font-medium text-slate-700">{label}</span>
        {/* Beside the label rather than under the box: it is an alternative to
            scanning, so it belongs where the eye is before the scanning
            starts, not after the box has already been used. */}
        <button
          type="button"
          onClick={generate}
          disabled={making}
          title="Make one up — a valid EAN-13 no other product uses"
          className="-my-1 flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm font-medium text-brand-700 transition hover:bg-brand-50 disabled:opacity-50"
        >
          <Sparkles size={14} /> {making ? 'Making…' : 'Generate'}
        </button>
      </div>

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
          className="h-10 w-full rounded-lg bg-white pr-3 pl-9 text-sm ring-1 ring-edge transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
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

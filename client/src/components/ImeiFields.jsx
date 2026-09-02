import { useRef } from 'react';
import { formatImeis, handsetSlots, digitsOf } from '../lib/imei';
import { cx } from './ui';

/**
 * The numbers off the boxes, one box per number.
 *
 * This was a single textarea, and the shop was asked to keep two rules in its
 * head while holding a scanner: one handset per line, both numbers of a
 * dual-SIM separated by a comma. Neither rule is visible, both are easy to get
 * wrong at a counter, and getting them wrong is only found out at the confirm.
 *
 * So the shape of the delivery is drawn instead. Three handsets on the line is
 * three pairs of boxes, labelled, from the moment the quantity says three —
 * there is nothing to remember and nothing to punctuate.
 *
 * **The scanner is the point.** A barcode reader types the digits and then
 * sends a key — Enter on most, Tab on some. Both move to the next box here, so
 * a shop scans IMEI 1, IMEI 2, then the next phone's IMEI 1, without touching
 * the keyboard. A reader that sends no key at all is covered too: a box that
 * has taken a whole fifteen-digit number hands focus on by itself.
 *
 * The value on the way in and out is still the one string the document stores,
 * so nothing else had to learn a new shape — see lib/imei.js, which formats and
 * parses it the way the server does.
 */
export default function ImeiFields({ value, quantity, productName, onChange }) {
  /*
   * Every box in scan order — phone 1's two, then phone 2's, and so on — so
   * "the next one" is the next index and needs no arithmetic at the call site.
   */
  const boxes = useRef([]);
  /*
   * When the box moved on by itself, so the key the reader sends next does not
   * move on a second time.
   *
   * A reader types fifteen digits and then presses Enter. Both of those are
   * reasons to advance, and taken separately they advance twice — the scan
   * lands in IMEI 1, focus goes to IMEI 2, and the Enter that arrives a
   * millisecond later carries it straight past to the next phone. The shop
   * scans two numbers and finds them on two different handsets.
   */
  const advancedAt = useRef(0);
  const slots = handsetSlots(value, quantity);

  const write = (index, slot, text) => {
    const next = slots.map((s, i) => (i === index ? { ...s, [slot]: digitsOf(text) } : s));
    onChange(formatImeis(next));
  };

  const focusNext = (from) => {
    const next = boxes.current[from + 1];
    if (next) {
      next.focus();
      next.select?.();
    }
  };

  const wanted = Math.max(0, Math.floor(Number(quantity) || 0));
  const filled = slots.filter((s) => digitsOf(s.imei)).length;

  return (
    <div className="mt-1.5">
      <ul className="space-y-1.5">
        {slots.map((slot, phone) => (
          <li key={phone} className="flex items-center gap-1.5">
            {/*
              * Numbered, because a delivery of six is six pairs of identical
              * boxes and the only way to know which phone you are on is to be
              * told. Hidden when there is only one — a shop booking in a single
              * handset does not need it counted.
              */}
            {slots.length > 1 && (
              <span className="tnum w-5 shrink-0 text-right text-xs text-slate-400">{phone + 1}</span>
            )}

            {['imei', 'imei2'].map((which, half) => {
              const index = phone * 2 + half;
              return (
                <input
                  key={which}
                  ref={(el) => {
                    boxes.current[index] = el;
                  }}
                  value={slot[which] || ''}
                  inputMode="numeric"
                  autoComplete="off"
                  aria-label={`${productName} handset ${phone + 1} IMEI ${half + 1}`}
                  placeholder={half === 0 ? 'IMEI 1' : 'IMEI 2 (dual-SIM)'}
                  onChange={(e) => {
                    const typed = digitsOf(e.target.value);
                    write(phone, which, typed);
                    /*
                     * A reader that sends no key of its own still moves on.
                     * Fifteen digits is a whole IMEI, so there is nothing more
                     * to type into this box — and a shop that meant to correct
                     * one clicks back into it, which is one click against a
                     * scan of six handsets that would otherwise all land in the
                     * first box.
                     */
                    if (typed.length >= 15) {
                      advancedAt.current = Date.now();
                      focusNext(index);
                    }
                  }}
                  onKeyDown={(e) => {
                    /*
                     * Enter is what most readers send, and it must not submit
                     * the half-typed invoice behind this. Tab already moves on
                     * by itself, so it is left alone.
                     */
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      // The box below already moved for this scan. A reader's
                      // Enter arrives within a millisecond of its last digit.
                      if (Date.now() - advancedAt.current < 500) return;
                      focusNext(index);
                    }
                  }}
                  className={cx(
                    'h-8 min-w-0 flex-1 rounded-lg bg-white px-2 font-mono text-xs ring-1 transition',
                    'focus:ring-2 focus:ring-brand-600 focus:outline-none',
                    half === 0 && !slot.imei ? 'ring-amber-300' : 'ring-edge',
                  )}
                />
              );
            })}
          </li>
        ))}
      </ul>

      <p className={cx('mt-1 text-xs', filled === wanted ? 'text-brand-700' : 'text-amber-700')}>
        {filled} of {wanted} handset{wanted === 1 ? '' : 's'} — scan into the first box and it moves
        on by itself. The second is only for a dual-SIM.
      </p>
    </div>
  );
}

import { useState } from 'react';
import { useSettings, lbp } from '../context/SettingsContext';
import { Input, cx } from './ui';

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * A figure that is pounds, full stop.
 *
 * Not every amount is dollars-with-a-way-to-type-pounds. A transfer agency's
 * opening balance is two separate piles — what is owed in dollars and what is
 * owed in pounds — and the pound pile is stored in pounds, so offering to
 * "switch" it to dollars is offering to convert the number being saved into
 * something else.
 *
 * Its own component rather than a mode of the one below, because the two differ
 * in what `value` even means: dollars there, pounds here. A prop that changed
 * the meaning of another prop was exactly the confusion that produced three
 * different numbers for one box — `289` sent as pounds, sitting in a field
 * labelled dollars, under a line reading 25,721,000 LL.
 */
export function PoundsInput({ label, name, value, onChange, hint, ...props }) {
  return (
    <div className="w-full">
      <label htmlFor={name} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <Input
        name={name}
        id={name}
        type="number"
        min="0"
        step="1000"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...props}
      />
      <p className="mt-1 text-xs text-slate-500">
        {Number(value) > 0 ? lbp(Number(value)) : hint || 'Lebanese pounds'}
      </p>
    </div>
  );
}

/**
 * A figure that can be typed in either currency.
 *
 * Half of what this shop pays for is quoted in pounds — a dealer says "six
 * hundred and eighty thousand", not "seven dollars fifty-eight" — and doing
 * that division in your head at the counter is how a cost ends up wrong by a
 * factor of ten and nobody notices until the margins look strange.
 *
 * Dollars remain what is stored, always. The pound box is a way of typing, not
 * a second field: switch to LL, type the dealer's figure, and the dollars are
 * worked out at today's rate and sent. Switch back and the pounds are forgotten
 * — keeping them would mean a cost that quietly changed every time the rate
 * moved, which is not what a cost is.
 */
export default function MoneyInput({ label, name, value, onChange, hint, ...props }) {
  const { rate } = useSettings();
  const [currency, setCurrency] = useState('USD');

  // What the stored dollars are worth in pounds, for the box to start from.
  const asLbp = rate > 0 && value !== '' ? String(Math.round(Number(value) * rate)) : '';
  const [pounds, setPounds] = useState(asLbp);

  function typePounds(next) {
    setPounds(next);
    onChange(next === '' ? '' : String(round2(Number(next) / rate)));
  }

  function switchTo(nextCurrency) {
    // Starting from what the figure already is, rather than from empty: the
    // usual reason to switch is to check a price, not to retype it.
    if (nextCurrency === 'LBP') setPounds(asLbp);
    setCurrency(nextCurrency);
  }

  const inPounds = currency === 'LBP';
  // Nothing to convert with, so there is nothing honest to offer.
  const canSwitch = rate > 0;

  return (
    <div className="w-full">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label htmlFor={name} className="block text-sm font-medium text-slate-700">
          {label}
        </label>
        {canSwitch && (
          <div className="flex rounded-lg bg-slate-100 p-0.5">
            {['USD', 'LBP'].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => switchTo(c)}
                className={cx(
                  'rounded px-1.5 py-0.5 text-[11px] font-medium transition',
                  currency === c ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
                )}
              >
                {c === 'USD' ? '$' : 'LL'}
              </button>
            ))}
          </div>
        )}
      </div>

      <Input
        name={name}
        id={name}
        type="number"
        min="0"
        step={inPounds ? '1000' : '0.01'}
        value={inPounds ? pounds : value}
        onChange={(e) => (inPounds ? typePounds(e.target.value) : onChange(e.target.value))}
        {...props}
      />

      {/*
        * The other currency, always shown. Typing in pounds, the dollars that
        * will actually be stored are the thing worth checking before saving.
        */}
      <p className="mt-1 text-xs text-slate-500">
        {inPounds
          ? `Saved as $${Number(value || 0).toFixed(2)}`
          : rate > 0 && Number(value) > 0
            ? lbp(Math.round(Number(value) * rate))
            : hint}
        {inPounds && hint ? ` · ${hint}` : ''}
      </p>
    </div>
  );
}

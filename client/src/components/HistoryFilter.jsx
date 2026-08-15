import { Search } from 'lucide-react';
import { Card, Input } from './ui';
import { PRESETS } from '../lib/history';

/**
 * The bar above a list of things that already happened.
 *
 * Every history in the app was answering a different question about when: one
 * showed this month, one showed everything, one showed the last fifty rows and
 * called it a list. So an owner looking for a repair from March pressed
 * different things on different screens, and on some of them could not get
 * there at all.
 *
 * One bar, one set of periods, one box to type into. What it filters is up to
 * the list — `useHistoryFilter` in lib/history holds the state and answers the
 * two questions a row asks: is it in range, and does it match what was typed.
 */
export default function HistoryFilter({
  filter,
  placeholder = 'Search…',
  label = 'Search',
  className,
  // A screen with a filter of its own — a status, a kind — puts it here rather
  // than in a second row, so there is one bar above the list and not two.
  children,
}) {
  const { preset, setPreset, from, setFrom, to, setTo, term, setTerm } = filter;

  return (
    <Card className={className ?? 'mb-4 p-4'}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-[14rem] flex-1">
          <Search
            size={16}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
          />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={placeholder}
            aria-label={label}
            className="h-10 w-full rounded-lg bg-white pr-3 pl-9 text-sm ring-1 ring-slate-300 transition focus:ring-2 focus:ring-brand-600 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map(([id, name]) => (
            <button
              key={id}
              type="button"
              onClick={() => setPreset(id)}
              aria-pressed={preset === id}
              className={
                preset === id
                  ? 'rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white'
                  : 'rounded-lg bg-white px-3 py-2 text-sm font-medium text-slate-600 ring-1 ring-slate-300 transition hover:bg-slate-50'
              }
            >
              {name}
            </button>
          ))}
        </div>

        {children}
      </div>

      {preset === 'custom' && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Input
            label="From"
            name="from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="max-w-[12rem]"
          />
          <Input
            label="To"
            name="to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="max-w-[12rem]"
          />
        </div>
      )}
    </Card>
  );
}

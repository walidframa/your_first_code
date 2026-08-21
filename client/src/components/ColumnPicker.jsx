import { useEffect, useRef, useState } from 'react';
import { Columns3, RotateCcw } from 'lucide-react';
import { fixed, setHiddenFor } from '../lib/tableColumns';
import { Button, cx } from './ui';

/**
 * Choose which columns a table shows.
 *
 * A drop-down of tick boxes rather than a dialog: it is a small choice made
 * while looking at the table, and a modal that covers the thing being changed
 * makes the reader guess at the result.
 *
 * The choice is kept on the device — see lib/tableColumns for why — so this
 * writes it and hands the caller the new set to render with.
 */
export default function ColumnPicker({
  table,
  columns,
  hidden,
  onChange,
  className,
  /* "Columns" on a table, "Panels" on the dashboard — the same choice about
     two different shapes of thing, and calling both of them columns would be
     a word nobody could act on. */
  label = 'Columns',
  what = 'columns',
}) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const locked = new Set(fixed(columns));
  const off = new Set(hidden);
  const changed = hidden.length > 0;

  // Anywhere else, and it closes. A panel left open over the table it is about
  // is the same problem as the modal.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (box.current && !box.current.contains(e.target)) setOpen(false);
    };
    const escape = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  function toggle(key) {
    const next = off.has(key) ? hidden.filter((k) => k !== key) : [...hidden, key];
    setHiddenFor(table, next);
    onChange(next);
  }

  function reset() {
    setHiddenFor(table, []);
    onChange([]);
  }

  return (
    <div ref={box} className={cx('relative', className)}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        title={`Choose which ${what} to show`}
      >
        <Columns3 size={15} />
        <span className="hidden sm:inline">{label}</span>
        {changed && (
          <span className="tnum rounded bg-brand-100 px-1 text-[11px] font-medium text-brand-800">
            {columns.length - hidden.length}
          </span>
        )}
      </Button>

      {open && (
        <div
          role="group"
          aria-label={`${label} to show`}
          className="absolute right-0 z-30 mt-1 w-60 rounded-xl bg-white p-1.5 shadow-lg ring-1 ring-slate-200"
        >
          <ul className="max-h-80 overflow-y-auto">
            {columns.map((c) => {
              const always = locked.has(c.key);
              return (
                <li key={c.key}>
                  <label
                    className={cx(
                      'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm',
                      always ? 'text-slate-400' : 'cursor-pointer text-slate-700 hover:bg-slate-50',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={always || !off.has(c.key)}
                      disabled={always}
                      onChange={() => toggle(c.key)}
                      className="h-4 w-4 rounded border-slate-300 accent-brand-600"
                    />
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    {always && <span className="shrink-0 text-[11px]">always</span>}
                  </label>
                </li>
              );
            })}
          </ul>

          {changed && (
            <button
              onClick={reset}
              className="mt-1 flex w-full items-center gap-1.5 border-t border-slate-100 px-2 pt-2 pb-1 text-xs font-medium text-slate-500 transition hover:text-slate-800"
            >
              <RotateCcw size={12} /> Show them all again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

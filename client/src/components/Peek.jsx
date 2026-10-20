import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cx } from './ui';

/**
 * A figure kept out of sight until somebody asks for it.
 *
 * The profit on the register bar and on the repairs board is read by the
 * owner and seen by everybody standing near the screen — the cashier, the
 * customer, the technician's cousin. Blurred, it is still there for a press
 * on the eye, and nobody reads it over a shoulder. Remembered for the tab,
 * so one press does not have to be repeated on every refresh of the day.
 */
function remembered(key) {
  try {
    return globalThis.sessionStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

export default function Peek({ storageKey = 'pos_peek', children, className, label = 'Show the figure' }) {
  const [shown, setShown] = useState(() => remembered(storageKey));

  function toggle(e) {
    e.stopPropagation();
    const next = !shown;
    setShown(next);
    try {
      globalThis.sessionStorage?.setItem(storageKey, next ? '1' : '0');
    } catch {
      /* A blocked store only means pressing it again next time. */
    }
  }

  return (
    <span className={cx('inline-flex items-center gap-1.5', className)} data-peek={shown ? 'shown' : 'hidden'}>
      <span className={cx('transition', !shown && 'pointer-events-none blur-sm select-none')} aria-hidden={!shown}>
        {children}
      </span>
      <button
        type="button"
        onClick={toggle}
        aria-label={shown ? 'Hide the figure' : label}
        aria-pressed={shown}
        title={shown ? 'Hide' : 'Show'}
        className="shrink-0 rounded-md p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
      >
        {shown ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </span>
  );
}

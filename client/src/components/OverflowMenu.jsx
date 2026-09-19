import { useEffect, useRef, useState } from 'react';
import { Check, MoreHorizontal } from 'lucide-react';
import { cx } from './ui';

/**
 * The rest of the buttons, behind one round "⋯".
 *
 * A phone has room for the one thing a screen is for and not much else. Four
 * set-up buttons across the top of the catalogue took a third of the screen
 * before the search box; a toolbar with a scanner, a checkbox and a toggle
 * squeezed the search box down to three letters. The things done once a
 * month go here, one press away, and the search box gets the width back.
 *
 * `items`: { label, icon, onClick, checked } — `checked` draws a tick and
 * keeps the menu open, for switches; anything else closes it.
 */
export default function OverflowMenu({ items, label = 'More', className, align = 'end' }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (box.current && !box.current.contains(e.target)) setOpen(false);
    };
    const escape = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('touchstart', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('touchstart', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div ref={box} className={cx('relative shrink-0', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-700 transition hover:bg-slate-200 active:bg-slate-300"
      >
        <MoreHorizontal size={20} />
      </button>
      {open && (
        <div
          role="menu"
          className={cx(
            'absolute top-full z-30 mt-1 min-w-[13rem] rounded-xl bg-white py-1.5 shadow-lg ring-1 ring-slate-200',
            align === 'end' ? 'end-0' : 'start-0',
          )}
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked === undefined ? undefined : item.checked}
                onClick={() => {
                  item.onClick?.();
                  if (item.checked === undefined) setOpen(false);
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-start text-sm text-slate-700 transition hover:bg-slate-50 active:bg-slate-100"
              >
                {Icon && <Icon size={17} className="shrink-0 text-slate-500" />}
                <span className="flex-1">{item.label}</span>
                {item.checked !== undefined && (
                  <Check size={16} className={cx('shrink-0', item.checked ? 'text-brand-600' : 'invisible')} />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

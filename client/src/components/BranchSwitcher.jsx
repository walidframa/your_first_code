import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Globe, Store, Truck } from 'lucide-react';
import { useBranch } from '../context/BranchContext';
import { cx } from './ui';

/**
 * Which shop you are looking at.
 *
 * High in the rail and always visible, because it changes the meaning of every
 * figure below it: the stock on the tiles, the drawer, the day's takings, the
 * profit. Somebody reading the wrong branch's numbers as their own is the
 * failure this is placed to prevent, so it says the name rather than hiding it
 * behind a menu.
 *
 * For a cashier — pinned to their counter — it is a label, not a control. There
 * is nothing to choose, and a dropdown that refuses every choice is worse than
 * plain text.
 */
export default function BranchSwitcher({ expanded }) {
  const { branch, branches, canSwitch, switchTo, incoming, loaded, viewingAll, setViewingAll } =
    useBranch();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Nothing to say until the app knows where it is, and a single-branch shop
  // should not carry a picker for a choice it does not have.
  if (!loaded || !branch) return null;
  if (!canSwitch && branches.length <= 1) return null;

  const label = viewingAll ? 'All branches' : branch.name;

  if (!canSwitch) {
    return (
      <div
        title={label}
        className={cx(
          'mb-2 flex items-center rounded-lg bg-slate-800/60 py-1.5 text-slate-300',
          expanded ? 'gap-2 px-2.5' : 'justify-center px-1',
        )}
      >
        <Store size={14} className="shrink-0 text-slate-400" />
        {expanded && <span className="truncate text-xs font-medium">{label}</span>}
      </div>
    );
  }

  return (
    <div ref={ref} className="relative mb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`Branch: ${label}`}
        aria-label={`Branch: ${label}. Change branch`}
        aria-expanded={open}
        className={cx(
          'flex w-full items-center rounded-lg bg-slate-800 py-1.5 text-slate-200 transition hover:bg-slate-700',
          expanded ? 'gap-2 px-2.5' : 'justify-center px-1',
        )}
      >
        <Store size={14} className="shrink-0 text-brand-400" />
        {expanded && (
          <>
            <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">{label}</span>
            <ChevronDown size={13} className="shrink-0 text-slate-400" />
          </>
        )}
        {/*
          * A box waiting to be received is stock this shop cannot sell yet, so
          * it is worth a mark on the rail rather than only on the screen nobody
          * has opened.
          */}
        {incoming > 0 && (
          <span
            className={cx(
              'flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white',
              expanded ? '' : 'absolute -top-1 -right-1',
            )}
            title={`${incoming} transfer${incoming === 1 ? '' : 's'} on the way here`}
          >
            {incoming}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 w-56 overflow-hidden rounded-xl bg-white py-1 shadow-xl ring-1 ring-slate-900/10">
          <p className="px-3 py-1.5 text-[10px] font-semibold tracking-wider text-slate-400 uppercase">
            Branch
          </p>
          {branches.map((b) => (
            <button
              key={b.id}
              onClick={() => {
                setViewingAll(false);
                switchTo(b.id);
                setOpen(false);
              }}
              className={cx(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-slate-50',
                b.id === branch.id && !viewingAll ? 'font-medium text-slate-900' : 'text-slate-600',
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                {b.name}
                {b.is_main && <span className="ml-1.5 text-[10px] text-slate-400">main</span>}
                {!b.active && <span className="ml-1.5 text-[10px] text-red-500">closed</span>}
              </span>
              {b.id === branch.id && !viewingAll && (
                <Check size={14} className="shrink-0 text-brand-600" />
              )}
            </button>
          ))}
          {/*
            * The whole company, for whoever is allowed to see it.
            *
            * Below the branches rather than above, because it is the unusual
            * choice: the ordinary answer to "which shop am I in" is one of the
            * shops. It reads rather than writes — a sale still belongs to the
            * counter it was rung up on — so the note underneath says so, since
            * a mode that silently changed where a sale landed would be worse
            * than no mode at all.
            */}
          {branches.length > 1 && (
            <button
              onClick={() => {
                setViewingAll(!viewingAll);
                setOpen(false);
              }}
              className={cx(
                'mt-1 flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-sm transition hover:bg-slate-50',
                viewingAll ? 'font-medium text-slate-900' : 'text-slate-600',
              )}
            >
              <Globe size={14} className="shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1 truncate">All branches</span>
              {viewingAll && <Check size={14} className="shrink-0 text-brand-600" />}
            </button>
          )}
          {viewingAll && (
            <p className="px-3 pb-2 text-[11px] leading-snug text-slate-500">
              Reading only. Anything you ring up or write still belongs to {branch.name}.
            </p>
          )}
          {incoming > 0 && (
            <p className="mt-1 flex items-center gap-1.5 border-t border-slate-100 px-3 py-2 text-xs text-amber-700">
              <Truck size={13} /> {incoming} on the way to {branch.name}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

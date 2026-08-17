import { useNavigate } from 'react-router';
import { ArrowLeft, X } from 'lucide-react';
import { useTabs } from '../context/TabsContext';
import { cx } from './ui';

/**
 * Back, and the pages that are open.
 *
 * One strip above the page rather than a back button repeated inside every
 * screen: a control that means the same thing everywhere belongs in one place,
 * and a shop that learns where it is once should never have to look for it
 * again.
 *
 * Back is the browser's own history, not "the tab to the left". Those are
 * different questions — going back from an order you opened from a search
 * should return to the search, whether or not it has a tab.
 */
export default function TabBar() {
  const { tabs, active, close, closeAll, open } = useTabs();
  const navigate = useNavigate();

  // With one tab there is nothing to switch between, and the strip would be a
  // row of chrome above a screen that needs its height.
  if (tabs.length <= 1) {
    return (
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-1.5">
        <BackButton onClick={() => navigate(-1)} />
      </div>
    );
  }

  return (
    <nav
      aria-label="Open pages"
      className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-1.5"
    >
      <BackButton onClick={() => navigate(-1)} />

      {/* Scrolls rather than wraps: a second row of tabs would push the page
          down every time somebody opened one more. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const current = tab.path === active;
          return (
            <div
              key={tab.path}
              className={cx(
                'group flex shrink-0 items-center gap-1 rounded-lg py-1 pr-1 pl-3 text-sm transition',
                current
                  ? 'bg-brand-50 font-medium text-brand-800 ring-1 ring-brand-200'
                  : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              <button
                type="button"
                onClick={() => open(tab.path)}
                className="max-w-[14rem] truncate"
                aria-current={current ? 'page' : undefined}
              >
                {tab.title}
              </button>
              <button
                type="button"
                onClick={() => close(tab.path)}
                aria-label={`Close ${tab.title}`}
                className={cx(
                  'rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700',
                  // Always visible on the open one, and on hover for the rest:
                  // a row of crosses is a row of things to press by accident.
                  current ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
                )}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {/*
        * Words where there is room for them, a cross where there is not.
        *
        * "Close the rest" is a third of a phone's bar, and it was spending it
        * to explain a button nobody presses by accident — while the tabs it
        * talks about were squeezed down to four letters and a fade.
        */}
      <button
        type="button"
        onClick={closeAll}
        aria-label="Close the rest"
        title="Close the rest"
        className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
      >
        <X size={15} className="sm:hidden" />
        <span className="hidden sm:inline">Close the rest</span>
      </button>
    </nav>
  );
}

function BackButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back to the previous page"
      title="Back"
      className="shrink-0 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
    >
      <ArrowLeft size={18} />
    </button>
  );
}

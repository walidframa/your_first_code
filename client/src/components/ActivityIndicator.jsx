import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { pending, subscribe } from '../lib/activity';
import { useT } from '../context/LanguageContext';

/*
 * The icon is late on purpose, and slow to leave on purpose.
 *
 * Most requests are answered in well under a quarter of a second, and an icon
 * that appears for every one of them is a flicker in the corner of the eye on
 * every keystroke of a search. So it waits a moment before showing, and only
 * the requests that are genuinely taking a while get it. And once it is
 * showing, it stays long enough to be seen: a spinner that flashes for forty
 * milliseconds reads as a glitch rather than as "working".
 */
const SHOW_AFTER_MS = 250;
const STAY_FOR_MS = 400;

/** Whether the icon should be on screen right now. */
function useBusy() {
  const [shown, setShown] = useState(false);
  const timer = useRef(null);
  const shownAt = useRef(0);

  useEffect(() => {
    const clear = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };

    const update = (busy) => {
      clear();
      if (busy) {
        timer.current = setTimeout(() => {
          shownAt.current = Date.now();
          setShown(true);
        }, SHOW_AFTER_MS);
      } else {
        const left = STAY_FOR_MS - (Date.now() - shownAt.current);
        if (left > 0) timer.current = setTimeout(() => setShown(false), left);
        else setShown(false);
      }
    };

    // Something may already be in flight by the time this mounts.
    if (pending() > 0) update(true);
    const stop = subscribe(update);
    return () => {
      stop();
      clear();
    };
  }, []);

  return shown;
}

/**
 * One small sign, for the whole app, that it is waiting on the server.
 *
 * A thin line sweeping along the very top of the window, and a spinning icon
 * in the corner under it. Neither takes a click — they sit above everything
 * and let every press through — and neither says what is loading, because
 * the screen underneath already does that with its own skeleton or empty
 * table. This only answers the question a person asks when a page sits still
 * for a second: "is it doing anything?"
 */
export default function ActivityIndicator() {
  const shown = useBusy();
  const t = useT();
  if (!shown) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-activity=""
      className="no-print pointer-events-none fixed inset-x-0 top-0 z-[90]"
    >
      <div className="activity-bar h-0.5 w-full bg-brand-500" aria-hidden="true" />
      <div className="activity-badge absolute end-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-white text-brand-600 shadow-md ring-1 ring-slate-200">
        <Loader2 size={18} className="animate-spin" aria-hidden="true" />
      </div>
      <span className="sr-only">{t('Loading…')}</span>
    </div>
  );
}

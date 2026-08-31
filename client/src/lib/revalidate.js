import { useEffect, useRef } from 'react';

/**
 * Fetch again, quietly, when the screen comes back into use.
 *
 * A shop does not sit on one screen. The counter is left open while somebody
 * takes a delivery on the tablet in the back, prices are changed on the office
 * machine, another branch sells the last of something. The app loaded its data
 * when the screen mounted and never asked again, so whoever came back to a tab
 * an hour later was looking at an hour-old shelf — and the only way to find out
 * was to reload the page, which is a thing a shopkeeper should never have to
 * know about.
 *
 * So the screen refreshes itself when it is looked at again: the window
 * regaining focus, or the tab becoming visible. Both are the moment somebody
 * turns back to it, which is exactly when stale figures start to matter and
 * exactly when there is no work in flight to disturb.
 *
 * **Quietly** is the whole point. It calls the loader the screen already has,
 * which sets its data when the answer arrives — no spinner, no skeleton, no
 * flash of an empty list. A refresh somebody notices is not better than the
 * stale figure they had.
 *
 * Not polling. A till left open all day would make a request every few seconds
 * for a shop that is not looking at it, on a connection that is often somebody
 * phone's hotspot, to answer a question nobody is asking.
 */
export function useRevalidate(load, { minGapMs = 10000 } = {}) {
  /*
   * Held in a ref so a loader rebuilt on every render — most of them are —
   * does not tear down and re-arm the listeners each time.
   */
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    let last = Date.now();

    const again = () => {
      /*
       * Alt-tabbing back and forth fires focus and visibilitychange together,
       * and a shopkeeper switching between two windows fires them again a
       * second later. One fetch per ten seconds is plenty for "is this still
       * true" and keeps a busy counter from talking to itself.
       */
      if (Date.now() - last < minGapMs) return;
      last = Date.now();
      Promise.resolve(latest.current?.()).catch(() => {
        /*
         * A background refresh that fails changes nothing on screen and must
         * not say anything. The shop still has the figures it had, the next
         * real action will report its own failure, and a red toast about a
         * fetch nobody asked for is noise at a counter.
         */
      });
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') again();
    };

    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [minGapMs]);
}

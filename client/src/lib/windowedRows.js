import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Only the rows somebody can actually see.
 *
 * A catalogue of eighteen hundred products is eighteen hundred table rows, and
 * each one carries a thumbnail, two badges and four buttons. That is tens of
 * thousands of elements the browser has to lay out, paint and keep in memory —
 * and every scroll asks it to do the work again for rows nobody is looking at.
 * The screen goes from instant to sticky somewhere around a thousand products,
 * which is exactly the size a real shop's catalogue reaches.
 *
 * So the table renders the slice in the window and two spacer rows: one holding
 * open the space above, one below. The scrollbar is the height it always was,
 * the scroll position means what it always meant, and Ctrl+F is the only thing
 * that notices — which is why the search box exists.
 *
 * Written here rather than pulled in: it is sixty lines against a dependency,
 * and the one thing this has to get right — a row height that is measured
 * rather than guessed — is the thing a general-purpose library asks you to
 * configure anyway.
 */
export function useWindowedRows({ count, estimate = 44, overscan = 10 }) {
  const scrollRef = useRef(null);

  /*
   * Measured off a real row, not declared. A guess that is a few pixels out
   * drifts by whole rows a thousand down the list, and the symptom — the last
   * rows unreachable, or a gap under the last one — looks like a scrolling bug
   * rather than a wrong constant.
   *
   * Measured exactly **once**, and that is the whole safety of it. Rows are not
   * quite identical — one has a badge another does not, a name wraps where the
   * next does not — so measuring whichever row happens to be at the top of the
   * window feeds a slightly different height back in every time the window
   * moves. Each new height moves the window, which lands on a different row,
   * which reports a different height: the render loop never settles and React
   * gives up on the screen. That is the crash this comment exists to prevent
   * ever being reintroduced by somebody "keeping the measurement fresh".
   */
  const [rowHeight, setRowHeight] = useState(estimate);
  const measured = useRef(false);
  const measureRow = useCallback((node) => {
    if (!node || measured.current) return;
    const height = node.getBoundingClientRect().height;
    if (height > 0) {
      measured.current = true;
      setRowHeight(height);
    }
  }, []);

  const [range, setRange] = useState({ start: 0, end: Math.min(count, 60) });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;

    let frame = 0;
    const recompute = () => {
      frame = 0;
      const first = Math.max(0, Math.floor(el.scrollTop / rowHeight) - overscan);
      const fits = Math.ceil(el.clientHeight / rowHeight) + overscan * 2;
      setRange((prev) => {
        const next = { start: first, end: Math.min(count, first + fits) };
        return prev.start === next.start && prev.end === next.end ? prev : next;
      });
    };

    /*
     * One recompute per frame at most. A scroll fires far more often than the
     * screen refreshes, and doing this work per event is its own stutter.
     */
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(recompute);
    };

    recompute();
    el.addEventListener('scroll', onScroll, { passive: true });
    /* The window changes height when the rail folds or the keyboard opens. */
    const observer = new ResizeObserver(recompute);
    observer.observe(el);

    return () => {
      el.removeEventListener('scroll', onScroll);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [count, rowHeight, overscan]);

  /*
   * Clamped against the count as it is now. Typing in the search box can take
   * the list from two thousand rows to three between a scroll and its render,
   * and a window still pointing at row 1,400 would ask for a slice past the end
   * and pad the table by sixty thousand pixels of nothing.
   */
  const start = Math.max(0, Math.min(range.start, Math.max(0, count - 1)));
  const end = Math.max(start, Math.min(range.end, count));

  return {
    scrollRef,
    measureRow,
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (count - end) * rowHeight),
  };
}

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

/**
 * The same idea, for a grid of tiles.
 *
 * The register renders the shelf as cards, and it rendered all of them: a shop
 * with nineteen hundred products put nineteen hundred cards into the page, each
 * with a colour block, a name, a price in two currencies and a stock badge. The
 * cost is not the filtering — matching two thousand strings takes about a
 * millisecond — it is that every keystroke in the search box asks React to
 * reconcile the whole shelf and the browser to lay it out again. Measured on
 * such a shop, a single keypress cost up to 149ms, so a cashier typing a name
 * was a third of a second behind their own fingers.
 *
 * Rows are the unit here as well, because that is what scrolling moves past —
 * but a row is however many cards fit across, and that changes with the window,
 * the rail folding, and the cart sheet opening. So the column count is read off
 * the grid itself rather than worked out from a width nobody can be sure of.
 *
 * Unlike the row height above, the column count is safe to keep fresh: it is
 * derived from the container's *width*, and nothing this returns changes the
 * width. The height feedback loop that made measuring per render a hang cannot
 * happen here — see the warning on `useWindowedRows`.
 */
export function useWindowedGrid({ count, estimate = 132, overscan = 2, resetOn = null }) {
  const scrollRef = useRef(null);
  const gridRef = useRef(null);

  /*
   * Measured off a real tile, once per *shape*.
   *
   * Measuring once is what keeps this from hanging — see the warning on
   * `useWindowedRows`, and do not weaken it. But "once ever" was only right
   * while a tile was one shape. The shelf can now be shown as a list, whose
   * rows are a third the height of a card, and a window still working from the
   * card's height showed a third of a screen of rows with a page of blank
   * space under them.
   *
   * Read from the grid's own first child rather than handed in by a ref
   * callback on each tile. A ref callback fires when a node mounts, and
   * switching between cards and rows re-renders the same `<button>` elements
   * rather than replacing them — so the callback never fired again and the
   * stale height stood. The DOM is right here in `recompute`, which already
   * runs when the shape changes, so it is simply asked.
   */
  const [rowHeight, setRowHeight] = useState(estimate);
  const measured = useRef(false);

  const [columns, setColumns] = useState(1);
  const [range, setRange] = useState({ start: 0, end: 60 });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;

    let frame = 0;
    const recompute = () => {
      frame = 0;

      const grid = gridRef.current;

      /*
       * How many fit across, asked of the browser rather than derived. The
       * track list is `repeat(auto-fill, minmax(150px, 1fr))`, so only the
       * browser knows what it resolved to at this width — and it is the one
       * number that makes the arithmetic below mean anything.
       *
       * Safe to keep fresh, unlike the height: it derives from the container's
       * *width*, and nothing this returns changes the width, so the feedback
       * loop that made measuring per render a hang cannot happen.
       */
      const cols = grid
        ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length)
        : 1;
      setColumns((prev) => (prev === cols ? prev : cols));

      let height = rowHeight;
      if (!measured.current && grid?.firstElementChild) {
        const tile = grid.firstElementChild.getBoundingClientRect().height;
        if (tile > 0) {
          /* The gap between rows belongs to the row for this purpose: it is
             space the scroll travels past, and leaving it out drifts the window
             by a whole row every dozen. */
          const gap = parseFloat(getComputedStyle(grid).rowGap) || 0;
          height = tile + gap;
          measured.current = true;
          setRowHeight(height);
        }
      }

      const rows = Math.ceil(count / cols);
      const firstRow = Math.max(0, Math.floor(el.scrollTop / height) - overscan);
      const rowsThatFit = Math.ceil(el.clientHeight / height) + overscan * 2;
      const lastRow = Math.min(rows, firstRow + rowsThatFit);

      setRange((prev) => {
        const next = { start: firstRow * cols, end: Math.min(count, lastRow * cols) };
        return prev.start === next.start && prev.end === next.end ? prev : next;
      });
    };

    /* One recompute per frame at most; a scroll fires far oftener than paint. */
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(recompute);
    };

    recompute();
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    if (gridRef.current) observer.observe(gridRef.current);

    return () => {
      el.removeEventListener('scroll', onScroll);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [count, rowHeight, overscan, resetOn]);

  /*
   * The shape changed, so the height that was measured is somebody else's.
   *
   * Cleared in its own effect, which runs before the one above re-runs for the
   * same change — so `recompute` finds the flag down and measures the tile that
   * is now on the screen.
   */
  useEffect(() => {
    measured.current = false;
  }, [resetOn]);

  /*
   * Clamped against the count as it is now, for the reason `useWindowedRows`
   * gives: a keystroke can take the shelf from two thousand tiles to three
   * between a scroll and its render, and a window still pointing at tile 1,400
   * would ask for a slice past the end and pad the page with nothing.
   */
  const start = Math.max(0, Math.min(range.start, Math.max(0, count - 1)));
  const end = Math.max(start, Math.min(range.end, count));

  const rowsAbove = Math.floor(start / columns);
  const rowsBelow = Math.max(0, Math.ceil(count / columns) - Math.ceil(end / columns));

  return {
    scrollRef,
    gridRef,
    /* Kept so callers need not change; the height is read off the DOM now. */
    measureTile: () => {},
    start,
    end,
    padTop: rowsAbove * rowHeight,
    padBottom: rowsBelow * rowHeight,
  };
}

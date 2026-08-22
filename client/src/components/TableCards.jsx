import { useEffect } from 'react';

/**
 * Turning every table in the app into cards on a phone.
 *
 * A table is a shape that needs width. This app has thirty of them, some
 * eleven columns wide, and on a 390-pixel screen the honest options are a row
 * squeezed until nothing is readable, or a horizontal scroll — which is what
 * it did, and which means dragging the shelf sideways to find out what a
 * product costs, then dragging back to read which product it was.
 *
 * The fix everybody lands on is to stop pretending it is a table: each row
 * becomes a card, each cell a line of "label — value". No sideways scrolling,
 * and the label travels with the value instead of living in a header row that
 * has scrolled off.
 *
 * Doing that in CSS needs each cell to know its own column heading, and a
 * `<td>` does not — the heading is in a different element entirely, and CSS
 * cannot read across. So the heading is copied onto the cell as `data-label`
 * and the stylesheet prints it with `content: attr(data-label)`.
 *
 * **Why one watcher rather than thirty edits.** The alternative is wrapping
 * every table in a component, which is thirty files touched, thirty chances to
 * get one wrong, and a thirty-first table added next month that nobody
 * remembers to wrap. This is one observer that finds them all, including ones
 * that do not exist yet.
 */

/** Copy each column's heading onto the cells beneath it. */
function label(root) {
  for (const table of root.querySelectorAll('table:not(.no-cards)')) {
    /*
     * The last header row, not the first. A table with a grouped header has
     * two, and the one that names the individual columns is the lower.
     */
    const headRow = table.querySelector('thead tr:last-of-type');
    const heads = headRow ? [...headRow.children].map((th) => th.textContent.trim()) : [];

    /*
     * A table with no header at all still has to stop being a table.
     *
     * The accounts screen has three of them — the tills, the wallets, the
     * people — four columns each and no heading row, because on a desk the
     * columns are self-evident. On a phone they are not self-evident, they are
     * four things fighting over 390 pixels: "Main drawer" broke across two
     * lines, "Register drawer" broke across two lines, and the balance was
     * pushed off the edge.
     *
     * There are no headings to hand out, so the cells get none — but stacking
     * them is worth doing on its own. `cards-plain` is the same card with the
     * values left where they were written instead of pushed to the right,
     * because a value with no label in front of it has nothing to be pushed
     * away from.
     */
    /*
     * Two columns are already a card row.
     *
     * A narrow table — "Notes ×3 | $150.00" on the cashbox report, a product's
     * movements — is a list of label-and-value pairs written sideways, which is
     * exactly the shape a card line has. Stacking it turns one line into two
     * and makes a short document twice as long to read, for no width that was
     * ever a problem. It fits at 390 pixels as it stands.
     *
     * Measured from the widest body row rather than the header, because that is
     * what actually has to fit.
     */
    const widest = Math.max(
      0,
      ...[...table.querySelectorAll('tbody tr')].map((r) => r.children.length),
    );
    if (widest <= 2) {
      table.classList.remove('cards', 'cards-plain');
      continue;
    }

    table.classList.add('cards');
    if (heads.length === 0) {
      table.classList.add('cards-plain');
      continue;
    }
    table.classList.remove('cards-plain');

    for (const row of table.querySelectorAll('tbody tr')) {
      const cells = row.children;

      /*
       * Only rows shaped like the header.
       *
       * An empty state ("No items yet"), a totals line, or any row using
       * colspan has fewer cells than there are columns, so position no longer
       * says which column a cell belongs to — and a confidently wrong label is
       * worse than none. Those rows are left alone and the stylesheet lets
       * them run the full width of the card.
       */
      if (cells.length !== heads.length) continue;

      for (let i = 0; i < cells.length; i += 1) {
        const want = heads[i] ?? '';
        // Compared before writing: this runs on every render, and setting an
        // attribute to the value it already has is still a write.
        if (cells[i].getAttribute('data-label') !== want) {
          cells[i].setAttribute('data-label', want);
        }
      }
    }
  }
}

export default function TableCards() {
  useEffect(() => {
    const main = document.getElementById('main');
    if (!main) return undefined;

    let queued = false;
    const run = () => {
      queued = false;
      label(main);
    };

    /*
     * `childList` only, and that is not an optimisation — it is what stops
     * this looping. Watching attributes would mean every label written here
     * wakes the observer that wrote it.
     */
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      // One pass per frame however many mutations a render produced: a table
      // of nine hundred products arrives as hundreds of separate ones.
      requestAnimationFrame(run);
    });

    label(main);
    observer.observe(main, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}

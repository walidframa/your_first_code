import { useEffect, useRef } from 'react';

/**
 * What somebody has typed but not yet saved, kept across a tab switch.
 *
 * Tabs in this app are a list of *places*, not a list of live screens: moving
 * to one navigates to it, and the screen you left is unmounted. That is a
 * deliberate trade — see context/TabsContext.jsx — because keeping half a dozen
 * pages mounted means half a dozen screens polling behind a till that has to
 * stay quick on an old tablet.
 *
 * The cost of that trade is this: a purchase invoice with forty lines on it,
 * abandoned because somebody looked up a price in another tab. The register's
 * cart was already exempted for exactly this reason. This is the same exemption
 * for every other screen where a person types more than they can retype.
 *
 * Session storage, like the cart and the tabs themselves. A draft is what this
 * person is doing now — a till left open overnight should come back to a clean
 * screen, and the next cashier should not inherit somebody else's morning.
 */
const PREFIX = 'pos_draft:';

/**
 * The draft for a key, read once.
 *
 * Meant to be called from a `useState` initialiser so the screen comes up with
 * the work already on it rather than flashing empty and then filling in.
 */
export function readDraft(key) {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    /* A draft that cannot be read is a draft there isn't. */
    return null;
  }
}

export function clearDraft(key) {
  try {
    sessionStorage.removeItem(PREFIX + key);
  } catch {
    /* Nothing to do, and nothing worth failing a save over. */
  }
}

/**
 * Keep a draft up to date while somebody types.
 *
 * Written on a short delay rather than on every keystroke: serialising a forty
 * line invoice on each character is work done a hundred times to be read once,
 * and on a slow tablet it is felt in the typing.
 *
 * `active` is how a screen says "not yet" — a form that has not finished
 * loading would otherwise save its empty starting state over the very draft it
 * is about to restore, which turns this feature into a way to lose work rather
 * than to keep it.
 */
export function useDraft(key, snapshot, { active = true, delay = 400 } = {}) {
  /*
   * The latest snapshot, without making it a dependency.
   *
   * A new object every render would restart the timer every render, so it would
   * only ever be written once typing stopped for good — including never, on a
   * screen that re-renders on a clock.
   */
  const latest = useRef(snapshot);
  latest.current = snapshot;

  /*
   * The key and the switch, in refs as well.
   *
   * The write below happens on unmount, and an unmount effect that depends on
   * either of them would *also* run its cleanup when they change — writing the
   * old key straight back after something else had just cleared it. Changing
   * the kind of a document does exactly that.
   */
  const current = useRef({ key, active });
  current.current = { key, active };

  /*
   * Set the moment the caller says the draft is finished with — saved, or
   * abandoned — and never unset.
   *
   * Without it, `clearDraft` on a successful save was undone half a second
   * later by this hook's own unmount write: the form is unmounting *because*
   * it saved, so the last thing to touch storage was the write, not the clear.
   * The document then came back inside the next new one somebody started,
   * carrying a supplier and lines nobody typed — worse than the lost typing
   * this set out to fix, and what the end-to-end suite found.
   */
  const done = useRef(false);

  const write = () => {
    const { key: k, active: on } = current.current;
    if (done.current || !on || !k) return;
    try {
      sessionStorage.setItem(PREFIX + k, JSON.stringify(latest.current));
    } catch {
      /* Full or blocked storage is not worth interrupting a shopkeeper for. */
    }
  };

  useEffect(() => {
    const timer = setTimeout(write, delay);
    return () => clearTimeout(timer);
  });

  /*
   * And once more on the way out, without waiting for the timer.
   *
   * This is the case the whole thing exists for: the screen is unmounting
   * because somebody clicked another tab, and the pending write would be
   * cancelled by the cleanup above and never happen.
   *
   * Empty deps on purpose — see the ref above. It must run on unmount and at no
   * other time.
   */
  useEffect(() => write, []);

  /** Saved, or thrown away: forget it, and stop writing it back. */
  return () => {
    done.current = true;
    clearDraft(current.current.key);
  };
}

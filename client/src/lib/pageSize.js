import { useLayoutEffect } from 'react';

/**
 * The one thing in the app that decides what size the paper is.
 *
 * `@page` cannot be scoped to a selector — it is a property of the document,
 * not of anything on it. So a stylesheet that writes one and a component that
 * writes another are both writing the same setting, and which of them wins
 * comes down to where in the document their rules ended up. That is how a
 * receipt asked for A4 and came out on the roll: two live `@page` rules and no
 * rule about which was in charge.
 *
 * Now there is exactly one, in a `<style>` this module owns. Whatever is about
 * to be printed says what it needs; when it closes, the paper goes back to the
 * roll, which is what a shop prints on when nobody has said otherwise.
 */
const ID = 'pos-page-size';

/** 80mm roll less what the printer will not reach, running as long as it needs. */
export const ROLL = '@page { size: 72mm auto; margin: 3mm; }';
export const A4 = '@page { size: A4; margin: 14mm; }';

export function setPageSize(rule) {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(ID);
  if (!el) {
    el = document.createElement('style');
    el.id = ID;
    document.head.append(el);
  }
  el.textContent = rule;
}

/**
 * Claim the page size for as long as this is on screen.
 *
 * A layout effect rather than an ordinary one: the rule has to be in place
 * before anything can be painted or printed, and a browser print triggered in
 * the same tick as the dialog opening must not catch the old size.
 */
export function usePageSize(rule) {
  useLayoutEffect(() => {
    setPageSize(rule);
    return () => setPageSize(ROLL);
  }, [rule]);
}

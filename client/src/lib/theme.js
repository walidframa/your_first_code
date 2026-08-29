/**
 * Light or dark, on this screen.
 *
 * A property of the screen rather than of the shop, for the same reason the
 * text size is: the till is a tablet under the shop's own lights and the back
 * office is a laptop by a window, and the right answer differs. Kept on the
 * device, and mirrored onto the account so somebody who uses the counter
 * tablet, the office laptop and their phone sets it once rather than three
 * times.
 *
 * Three choices, not two. "Match device" is the honest default: a phone that
 * turns itself dark at sunset should turn this dark with it, and a shopkeeper
 * who has never thought about themes gets whatever their machine already does.
 */
export const THEMES = [
  ['system', 'Match device'],
  ['light', 'Light'],
  ['dark', 'Dark'],
  /*
   * A second *look*, not a third brightness.
   *
   * "Match device" answers light or dark on this screen; this answers which
   * design the shop wants, and it is a light one. It sits in the same list
   * because that is where somebody looks for it — a separate "style" setting
   * elsewhere would be a second place to check when the app comes up the
   * wrong colour.
   */
  ['ledger', 'Ledger'],
];

/** The looks that are their own design rather than a brightness of the first. */
const LOOKS = new Set(['ledger']);

const KEY = 'pos_theme';

export function getTheme() {
  const stored = globalThis.localStorage?.getItem(KEY);
  return THEMES.some(([id]) => id === stored) ? stored : 'system';
}

/** What "system" currently means. Light wherever the question cannot be asked. */
export function systemPrefersDark() {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** Which of the two is actually on screen, whatever the setting is called. */
export const resolveTheme = (choice = getTheme()) =>
  choice === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : choice;

/**
 * Which brightness the browser should paint its own furniture in.
 *
 * The scrollbars, the date pickers and the select dropdowns are drawn by the
 * browser and cannot be reached by any of this app's CSS — so it is told
 * plainly. A look that is a light design has to say `light` here rather than
 * its own name, which the browser has never heard of and would ignore, leaving
 * a dark shop's scrollbars behind on the next switch.
 */
const schemeOf = (resolved) => (LOOKS.has(resolved) ? 'light' : resolved);

/**
 * Apply a choice, and remember it.
 *
 * Written straight onto the root element, and called before the app renders, so
 * a shop that runs dark never gets a white flash on the way in — which at a
 * counter at night is genuinely unpleasant, and is the thing that makes people
 * turn a dark mode back off.
 *
 * `color-scheme` is set alongside the attribute so the parts of the page the
 * app does not paint — the scrollbars a browser draws itself, a date picker, a
 * select's dropdown list — come up dark too, instead of staying as white
 * rectangles the design cannot reach.
 */
export function applyTheme(choice = getTheme()) {
  const resolved = resolveTheme(choice);
  const root = globalThis.document?.documentElement;
  if (root) {
    root.dataset.theme = resolved;
    root.style.colorScheme = schemeOf(resolved);
  }
  globalThis.localStorage?.setItem(KEY, choice);
  return choice;
}

/**
 * Follow the device while the setting says to.
 *
 * Without this, "Match device" would mean "match whatever the device was doing
 * when this page loaded" — and a till left open across sunset would sit in the
 * wrong theme until somebody reloaded it.
 */
export function watchSystemTheme() {
  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  if (!media) return () => {};
  const onChange = () => {
    if (getTheme() === 'system') applyTheme('system');
  };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

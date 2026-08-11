/**
 * How big the text is, on this screen.
 *
 * A shop runs the till on a tablet propped up at the counter and the back
 * office on a laptop a foot from somebody's face, so this is a property of the
 * screen rather than of the shop: kept on the device, not in the database, and
 * not shared between them.
 *
 * Everything is sized in rem, so moving the root size moves the whole app
 * together — text, padding, the height of a button — rather than growing the
 * type until it breaks out of things that stayed put. The steps are gentle for
 * the same reason: 125% would start wrapping the register's own columns, and a
 * cashier who cannot read a total is no better off if the total is in the wrong
 * place.
 */
export const TEXT_SIZES = [
  ['default', 'Default', 100],
  ['medium', 'Medium', 110],
  ['large', 'Large', 120],
];

const KEY = 'pos_text_size';

export function getTextSize() {
  const stored = globalThis.localStorage?.getItem(KEY);
  return TEXT_SIZES.some(([id]) => id === stored) ? stored : 'default';
}

/**
 * Apply a size, and remember it.
 *
 * Written straight onto the root element rather than through a stylesheet, so
 * it takes effect on the keystroke and survives a reload without a flash of the
 * old size — `applyTextSize()` is called before the app renders.
 */
export function applyTextSize(size = getTextSize()) {
  const [, , percent] = TEXT_SIZES.find(([id]) => id === size) || TEXT_SIZES[0];
  if (globalThis.document) {
    globalThis.document.documentElement.style.fontSize = `${percent}%`;
  }
  globalThis.localStorage?.setItem(KEY, size);
  return size;
}

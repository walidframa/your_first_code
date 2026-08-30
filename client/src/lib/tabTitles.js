/**
 * What a tab calls the screen it is showing.
 *
 * Here rather than beside the tab bar so it can be read by a test: it is a pure
 * function over the rail, and the rail is where the names actually live. The
 * component that draws the tabs imports it back.
 */
import { COUNTER_NAV, ADMIN_NAV } from './nav.js'; // extension included: this module is also loaded by node:test, which does not guess

/** Every screen the app knows about, so a tab can be given its real name. */
const TITLES = new Map([
  ...COUNTER_NAV.map((i) => [i.to, i.label]),
  ...ADMIN_NAV.flatMap((group) => group.items.map((i) => [i.to, i.label])),
  ['/menu', 'Menu'],
  ['/admin/settings', 'Settings'],
]);

/**
 * What to call a page.
 *
 * Falls back to the last part of the address rather than to "Untitled": a tab
 * saying `4821` is at least a tab somebody can recognise as the order they were
 * looking at, and a row of identical labels is a tab bar nobody can use.
 */
export function titleFor(path) {
  if (TITLES.has(path)) return TITLES.get(path);

  /*
   * Raising a document is its own screen now, and it is a screen about the same
   * kind of paper as the list it was started from. Named off that list rather
   * than left to the parent search below, which would walk up past
   * `/admin/documents/...` — no rail item matches `/new/` — and land on the
   * section above, calling a half-typed invoice "Dashboard".
   *
   * The rail says "Purchase invoices" because it is a list of them; one of them
   * is a purchase invoice, so the plural is dropped. Crude, and right for all
   * four kinds this can be.
   */
  const raising = /^\/admin\/documents\/new(?:\/([^/]+))?$/.exec(path);
  if (raising) {
    const list = raising[1] ? TITLES.get(`/admin/documents/${raising[1]}`) : null;
    return list ? `New ${list.replace(/s$/, '').toLowerCase()}` : 'New document';
  }

  // The nearest parent that is a known screen — `/admin/orders/48` is an order.
  const parent = [...TITLES.keys()]
    .filter((p) => p !== '/' && path.startsWith(`${p}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (parent) return `${TITLES.get(parent)} · ${path.slice(parent.length + 1)}`;
  return path.replace(/^\//, '') || 'Register';
}

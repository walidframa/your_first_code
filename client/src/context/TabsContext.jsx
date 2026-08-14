import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { COUNTER_NAV, ADMIN_NAV } from '../lib/nav';

/**
 * The pages somebody has open, as tabs across the top.
 *
 * A shop does not do one thing at a time. Somebody is halfway through a sale
 * when a customer asks what a phone costs in the other branch, and the honest
 * shape of that is two pages open, not a trail of back buttons.
 *
 * Tabs are a *list of places*, not a list of live screens: switching to one
 * navigates to it. Keeping every open page mounted would preserve every filter
 * and scroll position, and would also keep half a dozen screens polling and
 * re-rendering behind a till that has to stay quick on a tablet from 2019.
 *
 * The one place that trade would have cost real money is the register, whose
 * cart is somebody's actual sale — so the cart is kept in session storage and
 * comes back with the page. Everything else re-reads from the server, which is
 * where the truth is anyway.
 */

const TabsContext = createContext(null);

const STORAGE_KEY = 'pos_tabs';

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
  // The nearest parent that is a known screen — `/admin/orders/48` is an order.
  const parent = [...TITLES.keys()]
    .filter((p) => p !== '/' && path.startsWith(`${p}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (parent) return `${TITLES.get(parent)} · ${path.slice(parent.length + 1)}`;
  return path.replace(/^\//, '') || 'Register';
}

export function TabsProvider({ children }) {
  const location = useLocation();
  const navigate = useNavigate();

  /*
   * Session storage rather than local: tabs are what this person is doing now,
   * not a preference. A till left open overnight should come back to a clean
   * screen, and the next cashier should not inherit somebody else's morning.
   */
  const [tabs, setTabs] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter((t) => typeof t?.path === 'string') : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
    } catch {
      /* A tab bar is not worth failing over when storage is full or blocked. */
    }
  }, [tabs]);

  /*
   * Wherever the app goes, that place is open — however it was reached. A tab
   * bar that only knows about pages opened by clicking a tab is a tab bar that
   * disagrees with the screen, which is worse than not having one.
   */
  const path = location.pathname;
  useEffect(() => {
    setTabs((prev) =>
      prev.some((t) => t.path === path) ? prev : [...prev, { path, title: titleFor(path) }],
    );
  }, [path]);

  const close = useCallback(
    (target) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.path !== target);
        /*
         * Closing the page you are looking at has to land somewhere. The one
         * to its left is what every other tabbed thing does, and the register
         * is where a shop belongs when nothing else is open.
         */
        if (target === path) {
          const at = prev.findIndex((t) => t.path === target);
          const fallback = next[Math.max(0, at - 1)]?.path || '/';
          navigate(fallback);
        }
        return next;
      });
    },
    [path, navigate],
  );

  const closeAll = useCallback(() => {
    setTabs([]);
    // Back to the till: it is the screen this app is for, and the only one
    // that is never wrong to be on.
    navigate('/');
  }, [navigate]);

  const value = useMemo(
    () => ({ tabs, active: path, close, closeAll, open: (to) => navigate(to) }),
    [tabs, path, close, closeAll, navigate],
  );

  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}

export function useTabs() {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('useTabs must be used within TabsProvider');
  return ctx;
}

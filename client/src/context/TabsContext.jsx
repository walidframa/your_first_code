import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { titleFor } from '../lib/tabTitles';

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

export { titleFor };

const STORAGE_KEY = 'pos_tabs';

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

  /**
   * Tidy the strip without leaving the page.
   *
   * It used to clear every tab and go to the register, which turned "put these
   * away" into "and lose what I was doing". Somebody eight tabs deep who wants
   * one screen back was being sent to the till and made to walk to it again.
   *
   * So the page in front of them stays — it is the one they are looking at,
   * and closing it is not what they asked for. Everything else goes, and
   * nothing navigates.
   */
  const closeAll = useCallback(() => {
    setTabs((prev) => prev.filter((t) => t.path === path));
  }, [path]);

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

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api from '../api';
import { useAuth } from './AuthContext';

const BranchContext = createContext(null);

/*
 * Which shop the app is looking at.
 *
 * Sent as a header on every request rather than threaded through each call, so
 * a screen that never heard of branches still reads the right shelf. The server
 * has the final say — a cashier asking for another branch is simply answered
 * with their own — which is what makes this safe to keep in the browser.
 */
const STORAGE_KEY = 'pos_branch_id';

export function BranchProvider({ children }) {
  const { user } = useAuth();
  const [state, setState] = useState(null);
  const [current, setCurrent] = useState(() => {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });

  /*
   * The header on the shared axios instance. Every request the app makes carries
   * it from here on, including the screens written long before branches existed.
   *
   * Set synchronously rather than in an effect. A screen watching the branch
   * reloads when it changes, and child effects run before the parent's — so an
   * effect here would let that reload go out with the *previous* branch on it,
   * and the page would show the wrong shop's figures until something else
   * happened to refresh it.
   */
  const applyHeader = useCallback((id) => {
    if (id) {
      api.defaults.headers.common['X-Branch-Id'] = String(id);
      localStorage.setItem(STORAGE_KEY, String(id));
    } else {
      delete api.defaults.headers.common['X-Branch-Id'];
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  // Whatever was remembered from last time, on the very first request rather
  // than after it.
  useState(() => applyHeader(current));

  const refresh = useCallback(async () => {
    const res = await api.get('/branches');
    setState(res.data);
    // The server decides. If it answered with a different branch than was asked
    // for — a cashier pinned to their counter — that is the answer.
    applyHeader(res.data.current);
    setCurrent(res.data.current);
    return res.data;
  }, [applyHeader]);

  useEffect(() => {
    if (!user) {
      setState(null);
      return;
    }
    /*
     * If asking which branch we are in fails, carry on as one shop.
     *
     * `setState(null)` here used to mean `loaded` stayed false for ever, and
     * the register — which waits for a branch before it can show a shelf,
     * because stock is held per branch — sat on its loading skeletons with no
     * message and no way forward. One endpoint answering badly took the till
     * down.
     *
     * Falling back is safe: with no branch header the server resolves the main
     * branch itself, which is the right answer for the shops this affects,
     * since a shop with one branch is most of them. The switcher disappears
     * rather than lying about a list we could not fetch.
     */
    refresh().catch(() => setState({ branches: [], current: null, canSwitch: false }));
  }, [user, refresh]);

  const value = useMemo(() => {
    const branches = state?.branches ?? [];
    return {
      branches,
      branch: branches.find((b) => b.id === current) ?? null,
      branchId: current,
      canSwitch: Boolean(state?.canSwitch),
      incoming: state?.incoming ?? 0,
      loaded: state !== null,
      refresh,
      /**
       * Move the whole app to another shop.
       *
       * The header goes first, before any screen has a chance to react to the
       * change and refetch — otherwise the reload carries the old branch.
       */
      switchTo: (id) => {
        const next = Number(id) || null;
        applyHeader(next);
        setCurrent(next);
      },
    };
  }, [state, current, refresh, applyHeader]);

  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>;
}

export function useBranch() {
  const ctx = useContext(BranchContext);
  if (!ctx) throw new Error('useBranch must be used within BranchProvider');
  return ctx;
}

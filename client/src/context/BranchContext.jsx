import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api, { setViewingAll } from '../api';
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
/*
 * Remembered per person, not per machine.
 *
 * A counter computer is shared. With one key for the whole browser, the owner
 * switching to Saida and signing out left the *next* person to sign in asking
 * for Saida — and for anybody allowed to switch branches, the server grants
 * it. So a manager assigned to the main branch opened the other shop's till,
 * on a machine standing in their own, and nothing on screen looked wrong.
 *
 * Keying it by user id means a fresh sign-in asks for nothing, the server
 * answers with where that person actually works, and the app opens there.
 */
const STORAGE_PREFIX = 'pos_branch_id';
const storageKey = (userId) => (userId ? `${STORAGE_PREFIX}:${userId}` : STORAGE_PREFIX);

export function BranchProvider({ children }) {
  const { user } = useAuth();
  const [state, setState] = useState(null);
  /*
   * The owner looking at the whole company rather than one counter.
   *
   * Not remembered between sessions, unlike the branch itself. The branch is
   * where somebody works and should still be there tomorrow; this is a thing
   * you do for a minute to answer a question, and a shop that opened to it
   * every morning would be a shop reading two branches' figures as one.
   */
  const [viewingAll, setAll] = useState(false);
  const [current, setCurrent] = useState(null);

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
  const applyHeader = useCallback(
    (id) => {
      if (id) {
        api.defaults.headers.common['X-Branch-Id'] = String(id);
        if (user?.id) localStorage.setItem(storageKey(user.id), String(id));
      } else {
        delete api.defaults.headers.common['X-Branch-Id'];
        if (user?.id) localStorage.removeItem(storageKey(user.id));
      }
    },
    [user?.id],
  );

  /*
   * Whatever *this person* was last looking at, before the first request goes
   * out rather than after it.
   *
   * Runs when the signed-in user changes, which is the moment the answer
   * changes. Nothing remembered means nothing sent, and the server answers with
   * the branch they are assigned to — which is exactly what should happen on a
   * machine somebody else was using an hour ago.
   */
  useEffect(() => {
    if (!user?.id) return;
    const stored = Number(localStorage.getItem(storageKey(user.id)));
    const remembered = Number.isFinite(stored) && stored > 0 ? stored : null;
    applyHeader(remembered);
    setCurrent(remembered);
  }, [user?.id, applyHeader]);

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
      setViewingAll(false);
      setAll(false);
      /*
       * Off the shared axios instance, so the next person to sign in on this
       * machine does not carry the last one's branch into their first request.
       * Their own remembered branch, if any, is put back by the effect above.
       */
      delete api.defaults.headers.common['X-Branch-Id'];
      setCurrent(null);
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
    /*
     * Re-asked when the branch changes, not only when somebody signs in.
     *
     * Most of the app is remounted on a switch and refetches by itself, but
     * this sits above that and would not: the "on the way here" count in the
     * switcher is the *current* branch's incoming transfers, and left alone it
     * went on reporting the branch you had just left — a badge on the very
     * control you used to leave it.
     *
     * Settles in one round rather than looping: the server answers with the
     * branch it allowed, and setting `current` to the value it already holds
     * is a no-op.
     */
  }, [user, refresh, current]);

  const value = useMemo(() => {
    const branches = state?.branches ?? [];
    return {
      branches,
      viewingAll,
      /**
       * Widen to the company, or come back to one counter.
       *
       * The flag goes to the api module before the state changes, for the same
       * reason the branch header does: a screen watching this reloads when it
       * changes, and child effects run before the parent's, so setting it
       * afterwards would let that reload go out without it.
       */
      setViewingAll: (on) => {
        setViewingAll(on);
        setAll(Boolean(on));
      },
      branch: branches.find((b) => b.id === current) ?? null,
      branchId: current,
      canSwitch: Boolean(state?.canSwitch),
      /* How many shops there are, not how many this person may see. */
      total: state?.total ?? branches.length,
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
  }, [state, current, viewingAll, refresh, applyHeader]);

  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>;
}

export function useBranch() {
  const ctx = useContext(BranchContext);
  if (!ctx) throw new Error('useBranch must be used within BranchProvider');
  return ctx;
}

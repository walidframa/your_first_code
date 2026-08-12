import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api from '../api';
import { useAuth } from './AuthContext';

const SupportContext = createContext(null);

/** How often the shop checks whether somebody is in. */
const EVERY_MS = 30 * 1000;

/**
 * Whether the vendor is inside this shop right now.
 *
 * Asked on a timer rather than pushed, because the alternative is a socket held
 * open by every till in every shop for a thing that happens a few times a year.
 * Half a minute is late enough to be cheap and early enough that nobody works
 * for long beside a stranger without being told.
 *
 * Only asked while somebody is signed in: there is nothing to warn an empty
 * screen about, and it is one fewer thing for a locked shop's login page to be
 * polling.
 */
export function SupportProvider({ children }) {
  const { token, user } = useAuth();
  const [support, setSupport] = useState(null);

  const refresh = useCallback(() => {
    /*
     * Not until somebody is actually signed in — `user`, not just a token in
     * storage.
     *
     * A token is put in localStorage before the app has checked it, and the
     * shared axios instance does not carry it until an effect one layer up has
     * run. This poll used to fire in that gap, arrive with no credentials, and
     * take a 401 — which the interceptor reads as "the session ended" and
     * answers by wiping the token and throwing the cashier out to the sign-in
     * screen. A background check on whether anybody is visiting must never be
     * able to log the shop out; waiting for `user` is what makes sure of it.
     */
    if (!token || !user) return setSupport(null);
    return api
      .get('/support/state', { headers: { Authorization: `Bearer ${token}` } })
      /*
       * A server that cannot be reached says nothing either way, and the last
       * thing a till surviving an outage needs is a warning bar about it.
       */
      .then((res) => setSupport(res.data.support))
      .catch(() => {});
  }, [token, user]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, EVERY_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const value = useMemo(() => ({ support, refresh }), [support, refresh]);
  return <SupportContext.Provider value={value}>{children}</SupportContext.Provider>;
}

export function useSupport() {
  return useContext(SupportContext) || { support: null, refresh: () => {} };
}

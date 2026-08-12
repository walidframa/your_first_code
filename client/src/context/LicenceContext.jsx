import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api from '../api';

const LicenceContext = createContext(null);

/**
 * Whether this shop is still paid up.
 *
 * Asked without signing in, because a till that has stopped has to say why on
 * the screen a cashier is looking at — and because the sign-in screen itself
 * should carry the warning, so an owner who only opens the app to check
 * something still sees the date coming.
 *
 * A copy that is nobody's tenant answers `active` and this is never seen again.
 */
export function LicenceProvider({ children }) {
  const [licence, setLicence] = useState(null);
  const [checked, setChecked] = useState(false);

  const refresh = useCallback(
    () =>
      api
        .get('/licence')
        .then((res) => setLicence(res.data.licence))
        /*
         * A server that cannot be reached says nothing about the licence, so
         * nothing is what this reports. Locking a till because the machine in
         * the back is rebooting would undo the whole point of the offline mode
         * beside it.
         */
        .catch(() => {})
        .finally(() => setChecked(true)),
    [],
  );

  useEffect(() => {
    refresh();
    /*
     * Once an hour, so a shop that pays at ten past nine is selling by twenty
     * past without anybody reloading anything. The 402 on the next write is the
     * fast path in the other direction.
     */
    const timer = setInterval(refresh, 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  const value = useMemo(
    () => ({
      licence,
      checked,
      refresh,
      locked: licence?.state === 'locked',
      warning: licence?.state === 'due' || licence?.state === 'overdue',
    }),
    [licence, checked, refresh],
  );

  return <LicenceContext.Provider value={value}>{children}</LicenceContext.Provider>;
}

export function useLicence() {
  return useContext(LicenceContext) || { licence: null, checked: true, locked: false };
}

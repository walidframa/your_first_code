import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api from '../api';
import { useAuth } from './AuthContext';

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
  /*
   * What this shop bought, from the same call.
   *
   * `null` until the first answer comes back, and every screen is shown while
   * it is — a menu that flashed empty and then filled in would be worse than a
   * menu that briefly offers one screen too many.
   */
  const [modules, setModules] = useState(null);
  const [checked, setChecked] = useState(false);

  const refresh = useCallback(
    () =>
      api
        .get('/licence')
        .then((res) => {
          setLicence(res.data.licence);
          setModules(res.data.modules ?? null);
        })
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

  /*
   * Asked again whenever somebody signs in or out.
   *
   * The list of what this shop bought comes back on this call, and the vendor
   * can change it at any moment from the console. Without this the menu is
   * whatever it was when the tab was opened — a feature switched on this
   * morning would not appear until an hour later or a reload, and the
   * shopkeeper on the phone would be told it is not there.
   */
  const { token } = useAuth();

  useEffect(() => {
    refresh();
    /*
     * Once an hour, so a shop that pays at ten past nine is selling by twenty
     * past without anybody reloading anything. The 402 on the next write is the
     * fast path in the other direction.
     */
    const timer = setInterval(refresh, 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, [refresh, token]);

  const value = useMemo(
    () => ({
      licence,
      checked,
      refresh,
      modules,
      /** Does this shop have that feature? Unknown yet counts as yes. */
      hasModule: (key) => !modules || modules.includes(key),
      locked: licence?.state === 'locked',
      warning: licence?.state === 'due' || licence?.state === 'overdue',
    }),
    [licence, checked, refresh, modules],
  );

  return <LicenceContext.Provider value={value}>{children}</LicenceContext.Provider>;
}

export function useLicence() {
  return (
    useContext(LicenceContext) || {
      licence: null,
      checked: true,
      locked: false,
      modules: null,
      hasModule: () => true,
    }
  );
}

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import api, { setAuthToken } from '../api';
import { applyTextSize } from '../lib/textSize';
import { applyTheme } from '../lib/theme';

const AuthContext = createContext(null);

/*
 * Who was signed in last time, kept on the device.
 *
 * Not a credential — the token is the credential, and this is only the name and
 * the permissions that came back with it. It exists so that a till whose server
 * has gone away can carry on being signed in, instead of throwing the cashier
 * out at the exact moment they can do least about it.
 */
function rememberedUser() {
  try {
    return JSON.parse(localStorage.getItem('pos_user') || 'null');
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem('pos_token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    setAuthToken(token);
    api
      .get('/auth/me')
      .then((res) => {
        setUser(res.data.user);
        localStorage.setItem('pos_user', JSON.stringify(res.data.user));
        /*
         * The size this person reads at, on whatever machine they are sitting
         * at. Only when the account has one — otherwise this device's own
         * choice stands, which is what a shared counter tablet wants.
         */
        if (res.data.user.textSize) applyTextSize(res.data.user.textSize);
        if (res.data.user.theme) applyTheme(res.data.user.theme);
      })
      .catch((err) => {
        /*
         * A refusal and a silence mean opposite things.
         *
         * The server saying no is the session being over, and the right answer
         * is the login screen. The server saying nothing is the machine behind
         * the counter being off — the session is untouched, and logging
         * somebody out over it strands a till that would otherwise still sell.
         */
        if (!err.response) {
          setUser(rememberedUser());
          return;
        }
        localStorage.removeItem('pos_token');
        localStorage.removeItem('pos_user');
        setToken(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, [token]);

  async function login(username, password) {
    const res = await api.post('/auth/login', { username, password });
    localStorage.setItem('pos_token', res.data.token);
    localStorage.setItem('pos_user', JSON.stringify(res.data.user));
    setAuthToken(res.data.token);
    setToken(res.data.token);
    setUser(res.data.user);
    // See the effect above: a machine this person has never used comes up at
    // the size they read at rather than the last person's.
    if (res.data.user.textSize) applyTextSize(res.data.user.textSize);
    if (res.data.user.theme) applyTheme(res.data.user.theme);
  }

  /**
   * The vendor, arriving on a ticket instead of a password.
   *
   * The same shape as signing in and deliberately so — from here on the app
   * cannot tell the difference, and should not have to. What differs is behind
   * it: the account is the shop's reserved `__support` row, the token says which
   * visit it belongs to, and the shop is showing a bar about it the whole time.
   */
  async function signInWithTicket(ticket) {
    const res = await api.post('/support/redeem', { token: ticket });
    localStorage.setItem('pos_token', res.data.token);
    localStorage.setItem('pos_user', JSON.stringify(res.data.user));
    setAuthToken(res.data.token);
    setToken(res.data.token);
    setUser(res.data.user);
  }

  /**
   * Change your own password, and stay signed in.
   *
   * The server hands back a fresh token because the one this browser is holding
   * is now older than the password behind it — which is exactly what it refuses.
   */
  async function changePassword(currentPassword, newPassword) {
    const res = await api.post('/auth/password', { currentPassword, newPassword });
    localStorage.setItem('pos_token', res.data.token);
    localStorage.setItem('pos_user', JSON.stringify(res.data.user));
    setAuthToken(res.data.token);
    setToken(res.data.token);
    setUser(res.data.user);
  }

  function logout() {
    localStorage.removeItem('pos_token');
    localStorage.removeItem('pos_user');
    setAuthToken(null);
    setToken(null);
    setUser(null);
  }

  /*
   * What this person may do, asked as a question rather than read as a list.
   * An admin is the owner of the shop and passes everything — the server takes
   * the same view, so the two cannot drift.
   */
  const can = useCallback(
    (permission) => {
      if (!user) return false;
      if (user.role === 'admin') return true;
      return (user.permissions || []).includes(permission);
    },
    [user],
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        login,
        logout,
        can,
        changePassword,
        signInWithTicket,
        /*
         * The screens somebody starred, kept at the top of the menu.
         *
         * Written to the account so it follows them to another machine, and
         * put on `user` straight away so the star fills in under the finger
         * rather than a round trip later. A save that fails leaves the menu
         * showing what the server still believes on the next sign-in, which is
         * the honest outcome for a bookmark.
         */
        setFavourites: async (paths) => {
          setUser((u) => (u ? { ...u, favourites: paths } : u));
          try {
            await api.put('/auth/favourites', { favourites: paths });
          } catch {
            /* A shortcut list is not worth interrupting a shopkeeper for. */
          }
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

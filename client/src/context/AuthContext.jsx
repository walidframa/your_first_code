import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import api, { setAuthToken } from '../api';

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
    <AuthContext.Provider value={{ user, token, loading, login, logout, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

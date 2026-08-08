import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import api, { setAuthToken } from '../api';

const AuthContext = createContext(null);

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
      .then((res) => setUser(res.data.user))
      .catch(() => {
        localStorage.removeItem('pos_token');
        setToken(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, [token]);

  async function login(username, password) {
    const res = await api.post('/auth/login', { username, password });
    localStorage.setItem('pos_token', res.data.token);
    setAuthToken(res.data.token);
    setToken(res.data.token);
    setUser(res.data.user);
  }

  function logout() {
    localStorage.removeItem('pos_token');
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

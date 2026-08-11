import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

export function setAuthToken(token) {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
}

/**
 * A session that has ended sends you to the login screen.
 *
 * Without this, an expired token surfaces wherever it happened to be noticed —
 * as the words "Invalid or expired token" inside whatever form was open, which
 * reads as "this form is broken" rather than "sign in again". At a counter with
 * a customer waiting, that is a cashier retyping a repair ticket three times.
 *
 * It fires on any 401 from any screen, because there is only one cause: the
 * token is no longer good. In development that happens on every server restart,
 * since the dev signing key is generated per process.
 *
 * The login attempt itself is exempt — a wrong password is a 401 the login form
 * has to be able to report in place.
 */
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const expired = error.response?.status === 401;
    const signingIn = String(error.config?.url || '').includes('/auth/login');

    if (expired && !signingIn) {
      localStorage.removeItem('pos_token');
      setAuthToken(null);
      /*
       * A full navigation rather than a router push: this is reached from
       * outside React, and it also clears whatever half-filled state the dead
       * session left behind.
       */
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign('/login?expired=1');
      }
    }

    return Promise.reject(error);
  },
);

export default api;

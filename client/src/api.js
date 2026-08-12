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
    /*
     * Two 401s mean "you typed it wrong", not "your session ended", and both
     * have a screen of their own that has to be able to say so in place: the
     * login form, and the page a support ticket lands on.
     */
    const url = String(error.config?.url || '');
    const signingIn = url.includes('/auth/login') || url.includes('/support/redeem');

    /*
     * And one that must never throw anybody out on its own.
     *
     * The support poll runs on a timer in the background. If a stray 401 from
     * it could end the session, a cashier mid-sale would be sent to the login
     * screen by a request nobody made and nothing was waiting for. A session
     * that has really ended will be found by the next request that matters.
     */
    const background = url.includes('/support/state');
    if (background) return Promise.reject(error);

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

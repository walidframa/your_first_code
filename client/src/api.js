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
    /*
     * Changing your password is the third of these, and it was missed.
     *
     * Getting the *current* password wrong answers 401, which is the same
     * "you typed it wrong" as the login form — not "your session ended". Left
     * in the general case, mistyping it wiped the token and threw the person
     * out to the sign-in screen, from a form they were successfully signed in
     * to, with no idea what they had done. Which reads exactly like the
     * password change being broken.
     */
    const signingIn =
      url.includes('/auth/login') ||
      url.includes('/support/redeem') ||
      url.includes('/auth/password');

    /*
     * A 401 caused by our own token being replaced is not an expired session.
     *
     * Changing a password invalidates every token issued before it — including
     * requests that were already in flight when the change landed. Those come
     * back 401 through no fault of the person at the counter, and treating them
     * as an ended session wipes the *new* token and navigates to the sign-in
     * screen. That navigation then cancels the change-password request itself,
     * which surfaces as an error with no response at all: "the server did not
     * answer", from a change that had already succeeded.
     *
     * The whole story from the shop was this: the password changed, the app
     * threw them out, they signed in again with the old one, and concluded that
     * changing a password breaks it.
     *
     * So: if the request went out with a different token than the one we hold
     * now, the token was rotated underneath it. Send it again with the current
     * one. Once only — a second 401 with the same token is a real one.
     */
    const sentWith = error.config?.headers?.Authorization;
    const holding = api.defaults.headers.common.Authorization;
    if (expired && sentWith && holding && sentWith !== holding && !error.config.__retried) {
      error.config.__retried = true;
      error.config.headers.Authorization = holding;
      return api.request(error.config);
    }

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

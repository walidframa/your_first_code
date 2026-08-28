import axios from 'axios';
import { apiBase, isNative } from './lib/server.js';

/*
 * Where the shop is.
 *
 * On the web this is `/api` and always was: the app is served by the server it
 * is talking to, so a relative path is correct by construction and survives the
 * shop changing domain.
 *
 * In the phone app the pages are bundled into the app and the WebView serves
 * them from its own origin, so `/api` is the bundle — a place with no server in
 * it. There the address is whatever the owner typed on the connect screen, and
 * it is read here at every request rather than captured once, because a person
 * can change it without restarting the app and the next call has to go to the
 * new shop rather than the old one.
 */
const api = axios.create({ baseURL: apiBase() });

api.interceptors.request.use((config) => {
  if (isNative()) config.baseURL = apiBase();
  return config;
});

/*
 * Looking at the whole company rather than one counter.
 *
 * Set from the branch switcher. It widens **reading only**, and that is the
 * point rather than an omission: a sale, an invoice or a cashbox has to belong
 * to one shop, and a register in "all branches" mode would be a till with
 * nowhere to ring money into. So writes go on carrying the branch header and
 * behave exactly as they did; only GETs are widened, and only for somebody the
 * server agrees may see the whole company — it checks the permission itself and
 * answers with one branch if not.
 */
let viewingAll = false;

export function setViewingAll(on) {
  viewingAll = Boolean(on);
}

api.interceptors.request.use((config) => {
  if (viewingAll && String(config.method || 'get').toLowerCase() === 'get') {
    config.params = { ...(config.params || {}), branch: 'all' };
  }
  return config;
});

export function setAuthToken(token) {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
  /*
   * A rotation is over when the new token is *in place*, not when the reply
   * carrying it arrived — those are two different moments, and anything
   * retried in between would go out holding the token that just died.
   */
  releaseRotation();
}

/*
 * Is a password change on its way to the server right now?
 *
 * Changing a password kills every token issued before it, including ones on
 * requests that left this same tab a moment earlier. Those come back 401 while
 * the new token is still in the post — so at that instant the app is holding
 * the *old* token, nothing looks rotated, and the plain reading is "the session
 * ended". Signing out then navigates away, which cancels the password change's
 * own reply, and the form reports a server that did not answer for a change the
 * server had already made.
 *
 * So the rotation is tracked while it is happening, not only after. A 401 that
 * arrives during one waits for the new token and is sent again with it.
 */
const rotates = (url) => String(url || '').includes('/auth/password');

let rotating = 0;
let rotationSettled = null;
let rotationDone = null;

api.interceptors.request.use((config) => {
  if (rotates(config.url)) {
    rotating += 1;
    if (rotating === 1) {
      rotationSettled = new Promise((resolve) => {
        rotationDone = resolve;
      });
    }
  }
  return config;
});

/** Let anything waiting on the new token go. */
function releaseRotation() {
  if (rotationDone) {
    rotationDone();
    rotationDone = null;
  }
}

/**
 * Called however the change ends — a new token, or a refusal.
 *
 * The release is deferred by a turn so the normal path wins: a successful
 * change calls `setAuthToken` immediately after this, and waiters should see
 * that token rather than the one it replaced. This is only the safety net, for
 * a change that was refused and so never sets one — without it, a request that
 * happened to 401 alongside a rejected password change would wait for ever.
 */
function finishedRotating(config) {
  if (!rotates(config?.url)) return;
  rotating = Math.max(0, rotating - 1);
  if (rotating === 0) setTimeout(releaseRotation, 0);
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
  (response) => {
    finishedRotating(response.config);
    return response;
  },
  async (error) => {
    finishedRotating(error.config);
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
    /*
     * Caught by a rotation that has not finished yet. Wait for the new token
     * and send it again — the request was never really refused, it was simply
     * carrying a token that stopped being valid while it was in the air.
     */
    if (expired && rotating > 0 && !rotates(url) && error.config && !error.config.__retried) {
      error.config.__retried = true;
      await rotationSettled;
      error.config.headers.Authorization = api.defaults.headers.common.Authorization;
      return api.request(error.config);
    }

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

    /*
     * A screen asking for something the server has never heard of.
     *
     * This means one thing in practice: the browser is running a newer build
     * than the server is. It happens when a deploy puts the new files on disk
     * but the service does not come back up on them, and it is miserable to
     * diagnose from "Not found" — the shop reads that as "my agency does not
     * exist" and starts looking in the wrong place entirely.
     *
     * Only for the verbs that change something. A GET that 404s is usually an
     * honest answer about one record.
     */
    const changing = ['post', 'put', 'patch', 'delete'].includes(
      String(error.config?.method || '').toLowerCase(),
    );
    if (error.response?.status === 404 && changing && url.startsWith('/')) {
      error.response.data = {
        ...error.response.data,
        error:
          'This part of the app is newer than the server it is talking to. ' +
          'The shop was updated but its server was not restarted — restart it and try again.',
      };
    }

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

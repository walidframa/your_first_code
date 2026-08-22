/**
 * Which shop this copy of the app talks to.
 *
 * On the web this question does not exist. The app is served *by* the shop's
 * own server, so `/api` is that server by definition and there is nothing to
 * configure or to get wrong.
 *
 * In a phone app it is the first question and it has no default. The pages are
 * bundled into the app itself and the WebView serves them from its own origin —
 * `capacitor://localhost` on iOS, `https://localhost` on Android — so `/api`
 * points at the bundle, where there is no server at all. Someone has to say
 * where the shop is, and the app has to remember.
 *
 * So the address is resolved once, here, and everything else asks this module
 * rather than assuming. On the web it resolves to same-origin and the app
 * behaves exactly as it always has; in the app it resolves to what the owner
 * typed on the connect screen.
 */
import { Capacitor } from '@capacitor/core';

const KEY = 'pos_server';

/** Is this the real app on a phone, rather than a page in a browser? */
export const isNative = () => Capacitor.isNativePlatform();

/** 'ios', 'android', or 'web'. */
export const platform = () => Capacitor.getPlatform();

/**
 * Tidy up what somebody typed.
 *
 * A shopkeeper types `xtechpos.com`, or pastes `https://xtechpos.com/admin`
 * out of a browser, or adds a trailing slash. All three mean the same shop and
 * all three must work, because the alternative is an app that says "cannot
 * connect" to a person who typed their own address correctly.
 *
 * https is assumed when no scheme is given. Plain http is left alone if it was
 * asked for by name — a shop running on the counter's own wifi with no
 * certificate is a real arrangement, and refusing it would be this app
 * deciding it knows better.
 */
export function normalise(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return '';
  }

  if (!url.hostname) return '';

  // Only the part that names the server. A path somebody pasted from their
  // address bar is where they were standing in the app, not where the app is.
  return `${url.protocol}//${url.host}`;
}

/** The address this app is set to, or '' when it has never been told. */
export function saved() {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    // A WebView with storage denied. Unknown, which the caller handles.
    return '';
  }
}

/** Remember the shop, after checking the shape of what was given. */
export function remember(input) {
  const address = normalise(input);
  if (!address) return '';
  try {
    localStorage.setItem(KEY, address);
  } catch {
    // Nothing to be done, and refusing to continue would be worse: the address
    // still works for this run.
  }
  return address;
}

/** Forget it, so the connect screen is asked again. */
export function forget() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Already unreachable.
  }
}

/**
 * Where API calls should go.
 *
 * Relative on the web, on purpose and not as a fallback: the app is served by
 * the server it is talking to, so a relative path is both correct and immune to
 * the shop moving to a new domain. Absolute in the app, because there it has to
 * be.
 */
export function apiBase() {
  if (!isNative()) return '/api';
  const address = saved();
  return address ? `${address}/api` : '';
}

/** Does this copy still need to be told where the shop is? */
export function needsSetup() {
  return isNative() && !saved();
}

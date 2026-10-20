/*
 * Is the app waiting on the server right now?
 *
 * Every request through `api.js` is counted in and counted out, and whoever
 * subscribes is told when the count crosses zero in either direction. That is
 * the whole of it: one number, so that one small icon can say "fetching" for
 * the entire app rather than each of a hundred screens remembering to.
 *
 * Two kinds of request are left out of the count on purpose:
 *
 * - The polls. The server is asked every few seconds whether it is there and
 *   whether support is in the shop, and nobody is waiting for either answer.
 *   Counted, they would keep the icon flickering on a till that is doing
 *   nothing, which teaches the counter to ignore it.
 * - Anything that asks to be quiet with `{ quiet: true }` on its request
 *   config — a background refresh a screen runs on a timer, say.
 */
const QUIET_PATHS = ['/health', '/support/state'];

/** Should this request keep the icon off? */
export function isQuiet(config) {
  if (!config) return true;
  if (config.quiet) return true;
  const url = String(config.url || '');
  return QUIET_PATHS.some((path) => url.includes(path));
}

let inFlight = 0;
const listeners = new Set();

function tell() {
  for (const listener of listeners) listener(inFlight > 0, inFlight);
}

/** How many requests are out right now. */
export function pending() {
  return inFlight;
}

/**
 * A request has left. Marked on the config itself so the matching `finish`
 * can only ever undo this once — a request that is retried passes through
 * here twice, and must be counted twice, but a reply that is handled twice
 * must not uncount it twice.
 */
export function begin(config) {
  if (isQuiet(config) || config.__counted) return;
  config.__counted = true;
  inFlight += 1;
  if (inFlight === 1) tell();
}

/** Its answer is back, or it failed. Either way the wait is over. */
export function finish(config) {
  if (!config || !config.__counted) return;
  config.__counted = false;
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0) tell();
}

/**
 * Be told when the app starts or stops waiting. Returns the way to stop
 * listening. The listener is called with `busy` and the current count.
 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Only for tests: forget everything. */
export function reset() {
  inFlight = 0;
  listeners.clear();
}

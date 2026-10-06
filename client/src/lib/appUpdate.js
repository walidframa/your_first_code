/**
 * Telling the counter that a new version is waiting.
 *
 * A shop takes an update by somebody on the server running the deploy, and
 * until now that was where it stopped: the till already had the app open, its
 * service worker had already cached the shell, and nothing on the screen ever
 * mentioned that there was anything new. The shop found out when a change they
 * had asked for did not appear, and the cure was somebody with developer tools
 * clearing the site by hand. One shop ran four deploys behind that way.
 *
 * So the worker now waits rather than seizing control — see public/sw.js for
 * why a till must not have its assets swapped mid-sale — and this is the part
 * that notices it waiting and offers the reload.
 *
 * Deliberately not automatic. A page that reloads itself because a deploy
 * happened three seconds ago is a page that can throw away a half-rung sale,
 * and no amount of freshness is worth that. The person at the counter presses
 * it, between customers, which is exactly when it should happen.
 */
const listeners = new Set();
let waiting = null;

/*
 * How long after the page starts an update still counts as "found by this
 * load" rather than "arrived while the till was in use".
 *
 * Registering the worker makes the browser look for a new sw.js, and if there
 * is one it installs in the first seconds of the page's life. That update is
 * not news to this page: a navigation goes to the network for index.html, so a
 * page that has just loaded is already running the build the new worker
 * carries. Thirty seconds is long enough for a slow install and well short of
 * the hourly check, which is the one that finds updates worth a banner.
 */
const STARTUP_WINDOW_MS = 30_000;

function announce() {
  for (const listener of listeners) listener(Boolean(waiting));
}

/** Called when a new version is ready, and immediately if one already is. */
export function onUpdateReady(listener) {
  listeners.add(listener);
  listener(Boolean(waiting));
  return () => listeners.delete(listener);
}

/**
 * Take it now.
 *
 * The worker is told to stop waiting; the browser then swaps the controller,
 * and the reload happens on that event rather than straight away — reloading
 * first would fetch the old assets from the old worker and change nothing,
 * which is the failure that makes people press a button twice and conclude it
 * does not work.
 */
export function applyUpdate() {
  if (!waiting) {
    globalThis.location.reload();
    return;
  }
  waiting.postMessage({ type: 'skip-waiting' });
}

/**
 * Watch one registration for a worker that has installed and is waiting.
 *
 * Two kinds of waiting worker, told apart by when they turned up:
 *
 * - One found by this load — already there when the page registered, or
 *   installed within the first seconds because registering made the browser
 *   look. The page is on the current build already (navigations go to the
 *   network for index.html), so the worker is simply told to take over, and
 *   nothing is said. This is what a manual reload after a deploy produces,
 *   and a banner announcing a version the page is already running was the
 *   complaint.
 *
 * - One found later, by the hourly check, while the till has been open for a
 *   while. That page is on the old build, and the banner offers the reload.
 */
function watch(registration, now) {
  const startedAt = now();
  const check = () => {
    const found = registration.waiting;
    if (!found) return;
    if (now() - startedAt < STARTUP_WINDOW_MS) {
      // Not set as `waiting`: the controller change this causes must not
      // reload a page that is already current.
      found.postMessage({ type: 'skip-waiting' });
      return;
    }
    /*
     * Without a controller there is nothing to interrupt — it is the first
     * load — and the worker should simply take over.
     */
    if (!navigator.serviceWorker.controller) {
      found.postMessage({ type: 'skip-waiting' });
      return;
    }
    waiting = found;
    announce();
  };

  check();
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') check();
    });
  });
}

export function startUpdateWatch({ now = Date.now, register } = {}) {
  if (!register && !('serviceWorker' in navigator)) return;
  const registerWorker = register || (() => navigator.serviceWorker.register('/sw.js'));

  /*
   * One reload, when the new worker actually takes over. Guarded because the
   * event also fires on the very first load, when there is nothing to reload
   * for and doing it would bounce a shop that has only just opened the app.
   */
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !waiting) return;
    reloading = true;
    globalThis.location.reload();
  });

  return registerWorker()
    .then((registration) => {
      watch(registration, now);
      /*
       * Ask again now and then. A till is opened in the morning and left on all
       * day, so without this the only moment it would ever look for a new
       * version is a reload nobody has any reason to do. Hourly is far more
       * often than a shop deploys and costs one request.
       */
      setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000);
    })
    .catch(() => {
      // A till without the worker still sells; it just cannot survive the
      // server going away.
    });
}

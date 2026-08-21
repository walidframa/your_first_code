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

/** Watch one registration for a worker that has installed and is waiting. */
function watch(registration) {
  const check = () => {
    /*
     * `waiting` is a worker that has installed while another controls the
     * page. Without a controller there is nothing to interrupt — it is the
     * first load — and it should simply take over.
     */
    if (registration.waiting && navigator.serviceWorker.controller) {
      waiting = registration.waiting;
      announce();
    }
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

export function startUpdateWatch() {
  if (!('serviceWorker' in navigator)) return;

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

  navigator.serviceWorker
    .register('/sw.js')
    .then((registration) => {
      watch(registration);
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

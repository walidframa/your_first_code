/**
 * Putting the till on the desktop, without shipping a desktop app.
 *
 * A shopkeeper who wants "an icon I double-click" is asking for a window of its
 * own, a Start-menu entry, and no address bar for a cashier to wander out of.
 * A browser gives all three for an installed web app — and the version that
 * ships that way is the one on the server, so an update reaches every till on
 * the next open rather than being a file somebody has to go and re-download.
 *
 * The catch is that the browser decides when to offer it, so the offer has to
 * be caught the moment it is made — before React has rendered anything — and
 * held until somebody presses the button.
 */

let deferred = null;
const listeners = new Set();

function announce() {
  for (const fn of listeners) fn(deferred !== null);
}

/** Called once at boot, before the first render. */
export function watchForInstall() {
  globalThis.addEventListener?.('beforeinstallprompt', (event) => {
    // Without this the browser shows its own bar wherever it likes, which on a
    // register is on top of something somebody is trying to press.
    event.preventDefault();
    deferred = event;
    announce();
  });

  globalThis.addEventListener?.('appinstalled', () => {
    deferred = null;
    announce();
  });
}

export function onInstallable(fn) {
  listeners.add(fn);
  fn(deferred !== null);
  return () => listeners.delete(fn);
}

/** True when this window *is* the installed app rather than a browser tab. */
export function isInstalled() {
  return (
    globalThis.matchMedia?.('(display-mode: standalone)').matches === true ||
    globalThis.navigator?.standalone === true
  );
}

/**
 * Ask, and report whether it was accepted.
 *
 * The prompt can only be used once, so it is dropped either way: a browser that
 * has been refused will offer another when it feels like it.
 */
export async function install() {
  if (!deferred) return false;
  const prompt = deferred;
  deferred = null;
  announce();
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome === 'accepted';
}

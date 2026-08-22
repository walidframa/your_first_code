/**
 * The things a phone can do that a browser tab cannot.
 *
 * Every function here is safe to call anywhere. On the web they do nothing and
 * return, rather than throwing or needing to be guarded at each of their call
 * sites — the alternative is `isNative() &&` smeared through the UI, and the
 * one place somebody forgets it is a crash on a device nobody is holding.
 *
 * Nothing in here is load-bearing. A sale still goes through with no haptics,
 * no status bar and no wake lock; these are the difference between an app that
 * works and an app that feels like it belongs on the phone, and none of them is
 * worth a white screen if a plugin is missing.
 */
import { Capacitor } from '@capacitor/core';

const native = () => Capacitor.isNativePlatform();

/**
 * Load a plugin only when there is one.
 *
 * Dynamic so the web build does not carry native code it will never run, and
 * caught so that a plugin missing from one platform's build is a feature that
 * quietly does not happen rather than a screen that does not open.
 */
async function plugin(load) {
  if (!native()) return null;
  try {
    return await load();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- the hand */

/**
 * A tap you can feel.
 *
 * A real till has keys that click, and that click is how somebody at a counter
 * knows a press landed without looking down. A phone has one way to say the
 * same thing, and this is it: light for an ordinary press, and heavier where
 * the app is telling you something happened.
 */
export async function tap(weight = 'light') {
  const mod = await plugin(() => import('@capacitor/haptics'));
  if (!mod) return;
  try {
    await mod.Haptics.impact({ style: mod.ImpactStyle[weight === 'light' ? 'Light' : 'Medium'] });
  } catch {
    // A device with no vibrator. Not a failure worth reporting.
  }
}

/** A scan that read, a sale that went through: the good kind of buzz. */
export async function buzzGood() {
  const mod = await plugin(() => import('@capacitor/haptics'));
  if (!mod) return;
  try {
    await mod.Haptics.notification({ type: mod.NotificationType.Success });
  } catch {
    /* no vibrator */
  }
}

/** Something was refused. Distinctly different in the hand from success. */
export async function buzzBad() {
  const mod = await plugin(() => import('@capacitor/haptics'));
  if (!mod) return;
  try {
    await mod.Haptics.notification({ type: mod.NotificationType.Error });
  } catch {
    /* no vibrator */
  }
}

/* ------------------------------------------------------------ the chrome */

/**
 * The strip at the top of the phone, made part of the app.
 *
 * Left alone it is a white bar with black numerals sitting above a dark navy
 * header, which is the single clearest tell that what you are looking at is a
 * web page in a box.
 */
export async function paintStatusBar(dark = true) {
  const mod = await plugin(() => import('@capacitor/status-bar'));
  if (!mod) return;
  try {
    await mod.StatusBar.setStyle({ style: dark ? mod.Style.Dark : mod.Style.Light });
    if (Capacitor.getPlatform() === 'android') {
      await mod.StatusBar.setBackgroundColor({ color: dark ? '#0f172a' : '#ffffff' });
    }
  } catch {
    /* older platform */
  }
}

/** Take the splash down once the app has actually drawn something. */
export async function hideSplash() {
  const mod = await plugin(() => import('@capacitor/splash-screen'));
  try {
    await mod?.SplashScreen.hide();
  } catch {
    /* already gone */
  }
}

/* ------------------------------------------------------------ the screen */

let wakeLock = null;

/**
 * Keep the screen on while the register is open.
 *
 * A phone locks itself after thirty seconds. On a counter that means the till
 * goes black between one customer and the next, and every sale starts with a
 * passcode. The lock is released as soon as the register is left, because
 * holding a shop's phone awake all day is somebody's battery.
 *
 * The browser's own Wake Lock API rather than a plugin: it is what Capacitor's
 * WebView exposes on both platforms, and it works on the web too, where a till
 * on a tablet in a browser has exactly the same problem.
 */
export async function keepAwake() {
  try {
    if (wakeLock || !navigator.wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    /*
     * The lock dies whenever the page is hidden — a call comes in, the shop
     * checks WhatsApp — and does not come back on its own. Without this the
     * feature works until the first interruption and then silently stops.
     */
    wakeLock.addEventListener?.('release', () => {
      wakeLock = null;
    });
  } catch {
    // Refused, or unsupported. The screen dims; nothing else changes.
    wakeLock = null;
  }
}

/** Let the screen sleep again. */
export async function letSleep() {
  try {
    await wakeLock?.release();
  } catch {
    /* already released */
  }
  wakeLock = null;
}

/* ------------------------------------------------------------- the back */

/**
 * Android's back button, which every Android user presses without thinking.
 *
 * Untouched, it closes the whole app from any screen — so a cashier backing out
 * of a product page is suddenly on the home screen with a cart half rung up.
 * The rule people expect is: go back if there is anywhere to go, and only leave
 * from the screen you started on.
 *
 * Returns its own undo, so a component can stop listening when it unmounts.
 */
export async function handleBackButton(onBack) {
  const mod = await plugin(() => import('@capacitor/app'));
  if (!mod) return () => {};
  try {
    const handle = await mod.App.addListener('backButton', ({ canGoBack }) => {
      onBack({ canGoBack });
    });
    return () => handle.remove();
  } catch {
    return () => {};
  }
}

/** Share a receipt, an invoice, a figure — through whatever the phone has. */
export async function share({ title, text, url }) {
  const mod = await plugin(() => import('@capacitor/share'));
  if (mod) {
    try {
      await mod.Share.share({ title, text, url, dialogTitle: title });
      return true;
    } catch {
      // Cancelled by the person, which is not an error.
      return false;
    }
  }

  // On the web, the browser's own sheet where there is one.
  try {
    if (navigator.share) {
      await navigator.share({ title, text, url });
      return true;
    }
  } catch {
    /* cancelled */
  }
  return false;
}

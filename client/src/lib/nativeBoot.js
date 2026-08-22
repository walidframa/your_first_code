/**
 * Turning the document into an app, before anything is drawn.
 *
 * A dozen rules in index.css hang off `body.native`: the tap highlight, the
 * selection bubble, the rubber-band bounce, the safe-area padding. Setting the
 * class from a React effect would mean the first frame is painted as a web page
 * and then corrected a moment later — which is the flicker those rules exist to
 * remove, arriving in a more annoying form.
 *
 * So this runs at module load, from main.jsx, before React exists.
 */
import { Capacitor } from '@capacitor/core';
import { hideSplash, paintStatusBar } from './native.js';

export function startNativeChrome() {
  if (!Capacitor.isNativePlatform()) return;

  document.body.classList.add('native');
  document.documentElement.dataset.platform = Capacitor.getPlatform();

  /*
   * The status bar is painted immediately; the splash is taken down on the next
   * frame, once React has actually put something on the screen. Hiding it any
   * earlier shows the empty WebView underneath, which is a white rectangle
   * between the splash and the app.
   */
  paintStatusBar(true);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => hideSplash());
  });
}

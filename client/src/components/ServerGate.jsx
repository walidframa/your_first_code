import { useState } from 'react';
import { needsSetup } from '../lib/server';
import Connect from '../pages/Connect';

/**
 * Nothing runs until the app knows which shop it is.
 *
 * Placed above every provider that fetches, and that placement is the point.
 * The licence, the branches, the settings and the offline queue all ask the
 * server something the moment they mount — so an app with no address would
 * have four of them failing at once, none of them able to explain why, and a
 * person looking at a broken screen on the first run of a fresh install.
 *
 * On the web this renders its children and is never seen again: the app is
 * served by the shop, so the address is known before any of this exists.
 */
export default function ServerGate({ children }) {
  const [ready, setReady] = useState(() => !needsSetup());
  if (ready) return children;
  return <Connect onConnected={() => setReady(true)} />;
}

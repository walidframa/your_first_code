import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import './index.css';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ToastProvider } from './components/ui';
import { ConfirmProvider } from './components/ConfirmProvider';
import { SettingsProvider } from './context/SettingsContext.jsx';
import { BranchProvider } from './context/BranchContext.jsx';
import { OfflineProvider } from './context/OfflineContext.jsx';
import { applyTextSize } from './lib/textSize.js';
import { applyTheme, watchSystemTheme } from './lib/theme.js';
import { applyLanguage } from './lib/i18n.js';
import { LanguageProvider } from './context/LanguageContext.jsx';
import { watchForInstall } from './lib/install.js';
import { startUpdateWatch } from './lib/appUpdate';
import { LicenceProvider, useLicence } from './context/LicenceContext.jsx';
import { SupportProvider } from './context/SupportContext.jsx';
import Locked from './pages/Locked.jsx';
import ServerGate from './components/ServerGate.jsx';
import { startNativeChrome } from './lib/nativeBoot.js';

/** The whole app, or the one screen that explains why there isn't one. */
function LicenceGate({ children }) {
  const { locked } = useLicence();
  return locked ? <Locked /> : children;
}

/*
 * Before the first render, so a screen set to large text never flashes the
 * default size on the way in.
 */
applyTextSize();
/* And the language, for the same reason: an Arabic till must not flash an
   English page laid out backwards on its way in. */
applyLanguage();
/* And the theme, most of all: a white flash on the way into a dark till at
   night is exactly what makes somebody turn a dark mode back off. */
applyTheme();
watchSystemTheme();

/* The browser offers to install the app once, whenever it decides to, and
   throws the offer away if nobody is listening — so listen before anything
   else runs. */
watchForInstall();

/*
 * Mark the document as the app rather than a page, before the first paint.
 *
 * A dozen CSS rules hang off `body.native` — the tap highlight, the selection
 * bubble, the rubber-band bounce, the safe areas. Doing this in an effect would
 * mean the first frame is drawn as a web page and then corrected, which is
 * exactly the flicker those rules exist to remove.
 */
startNativeChrome();

/*
 * The worker that keeps the till on screen when the server is not there.
 *
 * Only in a built app: in development the page comes from Vite, and a worker
 * caching those assets would serve yesterday's code after every edit.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  // Registered, and then watched: a new version installs and waits, and the
  // counter is offered the reload rather than having one done to it. See
  // lib/appUpdate.js.
  globalThis.addEventListener('load', startUpdateWatch);
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <LanguageProvider>
        <ToastProvider>
          <ConfirmProvider>
        {/* Above everything that fetches. In the phone app the shop's address
            is a thing somebody has to type before any of this can work; on the
            web it is known already and this renders straight through. */}
        <ServerGate>
        <AuthProvider>
          {/* Above the providers that fetch the shop's own data, and below the
              one that knows who is signed in: a stopped till answers 402 to all
              of those, and there is no point in four of them discovering that
              separately when one screen already explains it. Signing in still
              works, because taking a copy of the records needs it. */}
          <LicenceProvider>
            <LicenceGate>
              <BranchProvider>
                <SettingsProvider>
                  <OfflineProvider>
                    {/* Innermost, and reading the token above it: the bar it
                        feeds is drawn inside the app shell, and there is
                        nothing to tell a signed-out screen. */}
                    <SupportProvider>
                      <App />
                    </SupportProvider>
                  </OfflineProvider>
                </SettingsProvider>
              </BranchProvider>
            </LicenceGate>
          </LicenceProvider>
        </AuthProvider>
        </ServerGate>
          </ConfirmProvider>
        </ToastProvider>
      </LanguageProvider>
    </BrowserRouter>
  </StrictMode>,
);

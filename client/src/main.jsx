import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import './index.css';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ToastProvider } from './components/ui';
import { SettingsProvider } from './context/SettingsContext.jsx';
import { BranchProvider } from './context/BranchContext.jsx';
import { OfflineProvider } from './context/OfflineContext.jsx';
import { applyTextSize } from './lib/textSize.js';
import { applyLanguage } from './lib/i18n.js';
import { LanguageProvider } from './context/LanguageContext.jsx';

/*
 * Before the first render, so a screen set to large text never flashes the
 * default size on the way in.
 */
applyTextSize();
/* And the language, for the same reason: an Arabic till must not flash an
   English page laid out backwards on its way in. */
applyLanguage();

/*
 * The worker that keeps the till on screen when the server is not there.
 *
 * Only in a built app: in development the page comes from Vite, and a worker
 * caching those assets would serve yesterday's code after every edit.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  globalThis.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // A till without it still sells; it just cannot survive the server going.
    });
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <LanguageProvider>
        <ToastProvider>
        <AuthProvider>
          <BranchProvider>
            <SettingsProvider>
              <OfflineProvider>
                <App />
              </OfflineProvider>
            </SettingsProvider>
          </BranchProvider>
        </AuthProvider>
        </ToastProvider>
      </LanguageProvider>
    </BrowserRouter>
  </StrictMode>,
);

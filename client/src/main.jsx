import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import './index.css';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ToastProvider } from './components/ui';
import { SettingsProvider } from './context/SettingsContext.jsx';
import { BranchProvider } from './context/BranchContext.jsx';
import { applyTextSize } from './lib/textSize.js';

/*
 * Before the first render, so a screen set to large text never flashes the
 * default size on the way in.
 */
applyTextSize();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <BranchProvider>
            <SettingsProvider>
              <App />
            </SettingsProvider>
          </BranchProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api from '../api';
import { useAuth } from './AuthContext';

const SettingsContext = createContext(null);

/**
 * Store settings, including the live USD→LBP rate. Loaded once the user is
 * signed in, and refreshable so the register picks up a rate change without a
 * full reload.
 */
export function SettingsProvider({ children }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState(null);

  const refresh = useCallback(async () => {
    const res = await api.get('/settings');
    setSettings(res.data.settings);
    return res.data.settings;
  }, []);

  useEffect(() => {
    if (!user) {
      setSettings(null);
      return;
    }
    refresh().catch(() => setSettings(null));
  }, [user, refresh]);

  const value = useMemo(() => {
    const rate = settings?.exchange_rate ?? 0;
    const step = settings?.lbp_rounding ?? 1000;
    /*
     * The shop's tax, as a fraction, in one place.
     *
     * It used to be `* 0.08` written into whichever screen needed it, which is
     * how the documents dialog ended up quietly charging eight per cent after
     * the shop had turned tax off — and then sending the server a payment
     * bigger than the total it had worked out.
     */
    const taxOn = String(settings?.tax_enabled) === 'true';
    const taxPercent = Number(settings?.tax_percent) || 0;
    const taxRate = taxOn && taxPercent > 0 ? Math.min(taxPercent, 100) / 100 : 0;

    return {
      settings,
      refresh,
      rate,
      step,
      taxRate,
      taxName: settings?.tax_name || 'Tax',
      /** Convert a USD amount to LBP, rounded to the display step. */
      toLbp: (usd) => {
        if (!rate) return 0;
        const raw = (Number(usd) || 0) * rate;
        return step > 1 ? Math.round(raw / step) * step : Math.round(raw);
      },
      /** Convert an LBP amount to its USD equivalent. */
      toUsd: (lbp) => (rate ? Math.round(((Number(lbp) || 0) / rate) * 100) / 100 : 0),
    };
  }, [settings, refresh]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}

/** Format an LBP amount with thousands separators — they get long. */
export function lbp(amount) {
  return `${Math.round(Number(amount) || 0).toLocaleString('en-US')} LL`;
}

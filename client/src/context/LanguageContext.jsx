import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { LANGUAGES, applyLanguage, directionOf, getLanguage, translate } from '../lib/i18n';

const LanguageContext = createContext(null);

/**
 * Which language the shop is working in.
 *
 * Kept on the device rather than against the account: a shop where the owner
 * reads English and the cashier reads Arabic wants the back office in one and
 * the till in the other, and both are the same login.
 */
export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(getLanguage);

  const choose = useCallback((next) => {
    setLanguage(applyLanguage(next));
  }, []);

  const value = useMemo(
    () => ({
      language,
      choose,
      languages: LANGUAGES,
      dir: directionOf(language),
      rtl: directionOf(language) === 'rtl',
      t: (text, vars) => translate(language, text, vars),
    }),
    [language, choose],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within LanguageProvider');
  return ctx;
}

/** The common case: just the words. */
export function useT() {
  return useLanguage().t;
}

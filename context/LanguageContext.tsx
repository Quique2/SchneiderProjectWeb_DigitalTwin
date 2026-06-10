import React, { createContext, useCallback, useContext, useState } from 'react';
import translations, { Lang } from '../translations';

export type { Lang };

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (path: string) => string;
  ta: (path: string) => string[];
}

const DEFAULT_CTX: LangCtx = {
  lang: 'es', setLang: () => {},
  t: (p) => p, ta: () => [],
};

const Ctx = createContext<LangCtx>(DEFAULT_CTX);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPath(obj: any, path: string): any {
  return path.split('.').reduce((o: any, k: string) => o?.[k], obj);
}

function readStoredLang(): Lang {
  try { return (localStorage.getItem('lang') as Lang) || 'es'; } catch { return 'es'; }
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem('lang', l); } catch { /* ignore */ }
  }, []);

  const t = useCallback((path: string): string => {
    const val = getPath(translations[lang], path) ?? getPath(translations['es'], path);
    return typeof val === 'string' ? val : path;
  }, [lang]);

  const ta = useCallback((path: string): string[] => {
    const val = getPath(translations[lang], path) ?? getPath(translations['es'], path);
    return Array.isArray(val) ? val : [];
  }, [lang]);

  return (
    <Ctx.Provider value={{ lang, setLang, t, ta }}>
      {children}
    </Ctx.Provider>
  );
}

export function useLanguage(): LangCtx {
  return useContext(Ctx);
}

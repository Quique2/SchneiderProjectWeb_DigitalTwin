// ─────────────────────────────────────────────────────────────────────────────
// useScadaTheme.ts — Hook React del tema SCADA (compartido real + SIM).
// Se suscribe al store de módulo; re-renderiza al cambiar el modo en cualquier SCADA.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import {
  getThemeMode, setThemeMode, toggleThemeMode, subscribeTheme, tokensFor,
  type ScadaThemeMode, type ScadaTokens,
} from './scadaTheme';

export interface UseScadaTheme {
  theme: ScadaThemeMode;
  tokens: ScadaTokens;
  setTheme: (m: ScadaThemeMode) => void;
  toggleTheme: () => void;
}

export function useScadaTheme(): UseScadaTheme {
  const [theme, setThemeState] = useState<ScadaThemeMode>(getThemeMode);
  useEffect(() => subscribeTheme(() => setThemeState(getThemeMode())), []);
  return {
    theme,
    tokens: tokensFor(theme),
    setTheme: setThemeMode,
    toggleTheme: toggleThemeMode,
  };
}

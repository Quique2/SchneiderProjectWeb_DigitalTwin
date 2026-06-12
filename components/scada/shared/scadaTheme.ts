// ─────────────────────────────────────────────────────────────────────────────
// scadaTheme.ts — Tema compartido (light/dark) para SCADA real y SCADA SIM.
//
// SOLO visual: no toca telemetría, señales, FSM ni Node-RED. La preferencia se
// guarda en localStorage (`schneider_scada_theme`) y se comparte entre ambos SCADA
// mediante un store de módulo con suscripción (cambiar el tema en uno lo refleja en
// el otro sin recargar). Si no hay preferencia, usa prefers-color-scheme; default dark.
// ─────────────────────────────────────────────────────────────────────────────

import type React from 'react';

export type ScadaThemeMode = 'light' | 'dark';

export interface ScadaTokens {
  mode: ScadaThemeMode;
  // estructural
  bg: string; surface: string; surfaceSoft: string;
  border: string; borderSoft: string;
  text: string; muted: string; dim: string;
  // semántico
  accent: string; success: string; warning: string; danger: string;
  sim: string; nodeRed: string; info: string; alarm: string; critical: string;
  ledOff: string; shadow: string;
  // botones
  btnBg: string; btnText: string; btnBorder: string; ghostActive: string;
}

export const DARK_TOKENS: ScadaTokens = {
  mode: 'dark',
  bg: '#07111e', surface: '#0d1b2c', surfaceSoft: '#0a1626',
  border: 'rgba(148,163,184,0.18)', borderSoft: 'rgba(148,163,184,0.10)',
  text: '#e6eef7', muted: '#8aa0b8', dim: '#5a6f86',
  accent: '#38bdf8', success: '#3DCD58', warning: '#E0A82E', danger: '#ef4444',
  sim: '#22d3ee', nodeRed: '#a06bd4', info: '#38bdf8', alarm: '#FB7185', critical: '#ef4444',
  ledOff: '#3a4a5f', shadow: '0 6px 22px rgba(0,0,0,0.40)',
  btnBg: '#10324a', btnText: '#dbeafe', btnBorder: 'rgba(56,189,248,0.45)', ghostActive: '#13283c',
};

export const LIGHT_TOKENS: ScadaTokens = {
  mode: 'light',
  bg: '#eef2f8', surface: '#ffffff', surfaceSoft: '#f6f9fd',
  border: '#d9e2ef', borderSoft: '#e7edf5',
  text: '#0f172a', muted: '#56697f', dim: '#8b9bb0',
  accent: '#2563eb', success: '#16a34a', warning: '#ca8a04', danger: '#dc2626',
  sim: '#0891b2', nodeRed: '#7c3aed', info: '#2563eb', alarm: '#e11d48', critical: '#dc2626',
  ledOff: '#c2cddd', shadow: '0 6px 20px rgba(15,23,42,0.08)',
  btnBg: '#e8f1fb', btnText: '#1e4e7a', btnBorder: '#bcd6ef', ghostActive: '#e3ecf7',
};

export function tokensFor(mode: ScadaThemeMode): ScadaTokens {
  return mode === 'light' ? LIGHT_TOKENS : DARK_TOKENS;
}

// Variables CSS (subconjunto estructural) para inyectar en el root del SCADA real.
// Permite re-themear su paleta `C` sin tocar cada componente (los hijos heredan).
export function cssVars(t: ScadaTokens): React.CSSProperties {
  return {
    '--sc-bg': t.bg,
    '--sc-surface': t.surface,
    '--sc-surface-soft': t.surfaceSoft,
    '--sc-border': t.border,
    '--sc-border-soft': t.borderSoft,
    '--sc-text': t.text,
    '--sc-muted': t.muted,
    '--sc-dim': t.dim,
    '--sc-btn-bg': t.btnBg,
    '--sc-btn-text': t.btnText,
    '--sc-btn-border': t.btnBorder,
    '--sc-ghost-active': t.ghostActive,
  } as React.CSSProperties;
}

// ── Store de módulo (compartido entre SCADA real y SCADA SIM) ─────────────────
const LS_KEY = 'schneider_scada_theme';

function readInitial(): ScadaThemeMode {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(LS_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    }
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
  } catch { /* sin storage / SSR */ }
  return 'dark';
}

let currentMode: ScadaThemeMode = readInitial();
const subscribers = new Set<() => void>();

export function getThemeMode(): ScadaThemeMode { return currentMode; }

export function setThemeMode(mode: ScadaThemeMode): void {
  if (mode === currentMode) return;
  currentMode = mode;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, mode); } catch { /* noop */ }
  subscribers.forEach((fn) => fn());
}

export function toggleThemeMode(): void { setThemeMode(currentMode === 'dark' ? 'light' : 'dark'); }

export function subscribeTheme(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

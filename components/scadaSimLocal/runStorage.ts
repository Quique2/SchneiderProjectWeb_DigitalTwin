// ─────────────────────────────────────────────────────────────────────────────
// runStorage.ts — Persistencia local de corridas con interfaz lista para DB.
//
// RunStorageAdapter es el contrato; LocalRunStorageAdapter lo implementa con
// localStorage + sessionStorage. En el futuro, un DatabaseRunStorageAdapter con
// el MISMO contrato reemplaza la implementación sin tocar el resto del SCADA SIM.
//
// Claves:
//   scadaSim.currentRun     (localStorage)  — corrida en curso (sobrevive reload)
//   scadaSim.runHistory     (localStorage)  — historial de corridas terminadas
//   scadaSim.sessionCounter (sessionStorage)— contador por pestaña/sesión
// ─────────────────────────────────────────────────────────────────────────────

import type { RunModel } from './runTypes';

export interface RunStorageAdapter {
  /** Guarda/actualiza la corrida en curso. */
  updateCurrentRun(run: RunModel): void;
  /** Lee la corrida en curso (si la hubo). */
  getCurrentRun(): RunModel | null;
  /** Limpia la corrida en curso (al terminar/abortar y archivar). */
  clearCurrentRun(): void;
  /** Archiva una corrida terminada en el historial. */
  saveRun(run: RunModel): void;
  /** Historial de corridas (más reciente primero). */
  getRunHistory(): RunModel[];
  /** Siguiente número de corrida para la sesión (1, 2, 3…). */
  allocRunNumber(): number;
  /** Número actual sin incrementar. */
  peekRunNumber(): number;
}

const K_CURRENT = 'scadaSim.currentRun';
const K_HISTORY = 'scadaSim.runHistory';
const K_SESSION = 'scadaSim.sessionCounter';
const HISTORY_MAX = 50; // límite simple para no llenar localStorage

function lsGet(k: string): string | null {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null; } catch { return null; }
}
function lsSet(k: string, v: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch { /* quota/SSR */ }
}
function lsDel(k: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); } catch { /* SSR */ }
}
function ssGet(k: string): string | null {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(k) : null; } catch { return null; }
}
function ssSet(k: string, v: string): void {
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(k, v); } catch { /* SSR */ }
}

export class LocalRunStorageAdapter implements RunStorageAdapter {
  updateCurrentRun(run: RunModel): void {
    lsSet(K_CURRENT, JSON.stringify(run));
  }

  getCurrentRun(): RunModel | null {
    const raw = lsGet(K_CURRENT);
    if (!raw) return null;
    try { return JSON.parse(raw) as RunModel; } catch { return null; }
  }

  clearCurrentRun(): void {
    lsDel(K_CURRENT);
  }

  saveRun(run: RunModel): void {
    const hist = this.getRunHistory();
    const filtered = hist.filter((r) => r.id !== run.id); // evitar duplicado
    filtered.unshift(run);
    lsSet(K_HISTORY, JSON.stringify(filtered.slice(0, HISTORY_MAX)));
  }

  getRunHistory(): RunModel[] {
    const raw = lsGet(K_HISTORY);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? (arr as RunModel[]) : [];
    } catch { return []; }
  }

  allocRunNumber(): number {
    const cur = this.peekRunNumber();
    const next = cur + 1;
    ssSet(K_SESSION, String(next));
    return next;
  }

  peekRunNumber(): number {
    const raw = ssGet(K_SESSION);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// signals.ts — Helpers para leer señales del ScadaSnapshot (lectura, no muta nada).
// Las claves son las canónicas de la matriz (I_*/O_*); si no existe o es null → null.
// ─────────────────────────────────────────────────────────────────────────────

import type { ScadaSnapshot } from '../scadaTypes';

// Lee una señal booleana de la matriz io por su key canónica (I_*/O_*).
export function ioBool(s: ScadaSnapshot, key: string): boolean | null {
  const sig = s.io.find((x) => x.key === key);
  if (!sig) return null;
  return typeof sig.value === 'boolean' ? sig.value : null;
}

export function on(v: boolean | null): boolean { return v === true; }

// Estadística básica para baselines / tendencias.
export function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
// z-score del último valor respecto a la serie previa.
export function zScore(series: number[]): { z: number; value: number; baseline: number; sigma: number } | null {
  if (series.length < 2) return null;
  const value = series[series.length - 1];
  const prev = series.slice(0, -1);
  const m = mean(prev);
  const sg = std(prev);
  if (sg === 0) return { z: 0, value, baseline: m, sigma: 0 };
  return { z: (value - m) / sg, value, baseline: m, sigma: sg };
}
// Pendiente (tendencia) por mínimos cuadrados sobre [{t,v}]; >0 sube, <0 baja.
export function slope(points: { t: number; v: number }[]): number | null {
  if (points.length < 3) return null;
  const n = points.length;
  const sx = points.reduce((a, p) => a + p.t, 0);
  const sy = points.reduce((a, p) => a + p.v, 0);
  const sxy = points.reduce((a, p) => a + p.t * p.v, 0);
  const sxx = points.reduce((a, p) => a + p.t * p.t, 0);
  const d = n * sxx - sx * sx;
  if (d === 0) return null;
  return (n * sxy - sx * sy) / d;
}
export function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
export function round1(n: number): number { return Math.round(n * 10) / 10; }

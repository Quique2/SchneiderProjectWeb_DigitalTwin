// ─────────────────────────────────────────────────────────────────────────────
// predictive.ts — Pilar 2 (Mechanic): mantenimiento predictivo.
// Heurística PURA sobre lo que el SCADA ya mide/guarda (REAL-ONLY): contador de
// ciclos, RUL, tendencia de carga, vibración (proxy) y estabilidad de ciclo.
// No inventa: si falta el dato → null. No toca FSM ni telemetría.
// ─────────────────────────────────────────────────────────────────────────────

import type { ScadaSnapshot } from '../scadaTypes';
import { SCADA_AI_CONFIG as K } from '../scadaConfig';
import { mean, std, slope, clamp, round1 } from './signals';
import type { ScadaLang } from '../scadaI18n';
import { tscAi } from '../scadaAiI18n';

export type PillarStatus = 'OK' | 'WARNING' | 'NO_PASS' | 'UNKNOWN';

export interface PredictiveSnap {
  available: boolean;
  rivetCycleCount: number | null;
  rulPct: number | null;
  rulCyclesLeft: number | null;
  motorLoadTrend: 'STABLE' | 'RISING' | 'FALLING' | null;
  vibrationProxy: number | null;      // σ de corrientes de joints (A)
  cycleStability: 'STABLE' | 'DEGRADING' | null;
  cycleCv: number | null;             // coef. de variación de cycleTimes
  status: PillarStatus;
  forecastMsg: string;
}

export function derivePredictive(s: ScadaSnapshot, lang: ScadaLang = 'es'): PredictiveSnap {
  // Contador de ciclos de remachado (de producción real, o accepted+rejected).
  const count = s.production.available && s.production.total !== null
    ? s.production.total
    : (s.production.accepted ?? 0) + (s.production.rejected ?? 0) || null;

  // RUL = vida nominal − ciclos / vida nominal.
  const life = K.rivetActuatorLifeCycles;
  const rulPct = count !== null ? round1(clamp(((life - count) / life) * 100, 0, 100)) : null;
  const rulCyclesLeft = count !== null ? Math.max(0, life - count) : null;

  // Tendencia de carga: pendiente de la temperatura del controlador (proxy de carga).
  let motorLoadTrend: PredictiveSnap['motorLoadTrend'] = null;
  const sl = slope(s.history.controllerTemps);
  if (sl !== null) motorLoadTrend = sl > 0.02 ? 'RISING' : sl < -0.02 ? 'FALLING' : 'STABLE';

  // Vibración (proxy): dispersión de las corrientes de los joints AHORA.
  let vibrationProxy: number | null = null;
  if (s.cobot.available && s.cobot.joints.length >= 2) {
    vibrationProxy = round1(std(s.cobot.joints.map((j) => j.currentA)) * 100) / 100;
  }

  // Estabilidad del ciclo: coef. de variación de los últimos tiempos de ciclo.
  let cycleStability: PredictiveSnap['cycleStability'] = null;
  let cycleCv: number | null = null;
  const ct = s.history.cycleTimes;
  if (ct.length >= 3) {
    const m = mean(ct);
    cycleCv = m > 0 ? round1((std(ct) / m) * 1000) / 1000 : 0;
    cycleStability = cycleCv > K.cycleCvWarn ? 'DEGRADING' : 'STABLE';
  }

  // Estado agregado.
  let status: PillarStatus = 'OK';
  const reasons: string[] = [];
  if (rulPct === null && vibrationProxy === null && cycleCv === null) status = 'UNKNOWN';
  if (rulPct !== null && rulPct < K.rulCriticalPct) { status = 'NO_PASS'; reasons.push(`RUL ${rulPct}% (${tscAi(lang, 'wordCritical')})`); }
  else if (rulPct !== null && rulPct < K.rulWarnPct) { status = worse(status, 'WARNING'); reasons.push(`RUL ${rulPct}%`); }
  if (vibrationProxy !== null && vibrationProxy > K.vibrationCritical) { status = 'NO_PASS'; reasons.push(`${tscAi(lang, 'wordVibration')} ${vibrationProxy}A`); }
  else if (vibrationProxy !== null && vibrationProxy > K.vibrationWarn) { status = worse(status, 'WARNING'); reasons.push(`${tscAi(lang, 'wordVibration')} ${vibrationProxy}A`); }
  if (cycleStability === 'DEGRADING') { status = worse(status, 'WARNING'); reasons.push(tscAi(lang, 'forecastCycleUnstable')); }

  const available = status !== 'UNKNOWN';
  const forecastMsg = !available
    ? tscAi(lang, 'forecastUnknown')
    : status === 'OK'
      ? tscAi(lang, 'forecastNominal')
          .replace('{rul}', String(rulPct ?? '—'))
          .replace('{vib}', String(vibrationProxy ?? '—'))
          .replace('{cs}', String(cycleStability ?? '—'))
      : `${status === 'NO_PASS' ? tscAi(lang, 'forecastFault') : tscAi(lang, 'forecastAttention')}: ${reasons.join(' · ')}.`;

  return { available, rivetCycleCount: count, rulPct, rulCyclesLeft, motorLoadTrend, vibrationProxy, cycleStability, cycleCv, status, forecastMsg };
}

function worse(a: PillarStatus, b: PillarStatus): PillarStatus {
  const r = (x: PillarStatus) => (x === 'NO_PASS' ? 3 : x === 'WARNING' ? 2 : x === 'OK' ? 1 : 0);
  return r(b) > r(a) ? b : a;
}

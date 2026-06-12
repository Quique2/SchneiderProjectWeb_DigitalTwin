// ─────────────────────────────────────────────────────────────────────────────
// optimization.ts — Pilar 3 (Optimizer): optimización de proceso.
// Deriva KPIs (cycle time, throughput, energía proxy) y recomienda setpoints
// (velocidad cobot, timing remachado/inspección) desde señales reales. REAL-ONLY:
// RECOMIENDA, no aplica. No toca FSM/tiempos/telemetría.
// ─────────────────────────────────────────────────────────────────────────────

import type { ScadaSnapshot } from '../scadaTypes';
import { SCADA_AI_CONFIG as K } from '../scadaConfig';
import { mean, std, clamp, round1 } from './signals';

export interface OptimizationSnap {
  available: boolean;
  cycleTimeS: number | null;
  throughputPerHr: number | null;
  idleTimePct: number | null;
  energyPerCycleWh: number | null;
  currentSpeedPct: number | null;
  setpoints: { cobotSpeedPct: number; rivetingDelayS: number; inspectionTimingS: number };
  rationale: string[];
}

export function deriveOptimization(s: ScadaSnapshot): OptimizationSnap {
  const ct = s.history.cycleTimes;
  const cycleTimeS = s.overview.avgCycleTimeS ?? s.overview.cycleTimeS ?? (ct.length ? round1(mean(ct)) : null);
  const throughputPerHr = cycleTimeS && cycleTimeS > 0 ? round1(3600 / cycleTimeS) : null;

  // Idle aproximado: parte del ciclo que NO es trabajo "útil" (remachado 30s + inspección 5s).
  const useful = K.rivetingDelayS + K.inspectionTimingS;
  const idleTimePct = cycleTimeS && cycleTimeS > useful ? round1(clamp((1 - useful / cycleTimeS) * 100, 0, 100)) : null;

  // Energía por ciclo (proxy): potencia media del cobot × duración del ciclo.
  const avgW = s.cobot.available ? s.cobot.avgPowerW : null;
  const energyPerCycleWh = avgW !== null && cycleTimeS !== null ? round1((avgW * cycleTimeS) / 3600 * 10) / 10 : null;

  const currentSpeedPct = s.cobot.available ? s.cobot.speedMagnificationPct : null;

  // Setpoint recomendado de velocidad: parte del objetivo y ajusta por estabilidad.
  let recoSpeed: number = K.targetCobotSpeedPct;
  const rationale: string[] = [];
  const cv = ct.length >= 3 && mean(ct) > 0 ? std(ct) / mean(ct) : null;
  if (cv !== null && cv > K.cycleCvWarn) { recoSpeed = clamp(recoSpeed - 10, 50, 100); rationale.push('Ciclo inestable → bajar velocidad para repetibilidad.'); }
  if (s.cobot.available && s.cobot.maxJointTempC !== null && s.cobot.maxJointTempC > 55) { recoSpeed = clamp(recoSpeed - 10, 50, 100); rationale.push(`Joint caliente (${s.cobot.maxJointTempC}°C) → reducir carga/velocidad.`); }
  if (currentSpeedPct !== null && currentSpeedPct < recoSpeed && cv !== null && cv <= K.cycleCvWarn) { rationale.push(`Velocidad actual ${currentSpeedPct}% < objetivo → margen para subir throughput.`); }
  if (idleTimePct !== null && idleTimePct > 35) rationale.push(`Idle ${idleTimePct}% del ciclo → reducir esperas entre tareas.`);
  if (!rationale.length) rationale.push('Parámetros dentro de rango; mantener setpoints nominales.');

  const available = cycleTimeS !== null || currentSpeedPct !== null;

  return {
    available,
    cycleTimeS, throughputPerHr, idleTimePct, energyPerCycleWh, currentSpeedPct,
    setpoints: { cobotSpeedPct: recoSpeed, rivetingDelayS: K.rivetingDelayS, inspectionTimingS: K.inspectionTimingS },
    rationale,
  };
}

// pillars.ts — Agrega los 5 pilares + PASS/NO PASS desde un ScadaSnapshot (1 llamada).
import type { ScadaSnapshot } from '../scadaTypes';
import { derivePredictive, type PredictiveSnap } from './predictive';
import { deriveOptimization, type OptimizationSnap } from './optimization';
import { deriveAnomaly, groupAlarms, type AnomalySnap, type AlarmGroup } from './anomaly';
import { deriveAiStatus, type PassNoPass } from './passNoPass';
import { sopFor, type SopGuidance } from './sop';

export interface Pillars {
  status: PassNoPass;
  sop: SopGuidance;
  predictive: PredictiveSnap;
  optimization: OptimizationSnap;
  anomaly: AnomalySnap;
  alarmGroups: AlarmGroup[];
}

export function derivePillars(s: ScadaSnapshot): Pillars {
  const predictive = derivePredictive(s);
  const anomaly = deriveAnomaly(s);
  const optimization = deriveOptimization(s);
  const status = deriveAiStatus(s, anomaly, predictive);
  const sop = sopFor(s, status);
  const alarmGroups = groupAlarms(s.alarms);
  return { status, sop, predictive, optimization, anomaly, alarmGroups };
}

// pillars.ts — Agrega los 5 pilares + PASS/NO PASS desde un ScadaSnapshot (1 llamada).
import type { ScadaSnapshot } from '../scadaTypes';
import { derivePredictive, type PredictiveSnap } from './predictive';
import { deriveOptimization, type OptimizationSnap } from './optimization';
import { deriveAnomaly, groupAlarms, type AnomalySnap, type AlarmGroup } from './anomaly';
import { deriveAiStatus, type PassNoPass } from './passNoPass';
import { sopFor, type SopGuidance } from './sop';
import type { ScadaLang } from '../scadaI18n';

export interface Pillars {
  status: PassNoPass;
  sop: SopGuidance;
  predictive: PredictiveSnap;
  optimization: OptimizationSnap;
  anomaly: AnomalySnap;
  alarmGroups: AlarmGroup[];
}

export function derivePillars(s: ScadaSnapshot, lang: ScadaLang = 'es'): Pillars {
  const predictive = derivePredictive(s, lang);
  const anomaly = deriveAnomaly(s, lang);
  const optimization = deriveOptimization(s, lang);
  const status = deriveAiStatus(s, anomaly, predictive, lang);
  const sop = sopFor(s, status, lang);
  const alarmGroups = groupAlarms(s.alarms);
  return { status, sop, predictive, optimization, anomaly, alarmGroups };
}

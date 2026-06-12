// ─────────────────────────────────────────────────────────────────────────────
// anomaly.ts — Pilar 1+5 (Watchman): detección de anomalías por baseline + agrupación
// de alarmas + indicadores de seguridad/trayectoria. REAL-ONLY, sobre el historial
// que el SCADA ya guarda. No toca el motor de alarmas (solo capa de presentación).
// ─────────────────────────────────────────────────────────────────────────────

import type { ScadaSnapshot, Alarm } from '../scadaTypes';
import { SCADA_AI_CONFIG as K } from '../scadaConfig';
import { zScore, round1 } from './signals';
import type { PillarStatus } from './predictive';

export interface AnomalyItem {
  metric: string;
  z: number;
  value: number;
  baseline: number;
  severity: 'WARNING' | 'CRITICAL';
}
export interface SecurityFlags {
  estop: boolean; protectiveStop: boolean; collision: boolean; motionError: boolean;
  trajectory: 'NOMINAL' | 'STOPPED' | 'ERROR' | 'UNKNOWN';
  obstacle: boolean | null;
}
export interface AnomalySnap {
  baselineReady: boolean;
  anomalies: AnomalyItem[];
  security: SecurityFlags;
  status: PillarStatus;
  summary: string;
}

export function deriveAnomaly(s: ScadaSnapshot): AnomalySnap {
  const anomalies: AnomalyItem[] = [];

  const check = (metric: string, series: number[]) => {
    if (series.length < K.baselineMinSamples) return;
    const z = zScore(series);
    if (!z || z.sigma === 0) return;
    const az = Math.abs(z.z);
    if (az > K.anomalyZWarn) {
      anomalies.push({
        metric, z: round1(z.z), value: round1(z.value), baseline: round1(z.baseline),
        severity: az > K.anomalyZCritical ? 'CRITICAL' : 'WARNING',
      });
    }
  };

  // Baselines sobre el historial existente.
  check('Tiempo de ciclo', s.history.cycleTimes);
  check('Temp. controlador', s.history.controllerTemps.map((p) => p.v));
  check('Duración conveyor', s.history.conveyorOnDurations);
  // Temperatura máx de joints a lo largo del tiempo (proxy de movimiento anómalo).
  const maxJointSeries = s.history.jointTemps.map((p) => Math.max(...p.temps));
  check('Temp. máx joint', maxJointSeries);

  // Seguridad / trayectoria del cobot.
  const f = s.cobot.flags;
  const security: SecurityFlags = {
    estop: !!f.estop, protectiveStop: !!f.protectiveStop, collision: !!f.collision, motionError: (f.motionErr ?? 0) !== 0,
    trajectory: !s.cobot.available ? 'UNKNOWN'
      : (f.estop || f.protectiveStop) ? 'STOPPED'
      : ((f.motionErr ?? 0) !== 0 || f.collision) ? 'ERROR' : 'NOMINAL',
    obstacle: s.cobot.available ? !!f.collision : null,
  };

  const baselineReady = s.history.cycleTimes.length >= K.baselineMinSamples;
  let status: PillarStatus = 'OK';
  if (security.estop || security.protectiveStop || security.collision || security.motionError) status = 'NO_PASS';
  else if (anomalies.some((a) => a.severity === 'CRITICAL')) status = 'NO_PASS';
  else if (anomalies.length) status = 'WARNING';
  else if (!baselineReady && !s.cobot.available) status = 'UNKNOWN';

  const summary = status === 'NO_PASS'
    ? (security.collision ? 'Colisión/obstáculo detectado.' : security.estop ? 'E-stop activo.' : security.protectiveStop ? 'Paro protectivo activo.' : 'Anomalía severa detectada.')
    : status === 'WARNING'
      ? `Comportamiento anómalo: ${anomalies.map((a) => a.metric).join(', ')}.`
      : status === 'UNKNOWN'
        ? 'Estableciendo baseline (faltan muestras / cobot no conectado).'
        : 'Comportamiento dentro del baseline.';

  return { baselineReady, anomalies, security, status, summary };
}

// ── Agrupación de alarmas / root-cause (capa de presentación; NO toca el motor) ──
export interface AlarmGroup {
  station: string;
  count: number;
  worst: Alarm;          // alarma representativa (peor severidad)
  alarms: Alarm[];
}
export function groupAlarms(alarms: Alarm[]): AlarmGroup[] {
  const active = alarms.filter((a) => a.active);
  const byStation = new Map<string, Alarm[]>();
  active.forEach((a) => {
    const arr = byStation.get(a.station) ?? [];
    arr.push(a);
    byStation.set(a.station, arr);
  });
  const rank = (s: Alarm['severity']) => (s === 'CRITICAL' ? 3 : s === 'ALARM' ? 2 : s === 'WARNING' ? 1 : 0);
  const groups: AlarmGroup[] = [];
  byStation.forEach((arr, station) => {
    const sorted = [...arr].sort((a, b) => rank(b.severity) - rank(a.severity));
    groups.push({ station, count: arr.length, worst: sorted[0], alarms: sorted });
  });
  return groups.sort((a, b) => rank(b.worst.severity) - rank(a.worst.severity));
}

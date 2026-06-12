// ─────────────────────────────────────────────────────────────────────────────
// passNoPass.ts — Decisión transversal AI STATUS: PASS / NO_PASS / WARNING.
// Núcleo genérico `evaluatePass(input)` reusable por SCADA real (desde el snapshot)
// y SCADA SIM (desde el frame de Node-RED). Combina colocación + inspección +
// anomalía/seguridad + trayectoria + predictivo. REAL-ONLY; estimated=true.
// ─────────────────────────────────────────────────────────────────────────────

import type { ScadaSnapshot } from '../scadaTypes';
import { ioBool, on } from './signals';
import type { AnomalySnap } from './anomaly';
import type { PredictiveSnap, PillarStatus } from './predictive';

export type PassVerdict = 'PASS' | 'NO_PASS' | 'WARNING' | 'UNKNOWN';
export interface PassCheck { label: string; ok: boolean | null; detail?: string }
export interface PassNoPass {
  verdict: PassVerdict;
  reasons: string[];
  checks: PassCheck[];
  estimated: boolean;
}

// Entrada normalizada (cualquier fuente la puede producir).
export interface PassInput {
  camPass: boolean | null; camFail: boolean | null; camErr: boolean | null; camNoRead: boolean | null;
  fx1: boolean | null; fx2: boolean | null;
  cobotAvailable: boolean; collision: boolean; motionErr: boolean; estop: boolean; protectiveStop: boolean;
  criticalAlarm: boolean;
  anomaly?: { status: PillarStatus; summary: string };
  predictive?: { status: PillarStatus; msg: string; rulPct: number | null };
}

export function evaluatePass(i: PassInput): PassNoPass {
  const checks: PassCheck[] = [];
  const reasons: string[] = [];
  let hardFail = false, warn = false, anyData = false;

  // 1) Inspección
  let inspOk: boolean | null = null;
  if (i.camPass === true) inspOk = true;
  else if (i.camFail === true || i.camErr === true || i.camNoRead === true) inspOk = false;
  if (inspOk !== null) { anyData = true; if (!inspOk) { hardFail = true; reasons.push(i.camFail ? 'Inspección: FAIL' : i.camErr ? 'Cámara: ERROR' : 'Cámara: NO READ'); } }
  checks.push({ label: 'Inspección', ok: inspOk, detail: i.camPass ? 'PASS' : i.camFail ? 'FAIL' : i.camErr ? 'ERROR' : i.camNoRead ? 'NO_READ' : 'sin lectura' });

  // 2) Colocación CAFI
  let placeOk: boolean | null = null;
  if (i.fx1 !== null || i.fx2 !== null) {
    anyData = true;
    placeOk = !(i.collision || i.motionErr);
    if (!placeOk) { hardFail = true; reasons.push('Colocación: trayectoria/colisión anómala'); }
  }
  checks.push({ label: 'Colocación CAFI', ok: placeOk, detail: `fx1:${fmt(i.fx1)} fx2:${fmt(i.fx2)}` });

  // 3) Anomalía / seguridad
  let secOk: boolean | null = null;
  if (i.anomaly && i.anomaly.status !== 'UNKNOWN') {
    anyData = true;
    if (i.anomaly.status === 'NO_PASS') { secOk = false; hardFail = true; reasons.push(i.anomaly.summary); }
    else if (i.anomaly.status === 'WARNING') { secOk = true; warn = true; reasons.push(i.anomaly.summary); }
    else secOk = true;
  }
  checks.push({ label: 'Anomalía / Seguridad', ok: secOk, detail: i.anomaly?.summary });

  // 4) Trayectoria cobot
  let trajOk: boolean | null = null;
  if (i.cobotAvailable) {
    anyData = true;
    trajOk = !(i.collision || i.motionErr || i.estop || i.protectiveStop);
    if (!trajOk) { hardFail = true; reasons.push('Trayectoria cobot anómala / paro'); }
  }
  checks.push({ label: 'Trayectoria cobot', ok: trajOk });

  // 5) Predictivo
  let predOk: boolean | null = null;
  if (i.predictive && i.predictive.status !== 'UNKNOWN') {
    anyData = true;
    if (i.predictive.status === 'NO_PASS') { predOk = false; hardFail = true; reasons.push(i.predictive.msg); }
    else if (i.predictive.status === 'WARNING') { predOk = true; warn = true; reasons.push(i.predictive.msg); }
    else predOk = true;
  }
  checks.push({ label: 'Predictivo', ok: predOk, detail: i.predictive && i.predictive.rulPct !== null ? `RUL ${i.predictive.rulPct}%` : undefined });

  if (i.criticalAlarm) { anyData = true; hardFail = true; reasons.push('Alarma CRÍTICA activa'); }

  let verdict: PassVerdict;
  if (!anyData) verdict = 'UNKNOWN';
  else if (hardFail) verdict = 'NO_PASS';
  else if (warn) verdict = 'WARNING';
  else verdict = 'PASS';

  const finalReasons = verdict === 'PASS'
    ? ['CAFI correctamente posicionado e inspeccionado. Proceso nominal.']
    : verdict === 'UNKNOWN'
      ? ['Sin señales suficientes para evaluar (esperando telemetría).']
      : dedupe(reasons);

  return { verdict, reasons: finalReasons, checks, estimated: true };
}

// Adaptador: ScadaSnapshot → PassNoPass (SCADA real).
export function deriveAiStatus(s: ScadaSnapshot, anomaly?: AnomalySnap, predictive?: PredictiveSnap): PassNoPass {
  const f = s.cobot.flags;
  return evaluatePass({
    camPass: ioBool(s, 'I_CAMERA_PASS'), camFail: ioBool(s, 'I_CAMERA_FAIL'),
    camErr: ioBool(s, 'I_CAMERA_ERROR'), camNoRead: ioBool(s, 'I_CAMERA_NO_READ'),
    fx1: ioBool(s, 'I_FIXTURE_1_PRESENT'), fx2: ioBool(s, 'I_FIXTURE_2_PRESENT'),
    cobotAvailable: s.cobot.available,
    collision: !!f.collision, motionErr: (f.motionErr ?? 0) !== 0, estop: !!f.estop, protectiveStop: !!f.protectiveStop,
    criticalAlarm: s.alarms.some((a) => a.active && a.severity === 'CRITICAL'),
    anomaly: anomaly && anomaly.status !== 'UNKNOWN' ? { status: anomaly.status, summary: anomaly.summary } : undefined,
    predictive: predictive && predictive.status !== 'UNKNOWN' ? { status: predictive.status, msg: predictive.forecastMsg, rulPct: predictive.rulPct } : undefined,
  });
}

function fmt(v: boolean | null): string { return v === null ? 'NA' : v ? 'sí' : 'no'; }
function dedupe(xs: string[]): string[] { return [...new Set(xs)]; }

// Color semántico (la UI lo resuelve con tokens).
export function statusTone(v: PassVerdict | PillarStatus): 'success' | 'danger' | 'warning' | 'muted' {
  return v === 'PASS' || v === 'OK' ? 'success'
    : v === 'NO_PASS' ? 'danger'
    : v === 'WARNING' ? 'warning' : 'muted';
}

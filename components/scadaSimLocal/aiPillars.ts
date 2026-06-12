// ─────────────────────────────────────────────────────────────────────────────
// aiPillars.ts — Analítica operacional ("pilares de IA") derivada del RunModel.
//
// Reglas SIMPLES por contadores (sin ML, sin sensores reales): predicción/
// mantenimiento, calidad, eficiencia, operación y trazabilidad. Es 100% derivado
// de la corrida agregada, así que es determinista y testeable. Solo `import type`
// → carga limpio bajo type-stripping de Node en los scripts de validación.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  RunModel, RunExport, AiPillars, MaintRisk, WornComponent, Bottleneck,
} from './runTypes';
import type { ScadaLanguage } from './i18n';

function csvSectionHeader(name: 'ai', language: ScadaLanguage): string {
  return language === 'es' ? '# PILARES_IA' : '# AI_PILLARS';
}

const RECOMMENDATION_EN: [string, string][] = [
  ['Revisar gripper / mordazas / presion de aire.', 'Inspect gripper, jaws and air pressure.'],
  ['Revisar gripper / mordazas / presión de aire.', 'Inspect gripper, jaws and air pressure.'],
  ['Revisar mesa, NEMA, correa y limit switches.', 'Inspect table, NEMA motor, belt and limit switches.'],
  ['Revisar motor del conveyor (tiempo ON alto).', 'Inspect conveyor motor (high ON time).'],
  ['Revisar iluminacion / camara / fixture (FAIL alto).', 'Inspect lighting, camera and fixture (high FAIL rate).'],
  ['Revisar iluminación / cámara / fixture (FAIL alto).', 'Inspect lighting, camera and fixture (high FAIL rate).'],
  ['Revisar actuador de remachado (ciclos altos).', 'Inspect rivet actuator (high cycle count).'],
  ['Activaciones de limit switch de mesa inconsistentes: revisar switches.', 'Inconsistent table limit-switch activations: inspect switches.'],
  ['Sin acciones de mantenimiento sugeridas en esta corrida.', 'No maintenance actions suggested for this run.'],
  ['Calidad dentro de lo esperado.', 'Quality is within the expected range.'],
  ['Tasa de rechazo alta: revisar remachado, fixture y camara.', 'High reject rate: inspect riveting, fixture and camera.'],
  ['Tasa de rechazo alta: revisar remachado, fixture y cámara.', 'High reject rate: inspect riveting, fixture and camera.'],
  ['Rechazos moderados: monitorear camara y posicionamiento.', 'Moderate rejects: monitor camera and positioning.'],
  ['Rechazos moderados: monitorear cámara y posicionamiento.', 'Moderate rejects: monitor camera and positioning.'],
  ['Sin piezas terminadas para evaluar calidad.', 'No finished parts available to evaluate quality.'],
  ['Hubo RESTART: revisar causa de paro y limpieza.', 'A RESTART occurred: review stop cause and cleaning.'],
  ['Corrida abortada: revisar continuidad de la fuente / ventana.', 'Run aborted: check source/window continuity.'],
  ['Mas STOP que RESUME: posible operacion intermitente.', 'More STOP than RESUME events: possible intermittent operation.'],
  ['Más STOP que RESUME: posible operación intermitente.', 'More STOP than RESUME events: possible intermittent operation.'],
  ['Operacion estable.', 'Stable operation.'],
  ['Operación estable.', 'Stable operation.'],
];

function localizeRecommendation(text: string, language: ScadaLanguage): string {
  if (language === 'es') return text;
  let out = text;
  for (const [from, to] of RECOMMENDATION_EN) out = out.split(from).join(to);
  return out;
}

function riskLabel(risk: MaintRisk, language: ScadaLanguage): string {
  const en: Record<MaintRisk, string> = { BAJO: 'Low', MEDIO: 'Medium', ALTO: 'High' };
  return language === 'es' ? risk : en[risk];
}

function componentLabel(component: WornComponent, language: ScadaLanguage): string {
  const en: Record<WornComponent, string> = {
    gripper: 'gripper', conveyor: 'conveyor', mesa: 'table', camara: 'camera', remachadora: 'riveter', ninguno: 'none',
  };
  return language === 'es' ? component : en[component];
}

function bottleneckLabel(bottleneck: Bottleneck, language: ScadaLanguage): string {
  const en: Record<Bottleneck, string> = { cobot: 'cobot', remache: 'rivet', mesa: 'table', camara: 'camera', ninguno: 'none' };
  return language === 'es' ? bottleneck : en[bottleneck];
}

function localizedPillarValue(pillar: string, field: string, value: unknown, language: ScadaLanguage): unknown {
  if (language === 'es') return value;
  if (field === 'estimatedMaintenanceRisk') return riskLabel(value as MaintRisk, language);
  if (field === 'worstComponent') return componentLabel(value as WornComponent, language);
  if (field === 'bottleneckDetected') return bottleneckLabel(value as Bottleneck, language);
  if (typeof value === 'string' && (field.endsWith('Recommendation') || pillar === 'operation')) {
    return localizeRecommendation(value, language);
  }
  return value;
}

// Umbrales por corrida (ajustables). Pensados para una corrida de varias piezas.
const TH = {
  gripperCycles: 50,
  tableCycles: 30,
  conveyorOnSec: 120,
  rivetCycles: 40,
  cameraTriggers: 40,
  cameraFailRate: 0.30,
};

function isoOrEmpty(ms: number | null): string {
  if (ms == null) return '';
  try { return new Date(ms).toISOString(); } catch { return String(ms); }
}
const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (num: number, den: number) => (den > 0 ? r1((num / den) * 100) : 0);

export function derivePillars(run: RunModel): AiPillars {
  const a = run.actuators, s = run.sensors, p = run.production;

  // ── Predicción / mantenimiento ──
  const conveyorOnTimeSec = r1(a.conveyorOnMs / 1000);
  const gripperCycles = a.gripperClose;
  const tableCycles = a.tableTurns;
  const rivetCycles = a.rivetCycles;
  const cameraTriggers = s.cameraTrigger;
  const cameraFailRate = s.cameraPass + s.cameraFail > 0 ? s.cameraFail / (s.cameraPass + s.cameraFail) : 0;

  // Desgaste normalizado por componente (1.0 = umbral).
  const wear: Record<WornComponent, number> = {
    gripper: gripperCycles / TH.gripperCycles,
    conveyor: conveyorOnTimeSec / TH.conveyorOnSec,
    mesa: tableCycles / TH.tableCycles,
    remachadora: rivetCycles / TH.rivetCycles,
    camara: cameraTriggers / TH.cameraTriggers,
    ninguno: 0,
  };
  let worstComponent: WornComponent = 'ninguno';
  let worstScore = 0;
  for (const k of ['gripper', 'conveyor', 'mesa', 'remachadora', 'camara'] as WornComponent[]) {
    if (wear[k] > worstScore) { worstScore = wear[k]; worstComponent = k; }
  }
  if (worstScore < 0.5) worstComponent = 'ninguno';

  let estimatedMaintenanceRisk: MaintRisk = 'BAJO';
  if (worstScore >= 1 || cameraFailRate > TH.cameraFailRate) estimatedMaintenanceRisk = 'ALTO';
  else if (worstScore >= 0.6) estimatedMaintenanceRisk = 'MEDIO';

  const recs: string[] = [];
  if (gripperCycles > TH.gripperCycles) recs.push('Revisar gripper / mordazas / presión de aire.');
  if (tableCycles > TH.tableCycles) recs.push('Revisar mesa, NEMA, correa y limit switches.');
  if (conveyorOnTimeSec > TH.conveyorOnSec) recs.push('Revisar motor del conveyor (tiempo ON alto).');
  if (cameraFailRate > TH.cameraFailRate) recs.push('Revisar iluminación / cámara / fixture (FAIL alto).');
  if (rivetCycles > TH.rivetCycles) recs.push('Revisar actuador de remachado (ciclos altos).');
  const limitInconsistent = Math.abs(a.tableHomeToWork - a.tableWorkToHome) > 2;
  if (limitInconsistent) recs.push('Activaciones de limit switch de mesa inconsistentes: revisar switches.');
  const maintenanceRecommendation = recs.length ? recs.join(' ') : 'Sin acciones de mantenimiento sugeridas en esta corrida.';

  // ── Calidad ──
  const totalCAFIs = run.cafis.length;
  const passRate = pct(p.accepted, p.accepted + p.rejected);
  const rejectRate = pct(p.rejected, p.accepted + p.rejected);
  let qualityRecommendation = 'Calidad dentro de lo esperado.';
  if (p.accepted + p.rejected > 0) {
    if (rejectRate >= 50) qualityRecommendation = 'Tasa de rechazo alta: revisar remachado, fixture y cámara.';
    else if (rejectRate >= 25) qualityRecommendation = 'Rechazos moderados: monitorear cámara y posicionamiento.';
  } else {
    qualityRecommendation = 'Sin piezas terminadas para evaluar calidad.';
  }

  // ── Eficiencia ──
  const waitingRivetSec = r1(p.waitRivetMs / 1000);
  const waitingTableSec = r1(p.waitTableMs / 1000);
  const waitingCameraSec = r1(p.waitCameraMs / 1000);
  const waitingCobotSec = r1(p.waitOtherMs / 1000);
  const waits: Record<Bottleneck, number> = {
    remache: p.waitRivetMs, mesa: p.waitTableMs, camara: p.waitCameraMs, cobot: p.waitOtherMs, ninguno: 0,
  };
  let bottleneckDetected: Bottleneck = 'ninguno';
  let maxWait = 0;
  for (const k of ['remache', 'mesa', 'camara', 'cobot'] as Bottleneck[]) {
    if (waits[k] > maxWait) { maxWait = waits[k]; bottleneckDetected = k; }
  }
  if (maxWait < 1000) bottleneckDetected = 'ninguno';
  // Idle alto sin una espera dominante → atribuir al cobot/secuencia.
  if (bottleneckDetected === 'ninguno' && p.cobotIdlePct > 0.4) bottleneckDetected = 'cobot';

  // ── Operación ──
  const o = run.operator;
  const abortedRuns = run.status.startsWith('ABORT') ? 1 : 0;
  const opRecs: string[] = [];
  if (o.restart > 0) opRecs.push('Hubo RESTART: revisar causa de paro y limpieza.');
  if (abortedRuns) opRecs.push('Corrida abortada: revisar continuidad de la fuente / ventana.');
  if (o.stop > o.resume) opRecs.push('Más STOP que RESUME: posible operación intermitente.');
  const operatorRecommendation = opRecs.length ? opRecs.join(' ') : 'Operación estable.';

  return {
    prediction: {
      conveyorOnTimeSec, gripperCycles, tableCycles, rivetCycles, cameraTriggers,
      estimatedMaintenanceRisk, worstComponent, maintenanceRecommendation,
    },
    quality: {
      totalCAFIs, accepted: p.accepted, rejected: p.rejected, passRate, rejectRate,
      cameraPass: s.cameraPass, cameraFail: s.cameraFail, noRead: s.cameraNoRead, qualityRecommendation,
    },
    efficiency: {
      averageCycleTimeSec: r1(p.averageCycleMs / 1000),
      lastCycleTimeSec: r1(p.lastCycleMs / 1000),
      last5AverageSec: r1(p.last5AvgMs / 1000),
      cobotIdlePct: Math.round(p.cobotIdlePct * 100),
      waitingRivetSec, waitingTableSec, waitingCameraSec, waitingCobotSec, bottleneckDetected,
    },
    operation: {
      starts: o.start, stops: o.stop, resumes: o.resume, restarts: o.restart,
      finalizeCount: o.finalize, manualReviews: o.manualReview, abortedRuns, operatorRecommendation,
    },
    traceability: {
      runId: run.id, runNumber: run.number,
      startTime: isoOrEmpty(run.startedAtMs), endTime: isoOrEmpty(run.endedAtMs),
      finalStatus: run.status, cafiCount: run.cafis.length, eventCount: run.events.length,
    },
  };
}

export function augmentForJson(run: RunModel): RunExport {
  return { ...run, aiPillars: derivePillars(run) };
}

// Sección CSV "PILARES_IA" (clave/valor aplanado).
export function pillarsForExport(pillars: AiPillars, language: ScadaLanguage = 'es'): Record<string, unknown> {
  const localizeObj = (pillar: string, obj: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = localizedPillarValue(pillar, k, v, language);
    return out;
  };
  return {
    prediction: localizeObj('prediction', pillars.prediction as unknown as Record<string, unknown>),
    quality: localizeObj('quality', pillars.quality as unknown as Record<string, unknown>),
    efficiency: localizeObj('efficiency', pillars.efficiency as unknown as Record<string, unknown>),
    operation: localizeObj('operation', pillars.operation as unknown as Record<string, unknown>),
    traceability: pillars.traceability,
  };
}

export function pillarsToCsvSection(pillars: AiPillars, language: ScadaLanguage = 'es'): string {
  const esc = (v: unknown) => {
    const str = v == null ? '' : String(v);
    return /[",\n;]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines: string[] = [
    csvSectionHeader('ai', language),
    language === 'es' ? `${esc('pilar')},${esc('campo')},${esc('valor')}` : `${esc('pillar')},${esc('field')},${esc('value')}`,
  ];
  const pillarName = (pilar: string) => {
    if (language === 'es') return pilar;
    return ({ prediccion: 'prediction', calidad: 'quality', eficiencia: 'efficiency', operacion: 'operation', trazabilidad: 'traceability' } as Record<string, string>)[pilar] ?? pilar;
  };
  const emit = (pilar: string, obj: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) {
      lines.push(`${esc(pillarName(pilar))},${esc(k)},${esc(localizedPillarValue(pilar, k, v, language))}`);
    }
  };
  emit('prediccion', pillars.prediction as unknown as Record<string, unknown>);
  emit('calidad', pillars.quality as unknown as Record<string, unknown>);
  emit('eficiencia', pillars.efficiency as unknown as Record<string, unknown>);
  emit('operacion', pillars.operation as unknown as Record<string, unknown>);
  emit('trazabilidad', pillars.traceability as unknown as Record<string, unknown>);
  return lines.join('\n');
}

// adminReport.ts - Administrative report for a SCADA SIM run.
//
// It never sends email automatically. It prepares text for copy, .txt download,
// or a mailto link that the operator confirms in their own email client.

import type { RunModel, AiPillars, Bottleneck, MaintRisk, WornComponent } from './runTypes';
import type { ScadaLanguage } from './i18n';

export const ADMIN_REPORT_EMAIL = '';

function isoOrDash(ms: number | null): string {
  if (ms == null) return '-';
  try { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19); } catch { return String(ms); }
}

const s1 = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

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
  const es: Record<MaintRisk, string> = { BAJO: 'Bajo', MEDIO: 'Medio', ALTO: 'Alto' };
  const en: Record<MaintRisk, string> = { BAJO: 'Low', MEDIO: 'Medium', ALTO: 'High' };
  return (language === 'es' ? es : en)[risk];
}

function componentLabel(component: WornComponent, language: ScadaLanguage): string {
  const es: Record<WornComponent, string> = {
    gripper: 'gripper', conveyor: 'conveyor', mesa: 'mesa', camara: 'camara', remachadora: 'remachadora', ninguno: 'ninguno',
  };
  const en: Record<WornComponent, string> = {
    gripper: 'gripper', conveyor: 'conveyor', mesa: 'table', camara: 'camera', remachadora: 'riveter', ninguno: 'none',
  };
  return (language === 'es' ? es : en)[component];
}

function bottleneckLabel(bottleneck: Bottleneck, language: ScadaLanguage): string {
  const es: Record<Bottleneck, string> = { cobot: 'cobot', remache: 'remache', mesa: 'mesa', camara: 'camara', ninguno: 'ninguno' };
  const en: Record<Bottleneck, string> = { cobot: 'cobot', remache: 'rivet', mesa: 'table', camara: 'camera', ninguno: 'none' };
  return (language === 'es' ? es : en)[bottleneck];
}

export function buildReportText(run: RunModel, pillars: AiPillars, language: ScadaLanguage = 'es'): string {
  const p = run.production, o = run.operator;
  const aborted = run.cafis.filter((c) => !['ACCEPTED_BIN', 'REJECTED_BIN', 'DONE'].includes(c.finalState)).length;
  const es = language === 'es';
  const L: string[] = [];

  L.push(es ? `Reporte SCADA SIM - Corrida #${run.number}` : `SCADA SIM Report - Run #${run.number}`);
  L.push('');
  L.push(es ? `Estado final: ${run.status}` : `Final status: ${run.status}`);
  L.push(es ? `Inicio: ${isoOrDash(run.startedAtMs)}` : `Start: ${isoOrDash(run.startedAtMs)}`);
  L.push(es ? `Fin: ${isoOrDash(run.endedAtMs)}` : `End: ${isoOrDash(run.endedAtMs)}`);
  L.push(es ? `Duracion: ${s1(run.durationMs)}` : `Duration: ${s1(run.durationMs)}`);
  L.push(es ? `CAFIs procesados: ${run.cafis.length}` : `Processed CAFIs: ${run.cafis.length}`);
  L.push(es ? `Aceptados: ${p.accepted}` : `Accepted: ${p.accepted}`);
  L.push(es ? `Rechazados: ${p.rejected}` : `Rejected: ${p.rejected}`);
  L.push(es ? `En proceso/revision: ${aborted}` : `In process/review: ${aborted}`);
  L.push('');
  L.push(es ? `Promedio de ciclo: ${s1(p.averageCycleMs)}` : `Average cycle: ${s1(p.averageCycleMs)}`);
  L.push(es ? `Ultimo ciclo: ${s1(p.lastCycleMs)}` : `Last cycle: ${s1(p.lastCycleMs)}`);
  L.push(es ? `Idle cobot: ${Math.round(p.cobotIdlePct * 100)}%` : `Cobot idle: ${Math.round(p.cobotIdlePct * 100)}%`);
  L.push('');
  L.push(es
    ? `Cuello de botella detectado: ${bottleneckLabel(pillars.efficiency.bottleneckDetected, language)}`
    : `Detected bottleneck: ${bottleneckLabel(pillars.efficiency.bottleneckDetected, language)}`);
  L.push(es
    ? `Riesgo mantenimiento: ${riskLabel(pillars.prediction.estimatedMaintenanceRisk, language)}`
    : `Maintenance risk: ${riskLabel(pillars.prediction.estimatedMaintenanceRisk, language)}`);
  L.push(es
    ? `Componente con mas desgaste: ${componentLabel(pillars.prediction.worstComponent, language)}`
    : `Most worn component: ${componentLabel(pillars.prediction.worstComponent, language)}`);
  L.push(es
    ? `Recomendacion: ${localizeRecommendation(pillars.prediction.maintenanceRecommendation, language)}`
    : `Recommendation: ${localizeRecommendation(pillars.prediction.maintenanceRecommendation, language)}`);
  L.push('');
  L.push(es ? 'Eventos operador:' : 'Operator events:');
  L.push(`START: ${o.start}`);
  L.push(`STOP: ${o.stop}`);
  L.push(`RESUME: ${o.resume}`);
  L.push(`RESTART: ${o.restart}`);
  L.push(`${es ? 'FINALIZAR' : 'FINALIZE'}: ${o.finalize}`);
  L.push(es ? `Abortos: ${pillars.operation.abortedRuns}` : `Aborts: ${pillars.operation.abortedRuns}`);
  L.push('');
  L.push(es ? 'Observaciones automaticas:' : 'Automatic observations:');
  L.push(`- ${localizeRecommendation(pillars.quality.qualityRecommendation, language)}`);
  L.push(`- ${localizeRecommendation(pillars.operation.operatorRecommendation, language)}`);
  return L.join('\n');
}

export interface MailtoParts { subject: string; body: string; href: string; }

export function defaultSubject(run: RunModel, language: ScadaLanguage = 'es'): string {
  return language === 'es'
    ? `Reporte SCADA SIM - Corrida #${run.number} (${run.status})`
    : `SCADA SIM Report - Run #${run.number} (${run.status})`;
}

export function buildMailto(
  run: RunModel,
  pillars: AiPillars,
  to: string = ADMIN_REPORT_EMAIL,
  language: ScadaLanguage = 'es',
): MailtoParts {
  const subject = defaultSubject(run, language);
  const body = buildReportText(run, pillars, language);
  return { subject, body, href: composeMailto(to, subject, body) };
}

export function composeMailto(to: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export async function copyReportToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard permissions are browser/user controlled.
  }
  return false;
}

export function downloadReportTxt(run: RunModel, text: string, language: ScadaLanguage = 'es'): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = language === 'es' ? `reporte_corrida_${run.number}.txt` : `report_run_${run.number}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function openMailto(href: string): void {
  if (typeof window !== 'undefined') window.location.href = href;
}

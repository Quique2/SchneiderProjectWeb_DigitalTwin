// ─────────────────────────────────────────────────────────────────────────────
// exportRun.ts — Exporta una corrida a JSON o CSV (sin dependencias).
//
// No hay librería xlsx en el proyecto → el CSV agrupa las TRES "hojas" (resumen,
// detalle de CAFIs, eventos) en un solo archivo con secciones etiquetadas. El JSON
// lleva la corrida completa con fidelidad total. Descarga vía Blob + object URL.
// ─────────────────────────────────────────────────────────────────────────────

import type { RunModel } from './runTypes';
import { derivePillars, pillarsForExport, pillarsToCsvSection } from './aiPillars';
import type { ScadaLanguage } from './i18n';
import { csvSectionHeader } from './i18n';

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function row(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

function isoOrEmpty(ms: number | null): string {
  if (ms == null) return '';
  try { return new Date(ms).toISOString(); } catch { return String(ms); }
}

function ms(v: number | null | undefined): string {
  return v == null ? '' : String(Math.round(v));
}

// ── Secciones CSV ─────────────────────────────────────────────────────────────
export function summarySection(run: RunModel, language: ScadaLanguage = 'es'): string {
  const p = run.production, s = run.sensors, a = run.actuators, o = run.operator;
  const lines: string[] = [];
  lines.push(csvSectionHeader('summary', language));
  lines.push(language === 'es' ? row(['campo', 'valor']) : row(['field', 'value']));
  const es = language === 'es';
  const kv: [string, unknown][] = [
    [es ? 'id_corrida' : 'run_id', run.id],
    [es ? 'numero_corrida' : 'run_number', run.number],
    [es ? 'inicio' : 'start', isoOrEmpty(run.startedAtMs)],
    [es ? 'fin' : 'end', isoOrEmpty(run.endedAtMs)],
    [es ? 'estado_final' : 'final_status', run.status],
    [es ? 'estado_celda_final' : 'final_cell_state', run.finalCellState ?? ''],
    [es ? 'duracion_ms' : 'duration_ms', ms(run.durationMs)],
    [es ? 'total_cafis' : 'total_cafis', run.cafis.length],
    [es ? 'completados' : 'completed', p.completed],
    [es ? 'aceptados' : 'accepted', p.accepted],
    [es ? 'rechazados' : 'rejected', p.rejected],
    [es ? 'en_revision' : 'in_review', p.review],
    [es ? 'reutilizables' : 'reusable', p.reusable],
    [es ? 'abortados' : 'aborted', run.cafis.filter((c) => !['ACCEPTED_BIN', 'REJECTED_BIN', 'DONE'].includes(c.finalState)).length],
    [es ? 'promedio_ciclo_ms' : 'average_cycle_ms', ms(p.averageCycleMs)],
    [es ? 'ultimo_ciclo_ms' : 'last_cycle_ms', ms(p.lastCycleMs)],
    [es ? 'promedio_ult5_ms' : 'last5_average_ms', ms(p.last5AvgMs)],
    [es ? 'cobot_idle_pct' : 'cobot_idle_pct', Math.round(p.cobotIdlePct * 100)],
    [es ? 'espera_remache_ms' : 'wait_rivet_ms', ms(p.waitRivetMs)],
    [es ? 'espera_mesa_ms' : 'wait_table_ms', ms(p.waitTableMs)],
    [es ? 'espera_camara_ms' : 'wait_camera_ms', ms(p.waitCameraMs)],
    [es ? 'espera_otros_ms' : 'wait_other_ms', ms(p.waitOtherMs)],
    // Sensores
    ['sensor_conveyor_photoeye', s.conveyorPhotoeye],
    ['sensor_fixture1', s.fixture1Present],
    ['sensor_fixture2', s.fixture2Present],
    ['sensor_limit_home', s.limitHome],
    ['sensor_limit_work', s.limitWork],
    ['sensor_vision', s.visionPresent],
    ['camara_trigger', s.cameraTrigger],
    ['camara_pass', s.cameraPass],
    ['camara_fail', s.cameraFail],
    ['camara_no_read', s.cameraNoRead],
    // Actuadores
    ['gripper_close', a.gripperClose],
    ['gripper_open', a.gripperOpen],
    [es ? 'conveyor_arranques' : 'conveyor_starts', a.conveyorStarts],
    ['conveyor_on_ms', ms(a.conveyorOnMs)],
    [es ? 'mesa_giros' : 'table_turns', a.tableTurns],
    [es ? 'mesa_home_a_work' : 'table_home_to_work', a.tableHomeToWork],
    [es ? 'mesa_work_a_home' : 'table_work_to_home', a.tableWorkToHome],
    [es ? 'mesa_moviendo_ms' : 'table_moving_ms', ms(a.tableMovingMs)],
    [es ? 'remache_ciclos' : 'rivet_cycles', a.rivetCycles],
    [es ? 'remache_activo_ms' : 'rivet_active_ms', ms(a.rivetActiveMs)],
    [es ? 'stacklight_verde' : 'stacklight_green', a.stacklightGreen],
    [es ? 'stacklight_amarillo' : 'stacklight_yellow', a.stacklightYellow],
    [es ? 'stacklight_rojo' : 'stacklight_red', a.stacklightRed],
    // Operador
    ['op_start', o.start],
    ['op_stop', o.stop],
    ['op_resume', o.resume],
    ['op_restart', o.restart],
    ['op_confirm_clean', o.confirmClean],
    ['op_finalize', o.finalize],
    ['op_manual_reject', o.manualReject],
    ['op_manual_reusable', o.manualReusable],
    ['op_manual_review', o.manualReview],
  ];
  for (const [k, v] of kv) lines.push(row([k, v]));
  return lines.join('\n');
}

export function cafisSection(run: RunModel, language: ScadaLanguage = 'es'): string {
  const lines: string[] = [];
  lines.push(csvSectionHeader('cafis', language));
  lines.push(language === 'es'
    ? row(['id', 'estado_final', 'veredicto_camara', 'fixture', 'sensorAt', 'placedFixtureAt',
      'rivetedAt', 'atCameraAt', 'doneAt', 'cycleTime_ms', 'zona_restart', 'decision_manual', 'observacion'])
    : row(['id', 'final_state', 'camera_verdict', 'fixture', 'sensorAt', 'placedFixtureAt',
      'rivetedAt', 'atCameraAt', 'doneAt', 'cycleTime_ms', 'restart_zone', 'manual_decision', 'note']));
  for (const c of run.cafis) {
    lines.push(row([c.id, c.finalState, c.verdict ?? '', c.fixtureId ?? '',
      ms(c.sensorAt), ms(c.placedFixtureAt), ms(c.rivetedAt), ms(c.atCameraAt), ms(c.doneAt),
      ms(c.cycleTimeMs), c.removalZone ?? '', c.manualDecision ?? '', c.manualNote ?? '']));
  }
  return lines.join('\n');
}

export function eventsSection(run: RunModel, language: ScadaLanguage = 'es'): string {
  const lines: string[] = [];
  lines.push(csvSectionHeader('events', language));
  lines.push(language === 'es'
    ? row(['t_pared', 'reloj_sim_ms', 'tipo', 'descripcion', 'cafi', 'prev', 'next'])
    : row(['wall_time', 'sim_clock_ms', 'type', 'description', 'cafi', 'prev', 'next']));
  for (const e of run.events) {
    lines.push(row([isoOrEmpty(e.t), ms(e.simClock), e.type, e.description, e.cafiId ?? '', e.prev ?? '', e.next ?? '']));
  }
  return lines.join('\n');
}

export function runToCsv(run: RunModel, language: ScadaLanguage = 'es'): string {
  const pillars = pillarsToCsvSection(derivePillars(run), language);
  return [summarySection(run, language), '', cafisSection(run, language), '', eventsSection(run, language), '', pillars].join('\n');
}

export function runToJson(run: RunModel, language: ScadaLanguage = 'es'): string {
  // Incluye el bloque aiPillars junto a la corrida completa.
  const pillars = derivePillars(run);
  return JSON.stringify({ ...run, exportLanguage: language, aiPillars: pillarsForExport(pillars, language) }, null, 2);
}

// ── Descarga ──────────────────────────────────────────────────────────────────
function download(filename: string, text: string, mime: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function baseName(run: RunModel): string {
  return `corrida_${run.number}_${run.status.toLowerCase()}`;
}

export function exportRunCsv(run: RunModel, language: ScadaLanguage = 'es'): void {
  download(`${baseName(run)}.csv`, runToCsv(run, language), 'text/csv;charset=utf-8');
}

export function exportRunJson(run: RunModel, language: ScadaLanguage = 'es'): void {
  download(`${baseName(run)}.json`, runToJson(run, language), 'application/json');
}

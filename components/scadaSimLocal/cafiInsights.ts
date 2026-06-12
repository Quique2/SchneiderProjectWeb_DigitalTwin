// ─────────────────────────────────────────────────────────────────────────────
// cafiInsights.ts — Lógica del tab/card "CAFI ACTIVO".
//
// Elige el CAFI de MENOR ID que sigue en proceso y deriva su zona, próxima acción
// y tiempos. Opera sobre CafiEntity del snapshot (tiene stateMs/updatedAt). Puro,
// solo `import type` → testeable en Node.
// ─────────────────────────────────────────────────────────────────────────────

import type { CafiEntity, CafiState, Verdict } from '../cellStateTypes';
import type { ScadaLanguage } from './i18n';

// Estados considerados "en proceso" (no terminados). Incluye los de la FSM y los
// estados manuales de Fase 2B (aún no emitidos por la FSM) por robustez.
const IN_PROCESS = new Set<string>([
  'DISPENSED', 'ON_CONVEYOR_WAITING', 'AT_SENSOR', 'IN_GRIPPER',
  'IN_OUTSIDE_FIXTURE', 'IN_RIVET_FIXTURE', 'RIVETING', 'RIVETED',
  'IN_INSPECTION', 'INSPECTED_PASS', 'INSPECTED_FAIL',
  'MANUAL_REMOVAL_REQUIRED', 'PENDING_OPERATOR_REVIEW',
]);

const TERMINAL = new Set<string>([
  'ACCEPTED_BIN', 'REJECTED_BIN', 'DONE',
  'MANUAL_PASS', 'MANUAL_REJECT', 'REUSABLE', 'ABORTED_PAGE_CLOSED',
]);

export function isInProcess(state: string): boolean {
  return IN_PROCESS.has(state) && !TERMINAL.has(state);
}

/** CAFI de MENOR ID que sigue en proceso (o null si ninguno). */
export function pickActiveCafi(cafis: CafiEntity[]): CafiEntity | null {
  let best: CafiEntity | null = null;
  for (const c of cafis) {
    if (!isInProcess(c.state)) continue;
    if (best === null || c.id < best.id) best = c;
  }
  return best;
}

export function zoneLabel(state: CafiState, language: ScadaLanguage = 'es'): string {
  if (language === 'en') {
    switch (state) {
      case 'DISPENSED': case 'ON_CONVEYOR_WAITING': return 'Conveyor';
      case 'AT_SENSOR': return 'Sensor (waiting pick)';
      case 'IN_GRIPPER': return 'Gripper';
      case 'IN_OUTSIDE_FIXTURE': return 'Outside fixture';
      case 'IN_RIVET_FIXTURE': return 'Rivet fixture';
      case 'RIVETING': return 'Riveting';
      case 'RIVETED': return 'Rivet fixture (riveted)';
      case 'IN_INSPECTION': return 'Camera / inspection';
      case 'INSPECTED_PASS': case 'INSPECTED_FAIL': return 'Camera (with verdict)';
      case 'ACCEPTED_BIN': return 'Accepted bin';
      case 'REJECTED_BIN': return 'Rejected bin';
      case 'MANUAL_REMOVAL_REQUIRED': return 'Manual review';
      case 'DONE': return 'Done';
      default: return '-';
    }
  }
  switch (state) {
    case 'DISPENSED': case 'ON_CONVEYOR_WAITING': return 'Conveyor';
    case 'AT_SENSOR': return 'Sensor (espera pick)';
    case 'IN_GRIPPER': return 'Gripper';
    case 'IN_OUTSIDE_FIXTURE': return 'Fixture externo';
    case 'IN_RIVET_FIXTURE': return 'Fixture remache';
    case 'RIVETING': return 'Remachado';
    case 'RIVETED': return 'Fixture remache (remachada)';
    case 'IN_INSPECTION': return 'Cámara / inspección';
    case 'INSPECTED_PASS': case 'INSPECTED_FAIL': return 'Cámara (con veredicto)';
    case 'ACCEPTED_BIN': return 'Bin aceptados';
    case 'REJECTED_BIN': return 'Bin rechazados';
    case 'MANUAL_REMOVAL_REQUIRED': return 'Revisión manual';
    case 'DONE': return 'Terminado';
    default: return '—';
  }
}

export function nextAction(state: CafiState, language: ScadaLanguage = 'es'): string {
  if (language === 'en') {
    switch (state) {
      case 'DISPENSED': case 'ON_CONVEYOR_WAITING': return 'advance on conveyor';
      case 'AT_SENSOR': return 'wait for cobot pick';
      case 'IN_GRIPPER': return 'move to fixture';
      case 'IN_OUTSIDE_FIXTURE': return 'wait for table index';
      case 'IN_RIVET_FIXTURE': return 'wait for rivet';
      case 'RIVETING': return 'riveting (wait 30 s)';
      case 'RIVETED': return 'wait for pick (riveted)';
      case 'IN_INSPECTION': return 'wait for verdict';
      case 'INSPECTED_PASS': return 'move to accepted bin';
      case 'INSPECTED_FAIL': return 'move to rejected bin';
      case 'MANUAL_REMOVAL_REQUIRED': return 'manual review';
      default: return '-';
    }
  }
  switch (state) {
    case 'DISPENSED': case 'ON_CONVEYOR_WAITING': return 'avanzar en conveyor';
    case 'AT_SENSOR': return 'esperar pick del cobot';
    case 'IN_GRIPPER': return 'ir a fixture';
    case 'IN_OUTSIDE_FIXTURE': return 'esperar giro de mesa';
    case 'IN_RIVET_FIXTURE': return 'esperar remache';
    case 'RIVETING': return 'remachando (esperar 30 s)';
    case 'RIVETED': return 'esperar pick (remachada)';
    case 'IN_INSPECTION': return 'esperar veredicto';
    case 'INSPECTED_PASS': return 'ir a accepted';
    case 'INSPECTED_FAIL': return 'ir a rejected';
    case 'MANUAL_REMOVAL_REQUIRED': return 'revisión manual';
    default: return '—';
  }
}

export interface ActiveCafiInfo {
  id: number;
  state: CafiState;
  zone: string;
  nextAction: string;
  verdict: Verdict | null;
  sinceDetectedMs: number;  // clock - sensorAt (o createdAt si aún sin detección)
  inStateMs: number;        // tiempo en el estado actual
}

export function activeCafiInfo(c: CafiEntity, clock: number, language: ScadaLanguage = 'es'): ActiveCafiInfo {
  const sinceDetectedMs = c.sensorAt != null ? clock - c.sensorAt : clock - c.createdAt;
  const inStateMs = c.stateMs?.[c.state] ?? Math.max(0, clock - c.updatedAt);
  return {
    id: c.id,
    state: c.state,
    zone: zoneLabel(c.state, language),
    nextAction: nextAction(c.state, language),
    verdict: c.verdict,
    sinceDetectedMs: Math.max(0, sinceDetectedMs),
    inStateMs: Math.max(0, inStateMs),
  };
}

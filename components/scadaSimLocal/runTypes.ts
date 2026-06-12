// ─────────────────────────────────────────────────────────────────────────────
// runTypes.ts — Modelo de "corrida" (run) del SCADA SIM.
//
// Una corrida agrega TODO lo medible de una ejecución de la celda: producción,
// contadores de sensores/actuadores (derivados por flancos del snapshot), tiempos
// ON de actuadores, eventos de operador y el detalle por CAFI. La capa observadora
// (runAggregator.ts) construye este modelo a partir de snapshots sucesivos SIN
// tocar la FSM.
//
// Campos de Fase 2 (review/reusable, decisiones manuales, stacklight) ya existen
// en el tipo pero quedan en 0/neutro en Fase 1 para que el export sea estable.
// ─────────────────────────────────────────────────────────────────────────────

import type { CellState, CafiState, Verdict, FixtureId } from '../cellStateTypes';

export type RunStatus =
  | 'ACTIVE'
  | 'COMPLETED'              // volvió a IDLE de forma normal
  | 'COMPLETED_BY_FINALIZE'  // FINALIZAR drenó la planta y volvió a IDLE
  | 'ABORTED_PAGE_CLOSED'    // se cerró la ventana con CAFI en proceso
  | 'ABORTED_SOURCE_LOST'    // se perdió la fuente (Celda 3D) con CAFI en proceso
  | 'ABORTED_RESTART'        // RESTART obligó limpieza/reclasificación
  | 'FAULTED';               // la celda entró en FAULT

/** Zona física donde estaba un CAFI al iniciarse un RESTART (capturada a tiempo). */
export type CafiZone =
  | 'CONVEYOR'
  | 'SENSOR'
  | 'GRIPPER'
  | 'OUTSIDE_FIXTURE'
  | 'RIVET_ZONE'
  | 'CAMERA'
  | 'BIN'
  | 'UNKNOWN';

/** Contadores de activación (flancos de subida) de sensores simulados. */
export interface SensorCounters {
  conveyorPhotoeye: number;
  fixture1Present: number;
  fixture2Present: number;
  limitHome: number;
  limitWork: number;
  visionPresent: number;
  cameraTrigger: number;
  cameraPass: number;
  cameraFail: number;
  cameraNoRead: number; // Fase 2 (la FSM no modela NO_READ aún) → 0
}

/** Contadores + tiempos ON acumulados de actuadores simulados. */
export interface ActuatorCounters {
  gripperClose: number;
  gripperOpen: number;
  conveyorStarts: number;
  conveyorOnMs: number;
  tableTurns: number;
  tableHomeToWork: number;
  tableWorkToHome: number;
  tableMovingMs: number;
  rivetCycles: number;
  rivetActiveMs: number;
  // Stacklight (Fase 2) — se derivará de cell/fault; en Fase 1 quedan en 0.
  stacklightGreen: number;
  stacklightYellow: number;
  stacklightRed: number;
}

/** Contadores de eventos de operador (derivados de transiciones en Fase 1). */
export interface OperatorCounters {
  start: number;
  stop: number;
  resume: number;
  restart: number;
  confirmClean: number;
  finalize: number;
  // Fase 2 (decisiones manuales) → 0 en Fase 1.
  manualReject: number;
  manualReusable: number;
  manualReview: number;
}

/** Métricas de producción (espejo de cycleStats/counts del snapshot). */
export interface ProductionMetrics {
  cellState: CellState;
  completed: number;
  accepted: number;
  rejected: number;
  inProcess: number;
  // Fase 2 → 0 en Fase 1.
  review: number;
  reusable: number;
  aborted: number;
  // Tiempos de ciclo (ms del reloj simulado).
  currentCycleMs: number;
  averageCycleMs: number;
  lastCycleMs: number;
  last5AvgMs: number;
  // Ocupación del cobot.
  cobotIdlePct: number;
  waitCameraMs: number;
  waitTableMs: number;
  waitRivetMs: number;
  waitOtherMs: number;
}

/** Detalle por CAFI para la hoja de export. */
export interface CafiDetail {
  id: number;
  finalState: CafiState;
  verdict: Verdict | null;
  fixtureId: FixtureId | null;
  sensorAt: number | null;
  placedFixtureAt: number | null;
  rivetedAt: number | null;
  atCameraAt: number | null;
  doneAt: number | null;
  cycleTimeMs: number | null;     // doneAt - sensorAt (null si no terminó)
  // Capturado al iniciar un RESTART (antes de que la FSM borre la ubicación).
  removalZone: CafiZone | null;
  // Fase 2 — decisión manual de clasificación.
  manualDecision: 'PASS' | 'NO_PASS' | 'REUSABLE' | null;
  manualNote: string | null;
}

/** Entrada del log cronológico de eventos. */
export interface RunEvent {
  t: number;            // reloj de pared (ms) del emisor/monitor
  simClock: number;     // reloj simulado (ms) del snapshot
  type: string;         // 'RUN_START' | 'CELL_STATE' | 'OPERATOR' | 'CAFI_DONE' | ...
  description: string;
  cafiId?: number;
  prev?: string;
  next?: string;
}

/** Una corrida completa. */
export interface RunModel {
  id: string;            // único (number + start)
  number: number;        // contador por sesión (Corrida 1, 2, 3…)
  startedAtMs: number;   // reloj de pared al iniciar
  startedClock: number;  // reloj simulado al iniciar
  endedAtMs: number | null;
  endedClock: number | null;
  status: RunStatus;
  finalCellState: CellState | null;
  durationMs: number;    // endedAtMs - startedAtMs (o en curso)

  production: ProductionMetrics;
  sensors: SensorCounters;
  actuators: ActuatorCounters;
  operator: OperatorCounters;

  cafis: CafiDetail[];
  events: RunEvent[];
}

// ── Pilares de IA / analítica operacional (derivados del RunModel) ───────────
export type MaintRisk = 'BAJO' | 'MEDIO' | 'ALTO';
export type WornComponent = 'gripper' | 'conveyor' | 'mesa' | 'camara' | 'remachadora' | 'ninguno';
export type Bottleneck = 'cobot' | 'remache' | 'mesa' | 'camara' | 'ninguno';

export interface AiPillarPrediction {
  conveyorOnTimeSec: number;
  gripperCycles: number;
  tableCycles: number;
  rivetCycles: number;
  cameraTriggers: number;
  estimatedMaintenanceRisk: MaintRisk;
  worstComponent: WornComponent;
  maintenanceRecommendation: string;
}

export interface AiPillarQuality {
  totalCAFIs: number;
  accepted: number;
  rejected: number;
  passRate: number;   // %
  rejectRate: number; // %
  cameraPass: number;
  cameraFail: number;
  noRead: number;
  qualityRecommendation: string;
}

export interface AiPillarEfficiency {
  averageCycleTimeSec: number;
  lastCycleTimeSec: number;
  last5AverageSec: number;
  cobotIdlePct: number;
  waitingRivetSec: number;
  waitingTableSec: number;
  waitingCameraSec: number;
  waitingCobotSec: number;
  bottleneckDetected: Bottleneck;
}

export interface AiPillarOperation {
  starts: number;
  stops: number;
  resumes: number;
  restarts: number;
  finalizeCount: number;
  manualReviews: number;
  abortedRuns: number;
  operatorRecommendation: string;
}

export interface AiPillarTraceability {
  runId: string;
  runNumber: number;
  startTime: string;     // ISO
  endTime: string;       // ISO o ''
  finalStatus: RunStatus;
  cafiCount: number;
  eventCount: number;
}

export interface AiPillars {
  prediction: AiPillarPrediction;
  quality: AiPillarQuality;
  efficiency: AiPillarEfficiency;
  operation: AiPillarOperation;
  traceability: AiPillarTraceability;
}

/** Forma de export JSON: la corrida + el bloque aiPillars. */
export interface RunExport extends RunModel {
  aiPillars: AiPillars;
}

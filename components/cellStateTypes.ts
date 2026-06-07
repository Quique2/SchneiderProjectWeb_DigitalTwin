// ─────────────────────────────────────────────────────────────────────────────
// cellStateTypes.ts — Tipos compartidos de la simulación de la celda Schneider.
//
// Alineado con LOGICA_PLANTA_SCHNEIDER.md (máquina de estados completa): 6
// estados de celda, 14 estados de CAFI, dos fixtures (A/B) en el disco con roles
// que se intercambian al girar 180°, remachado de 30 s exactos, interlocks de
// seguridad / anti-colisión, y flujo STOP → RESUME/RESTART → limpieza.
//
// Sólo `type`/`interface` (sin runtime) para que `cellStateMachine.ts` lo importe
// con `import type` y el validador headless (Node type-stripping) lo lea directo.
// Uniones de string en vez de `enum` (los `enum` rompen el type-stripping).
// ─────────────────────────────────────────────────────────────────────────────

// ── Estado global de la celda ────────────────────────────────────────────────
export type CellState =
  | 'IDLE'
  | 'RUNNING'
  | 'PAUSED'
  | 'RESTARTING'
  | 'CLEANING_REQUIRED'
  | 'FAULT';

// ── Estados por pieza CAFI (LOGICA_PLANTA_SCHNEIDER) ─────────────────────────
export type CafiState =
  | 'DISPENSED'
  | 'ON_CONVEYOR_WAITING'
  | 'AT_SENSOR'
  | 'IN_GRIPPER'
  | 'IN_OUTSIDE_FIXTURE'
  | 'IN_RIVET_FIXTURE'
  | 'RIVETING'
  | 'RIVETED'
  | 'IN_INSPECTION'
  | 'INSPECTED_PASS'
  | 'INSPECTED_FAIL'
  | 'ACCEPTED_BIN'
  | 'REJECTED_BIN'
  | 'MANUAL_REMOVAL_REQUIRED'
  | 'DONE';

// ── Tarea actual del cobot (recurso único; determina la pose en la escena 3D) ─
export type CobotTask =
  | 'IDLE'            // en HOME, libre
  | 'PICK_CONVEYOR'   // tomando del conveyor
  | 'PLACE_OUTSIDE'   // colocando en el fixture externo (entra a zona de mesa)
  | 'PICK_RIVETED'    // retirando pieza remachada del fixture externo (zona mesa)
  | 'PLACE_VISION'    // colocando en la cámara
  | 'PICK_VISION'     // retirando de la cámara
  | 'PLACE_ACCEPT'    // depositando en bin de aceptados
  | 'PLACE_REJECT'    // depositando en bin de rechazados
  | 'RECOVERY_REJECT' // RESTART: lleva pieza al bin de rechazo (lento)
  | 'RECOVERY_HOME';  // RESTART: regresa a HOME (lento)

// ── Mesa rotatoria ───────────────────────────────────────────────────────────
export type TableState =
  | 'HOME'             // 0°, fixture externo accesible
  | 'INDEXING_TO_WORK' // girando 0°→180°
  | 'AT_WORK'          // 180°, confirmado por limit switch
  | 'INDEXING_TO_HOME' // girando 180°→0°
  | 'ERROR';

// ── Subsistemas ──────────────────────────────────────────────────────────────
export type RivetingState = 'IDLE' | 'ARMED' | 'ACTIVE' | 'DONE' | 'FAULT';
export type VisionState = 'IDLE' | 'PRESENT' | 'INSPECTING' | 'PASS' | 'FAIL' | 'FAULT';
export type Verdict = 'PASS' | 'FAIL';

// ── Modo de la HMI ───────────────────────────────────────────────────────────
//   HMI   = simulación automática (la state machine es dueña).
//   DEBUG = manual/diagnóstico (los controles manuales son dueños de los refs).
export type SimMode = 'HMI' | 'DEBUG';

// ── Fixtures físicos del disco y bins ────────────────────────────────────────
export type FixtureId = 'A' | 'B';
export type BinId = 'ACCEPT' | 'REJECT';

// ── Entidad CAFI ─────────────────────────────────────────────────────────────
export interface CafiEntity {
  id: number;
  state: CafiState;
  riveted: boolean;
  verdict: Verdict | null;
  /** Fixture en el que está montado (A/B) mientras viaja en el disco. */
  fixtureId: FixtureId | null;
  bin: BinId | null;
  /** Clave de pose visual (la escena 3D ubica la pieza). */
  poseKey: string;
  createdAt: number;
  updatedAt: number;
}

// ── Bloque mesa del snapshot ─────────────────────────────────────────────────
export interface TurntableSnapshot {
  state: TableState;
  angleDeg: number;
  target: 'HOME' | 'WORK';
  moving: boolean;
  limitHome: boolean;
  limitWork: boolean;
}

// ── Estado por fixture (qué CAFI tiene y su rol actual) ──────────────────────
export interface FixtureSnapshot {
  id: FixtureId;
  cafiId: number | null;
  /** 'OUTSIDE' = accesible al cobot · 'RIVET' = en zona de remachado. */
  role: 'OUTSIDE' | 'RIVET';
  /** Limit switch de presencia de pieza en el fixture. */
  present: boolean;
}

// ── Lámparas Digital Input (4) ───────────────────────────────────────────────
export interface DiSnapshot {
  conveyor: boolean;   // sensor fotoeléctrico de la banda
  rivet: boolean;      // pieza presente en zona de remachado
  vision: boolean;     // pieza presente en visión
  cobotReady: boolean; // cobot libre
}

// ── Lámparas Digital Output (8) ──────────────────────────────────────────────
export interface DoSnapshot {
  convMotor: boolean;
  disco: boolean;      // disco indexando
  remachado: boolean;  // actuador de remachado activo
  camara: boolean;     // trigger / inspección de cámara
  gripOpen: boolean;
  gripClose: boolean;
  solLeft: boolean;    // solenoide de fixture (sujeción)
  reservado: boolean;
}

// ── Eventos de operador ──────────────────────────────────────────────────────
export type OperatorEvent =
  | { type: 'START' }
  | { type: 'PLACE_CAFI' }
  | { type: 'STOP' }
  | { type: 'RESUME' }
  | { type: 'RESTART' }
  | { type: 'CONFIRM_CLEAN' }
  | { type: 'RESET' }
  | { type: 'FINALIZE' }   // fin de operación normal: drena lo en proceso → HOME → IDLE
  | { type: 'SWITCH_MODE'; mode: SimMode };

// ── Contadores de producción ─────────────────────────────────────────────────
export interface CountsSnapshot {
  accepted: number;
  rejected: number;
  inProcess: number; // CAFIs vivos que no están en bin/done
}

// ── Snapshot completo que consumen HMI y escena 3D ───────────────────────────
export interface CellSnapshot {
  mode: SimMode;
  cell: CellState;

  cafis: CafiEntity[];
  activeCafiId: number | null; // CAFI primaria que el cobot atiende (o null)

  // Cola / sensor del conveyor
  waitingCount: number;     // DISPENSED | ON_CONVEYOR_WAITING | AT_SENSOR
  sensorOccupied: boolean;  // alguna CAFI en AT_SENSOR
  sensorCafiId: number | null;
  spawnAllowed: boolean;
  spawnBlockReason: string;

  // Mesa + fixtures (roles que se intercambian al girar)
  turntable: TurntableSnapshot;
  outsideFixtureId: FixtureId;
  rivetFixtureId: FixtureId;
  fixtureA: FixtureSnapshot;
  fixtureB: FixtureSnapshot;

  // Cobot
  cobotTask: CobotTask;
  cobotBusy: boolean;
  cobotInTableZone: boolean; // dentro de la zona de riesgo de la mesa

  // Remachado / visión
  riveting: RivetingState;
  rivetingDone: boolean;
  rivetProgress: number;      // 0..1 del dwell de 30 s
  rivetSecondsLeft: number;   // segundos restantes (redondeado)
  vision: VisionState;
  verdict: Verdict | null;

  counts: CountsSnapshot;
  cleaningPending: boolean; // CLEANING_REQUIRED y aún hay sensores ocupados
  finalizing: boolean;      // FINALIZAR pulsado: drenando trabajo en proceso antes de HOME/IDLE

  fault: boolean;
  faultReason: string;

  di: DiSnapshot;
  do: DoSnapshot;

  clock: number; // reloj simulado (ms)
}

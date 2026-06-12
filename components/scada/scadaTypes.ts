// ─────────────────────────────────────────────────────────────────────────────
// scadaTypes.ts — Tipos del módulo SCADA (solo tipos, sin runtime).
//
// FILOSOFÍA: SCADA REAL-ONLY por defecto. Un dato solo se muestra si proviene de
// telemetría real (cobot por WebSocket o telemetry.io del gateway). Si un dato no
// existe en tiempo real, su valor es `null` y su `source` es NOT_CONNECTED — NUNCA
// se inventa. El modo DEMO (toggle, OFF por defecto) sintetiza datos SOLO para
// presentar el SCADA sin hardware, y SIEMPRE los marca con source = DEMO.
// ─────────────────────────────────────────────────────────────────────────────

import type { CafiTrack } from './ai/cafiTracker';
export type { CafiTrack };

export type Severity = 'INFO' | 'WARNING' | 'ALARM' | 'CRITICAL';

// Estado/origen de un dato:
//   REAL          → medición en vivo y fresca (telemetría del gateway)
//   STALE         → era REAL pero dejó de actualizarse (dato viejo)
//   NOT_CONNECTED → no hay fuente: el dato NO existe (se muestra "No disponible")
//   CONFIGURED    → valor de configuración conocido, NO medido (p.ej. carrera gripper)
//   DEMO          → dato sintético del modo demostración (NO es real)
export type DataSource = 'REAL' | 'STALE' | 'NOT_CONNECTED' | 'CONFIGURED' | 'DEMO';

export type ScadaMode = 'REAL' | 'DEMO';

// Salud del enlace de una fuente (cobot WS / PLC io).
export interface LinkState {
  state: DataSource;        // REAL / STALE / NOT_CONNECTED / DEMO
  connected: boolean;       // hay socket abierto
  ageS: number | null;      // segundos desde el último frame (null = nunca llegó)
}

export interface Tag {
  name: string;
  value: number | boolean | string | null;   // null = no disponible
  unit?: string;
  source: DataSource;
}

// Ciclo de vida de una alarma (CAMBIO 4):
//   ACTIVE       → condición presente, sin reconocer.
//   ACKNOWLEDGED → operador la reconoció (la condición puede seguir presente).
//   RESOLVED     → operador la cerró Y la condición ya NO está presente.
export type AlarmStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface Alarm {
  id: string;             // estable por código (para ack y dedupe)
  code: string;
  message: string;
  severity: Severity;
  station: string;
  raisedAt: number;       // timestamp interno (s) — primera vez activa
  durationS: number;
  // `active` = la condición real sigue presente AHORA (sourceRealCondition).
  active: boolean;
  status: AlarmStatus;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
  operatorComment: string | null;
  demo?: boolean;         // true si la alarma proviene de datos DEMO (no reales)
}

// Entrada del historial de mantenimiento (acciones reales del operador / IA).
export interface MaintLogEntry {
  id: string;
  at: number;             // reloj interno (s)
  by: string;             // 'Operador' | 'IA'
  kind: 'COMMENT' | 'ACK' | 'RESOLVE';
  text: string;
  alarmCode: string | null;   // alarma asociada (o null = comentario general)
}

// Historial ligero para gráficas (memoria acotada) — CAMBIO 13.
export interface ScadaHistory {
  conveyorOnDurations: number[];                  // últimos 10 ON-times (s), nuevo al final
  conveyorOnTime: { t: number; v: number }[];     // tiempo encendido EN VIVO (s) — sube/baja
  controllerTemps: { t: number; v: number }[];    // últimos N (s, °C)
  jointTemps: { t: number; temps: number[] }[];   // últimos N (s, [J1..J6] °C)
  cycleTimes: number[];                           // últimos 10 tiempos de ciclo (s) — vacío en REAL sin enlace
}

// Una señal en la matriz de I/O (CAMBIO 11).
export interface IoSignal {
  key: string;            // id técnico (tag)
  label: string;          // nombre legible
  group: 'COBOT' | 'PLC';
  kind: 'INPUT' | 'OUTPUT';
  value: boolean | number | string | null;   // null = no disponible
  source: DataSource;
  ageS: number | null;    // edad del dato en s (null = sin dato)
}

export interface JointHealth {
  index: number;
  angleDeg: number;
  tempC: number;
  currentA: number;
}

export interface CobotHealthSnap {
  available: boolean;     // hay telemetría de cobot (REAL/STALE/DEMO)
  source: DataSource;
  controllerTempC: number | null;
  avgPowerW: number | null;
  avgCurrentA: number | null;
  speedMagnificationPct: number | null;
  joints: JointHealth[];
  maxJointTempC: number | null;
  maxJointTempJoint: number | null;   // índice (1..6) del joint más caliente (null = sin datos)
  tcp: {
    xMm: number; yMm: number; zMm: number;
    rxDeg: number; ryDeg: number; rzDeg: number;
  } | null;
  ft: {
    fxN: number; fyN: number; fzN: number;
    txNm: number; tyNm: number; tzNm: number;
  } | null;
  flags: {
    estop: boolean; protectiveStop: boolean; enabled: boolean; moving: boolean;
    softLimit: boolean; collision: boolean; motionErr: number; powerOn: boolean;
  };
}

// Producción REAL del gateway (bloque hmi: COUNT.* + CAMERA_STATUS). NO es fake:
// proviene del pipeline real de la celda. Si no llega → available=false / null.
export interface ProductionSnap {
  available: boolean;
  source: DataSource;
  total: number | null;
  accepted: number | null;
  rejected: number | null;
  yieldPct: number | null;                         // aceptados / total * 100
  cameraStatus: 'READY' | 'PASS' | 'FAIL' | null;  // último estado de la cámara (texto)
}

// Conveyor: SOLO tiempo encendido (sin temperatura estimada) — CAMBIO 5.
export interface ConveyorSnap {
  signalAvailable: boolean;        // existe conveyor_motor_on (real o demo)
  motorOn: boolean | null;
  onTimeS: number;                 // tiempo encendido continuo
  warning: 'NONE' | 'WARNING' | 'ALARM';
  source: DataSource;
}

// Un ítem de mantenimiento accionable (CAMBIO 12).
export interface MaintItem {
  label: string;
  value: string;
  source: DataSource;
  status: 'OK' | 'WARNING' | 'ALARM' | 'NA';
}

export interface MaintChecklistItem { label: string; done: boolean; }

export interface OverviewSnap {
  plantState: 'NOMINAL' | 'WARNING' | 'ALARM' | 'CRITICAL' | 'OFFLINE';
  stage: string | null;            // etapa del ciclo (null = sin enlace FSM/ciclo en REAL)
  activeCafiId: number | null;     // null = no disponible
  cobot: { connected: boolean; enabled: boolean; moving: boolean; fault: boolean };
  plcConnected: boolean;
  activeAlarms: number;
  worstSeverity: Severity | null;  // peor severidad ENTRE las alarmas activas (null = ninguna)
  conveyorWarning: string | null;  // texto si aplica
  // Progreso / tiempo de ciclo. En REAL se DERIVAN de las señales reales (telemetry.io
  // + cobot) cuando hay enlace; null sólo si no hay ninguna señal (NOT_CONNECTED).
  cycleStep: number | null;
  cycleTotal: number | null;
  cycleTimeS: number | null;       // tiempo del ciclo en curso / último ciclo
  avgCycleTimeS: number | null;    // promedio de los últimos 10 ciclos (null = sin historial)
  stageEstimated: boolean;         // true = etapa/progreso inferidos de señales reales de I/O (no FSM)
  cycleRunning: boolean;           // true = hay un ciclo en curso (timer corriendo)
  cafiTotal: number;               // CAFIs detectados (acumulado)
  cafiInProcess: number;           // CAFIs activos en la celda ahora
  cafiAccepted: number;            // CAFIs aceptados (tracker)
  cafiRejected: number;            // CAFIs rechazados (tracker)
  cafiOverCapacity: boolean;       // >8 CAFIs en planta → recoger de la mesa
}

export interface AiBackendHealth {
  state: 'CONFIGURED' | 'NOT_CONFIGURED' | 'NOT_CONNECTED' | 'UNKNOWN';
  model: string | null;
}

export interface ScadaSnapshot {
  ts: number;
  mode: ScadaMode;
  cobotLink: LinkState;
  plcLink: LinkState;
  overview: OverviewSnap;
  io: IoSignal[];
  alarms: Alarm[];
  cobot: CobotHealthSnap;
  conveyor: ConveyorSnap;
  production: ProductionSnap;   // COUNT.* + CAMERA_STATUS del gateway (real)
  maintenance: { items: MaintItem[]; checklist: MaintChecklistItem[] };
  maintenanceLog: MaintLogEntry[];   // historial real de comentarios/acciones del operador
  history: ScadaHistory;             // series para gráficas (conveyor, joints, controlador)
  cafis: CafiTrack[];                // seguimiento por CAFI (inferido de señales)
  tags: Tag[];   // tabla avanzada (todas las señales con dato) — solo modo debug
}

// Respuesta del asistente de IA (OpenAI o mock local).
export interface AiDiagnosis {
  source: 'AI' | 'MOCK';
  probableFault: string;
  severity: Severity;
  suspectComponent: string;
  recommendedAction: string;
  maintenanceMessage: string;
  checklist: string[];
  canKeepOperating: boolean;
  evidence: string[];
}

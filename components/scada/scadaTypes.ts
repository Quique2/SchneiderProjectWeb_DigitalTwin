// ─────────────────────────────────────────────────────────────────────────────
// scadaTypes.ts — Tipos del módulo SCADA (solo tipos, sin runtime).
// ─────────────────────────────────────────────────────────────────────────────

export type Severity = 'INFO' | 'WARNING' | 'ALARM' | 'CRITICAL';

export type DataSource = 'REAL' | 'SIM' | 'ESTIMATED' | 'CONFIGURED';

export interface Tag {
  name: string;
  value: number | boolean | string;
  unit?: string;
  source: DataSource;     // REAL / SIM(mock) / ESTIMATED / CONFIGURED(no medido)
  good?: boolean;         // calidad OPC-like (true = OK)
}

export interface Alarm {
  id: string;             // estable por código (para ack y dedupe)
  code: string;           // fault_code
  message: string;        // fault_message
  severity: Severity;
  station: string;
  raisedAt: number;       // timestamp ms (primera vez activa)
  durationS: number;      // segundos activa
  acknowledged: boolean;
  active: boolean;
}

export interface OverviewSnap {
  plantState: string;     // RUNNING / IDLE / PAUSED / FAULT…
  stage: string;          // etapa actual
  activeCafiId: number | null;
  totalProduced: number;
  accepted: number;
  rejected: number;
  cycleTimeS: number;
  availabilityPct: number;
  activeFaults: number;
  mode: 'SIM' | 'REAL';
}

export interface JointHealth {
  index: number;
  angleDeg: number;
  tempC: number;
  currentA: number;
}

export interface CobotHealthSnap {
  controllerTempC: number;
  avgPowerW: number;
  avgCurrentA: number;
  speedMagnificationPct: number;
  joints: JointHealth[];
  tcp: {
    xMm: number; yMm: number; zMm: number;
    rxDeg: number; ryDeg: number; rzDeg: number;
    targetPoseName: string;
    positionErrorMm: number;
    orientationErrorDeg: number;
  };
  ft: {
    fxN: number; fyN: number; fzN: number;
    txNm: number; tyNm: number; tzNm: number;
  };
}

export interface ConveyorSnap {
  motorOn: boolean;
  runningTimeCurrentCycleS: number;
  runningTimeTotalS: number;
  dutyCycle5minPct: number;
  dutyCycle15minPct: number;
  stopReason: string;
  sensorPresent: boolean;
  waitAfterPickTimerS: number;
  cafisWaitingCount: number;
  motorTempC: number;         // ESTIMADA por duty cycle (o REAL si hubiera sensor)
  motorTempSource: DataSource;
  starts: number;
}

export interface TurntableSnap {
  position: 'HOME' | 'WORK' | 'MOVING';
  angleDeg: number;
  target: 'HOME' | 'WORK';
  motorRunning: boolean;
  moveTimeS: number;
  homeLimit: boolean;
  workLimit: boolean;
  indexCount: number;
  homeHitCount: number;
  workHitCount: number;
  failedHomeCount: number;
  failedWorkCount: number;
  lastMoveDurationS: number;
  nominalMoveDurationS: number;
  cyclesSinceMaintenance: number;
}

export interface GripperSnap {
  airPressureBar: number;
  pressureSource: DataSource; // CONFIGURED si no hay sensor real
  command: 'OPEN' | 'CLOSE';
  state: 'OPEN' | 'CLOSED' | 'UNKNOWN';
  closeTimeMs: number;
  openTimeMs: number;
  cycleCount: number;
  faultCount: number;
  pressureLow: boolean;
  pressureHigh: boolean;
  strokeCm: number;
}

export interface FixtureSnap {
  id: 1 | 2;
  present: boolean;
  cafiId: number | null;
  state: 'EMPTY' | 'LOADED' | 'RIVETING' | 'RIVETED';
  insertCount: number;
  switchCycles: number;
}

export interface SensorSnap {
  name: string;
  state: boolean;
  blockedTimeS: number;
  triggerCount: number;
}

export interface CameraSnap {
  triggerCount: number;
  inspectionCount: number;
  passCount: number;
  failCount: number;
  noReadCount: number;
  lastResult: 'PASS' | 'FAIL' | 'NO_READ' | '—';
  lastInspectionTimeMs: number;
  avgInspectionTimeMs: number;
  maxInspectionTimeMs: number;
  commStatus: 'ONLINE' | 'OFFLINE' | 'ERROR';
  errorCode: string;
  storageUsedMb: number;
  savedImagesCount: number;
  triggerRatePerHour: number;
}

export interface MaintenanceSnap {
  conveyorMotorHours: number;
  conveyorStarts: number;
  conveyorDutyCyclePct: number;
  turntableCycles: number;
  homeLimitHits: number;
  workLimitHits: number;
  fixture1SwitchCycles: number;
  fixture2SwitchCycles: number;
  gripperCycles: number;
  cameraTriggerCount: number;
  cameraInspectionCount: number;
  jointTemps: number[];
}

export interface QualitySnap {
  passCount: number;
  failCount: number;
  rejectRatePct: number;
  lastResult: 'PASS' | 'FAIL' | '—';
  cameraProcessingMs: number;
  noReadCount: number;
}

export interface IoSnap {
  inputs: Tag[];
  outputs: Tag[];
}

export interface ScadaSnapshot {
  ts: number;
  mode: 'SIM' | 'REAL';
  overview: OverviewSnap;
  io: IoSnap;
  alarms: Alarm[];
  maintenance: MaintenanceSnap;
  quality: QualitySnap;
  cobot: CobotHealthSnap;
  conveyor: ConveyorSnap;
  turntable: TurntableSnap;
  gripper: GripperSnap;
  fixtures: FixtureSnap[];
  sensors: SensorSnap[];
  camera: CameraSnap;
  tags: Tag[];   // tabla plana de TODOS los tags (para la "tabla de tags")
}

// Respuesta del asistente de IA (Gemini o mock).
export interface AiDiagnosis {
  source: 'GEMINI' | 'MOCK';
  probableFault: string;
  severity: Severity;
  suspectComponent: string;
  recommendedAction: string;
  maintenanceMessage: string;
  checklist: string[];
  canKeepOperating: boolean;
  evidence: string[];
}

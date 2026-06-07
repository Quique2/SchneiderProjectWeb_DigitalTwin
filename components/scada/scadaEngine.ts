// ─────────────────────────────────────────────────────────────────────────────
// scadaEngine.ts — Motor SCADA (independiente de la FSM / Celda 3D / Cobot real).
//
// Corre una simulación COHERENTE de la celda (marcada SIM/MOCK) para alimentar el
// dashboard, las alarmas y el snapshot de IA SIN tocar la lógica real. Si en el
// futuro llegan datos reales (gateway/controlador), se reemplazan los `feed*()`
// por lecturas reales y el resto del módulo no cambia.
//
// API: createScadaEngine() → { tick(dt), snapshot(), acknowledge(id), thresholds }.
// ─────────────────────────────────────────────────────────────────────────────

import { SCADA_THRESHOLDS } from './scadaConfig';
import type {
  Alarm, ScadaSnapshot, Severity, Tag, DataSource, FixtureSnap, SensorSnap,
} from './scadaTypes';

const T = SCADA_THRESHOLDS;

// Etapas del ciclo simulado (espejo simplificado de la celda real).
type Stage =
  | 'IDLE' | 'CONVEYOR_FEED' | 'PICK_CONVEYOR' | 'PLACE_FIXTURE'
  | 'INDEX_TO_WORK' | 'RIVET' | 'INDEX_TO_HOME' | 'PICK_RIVETED'
  | 'PLACE_CAMERA' | 'INSPECT' | 'PICK_CAMERA' | 'PLACE_BIN';

const STAGE_LABEL: Record<Stage, string> = {
  IDLE: 'En espera', CONVEYOR_FEED: 'Alimentando banda', PICK_CONVEYOR: 'Pick conveyor',
  PLACE_FIXTURE: 'Place fixture', INDEX_TO_WORK: 'Mesa → WORK', RIVET: 'Remachando',
  INDEX_TO_HOME: 'Mesa → HOME', PICK_RIVETED: 'Pick remachado', PLACE_CAMERA: 'Place cámara',
  INSPECT: 'Inspección', PICK_CAMERA: 'Pick cámara', PLACE_BIN: 'Place bin',
};

// Joints semilla (CAMBIO 9: datos actuales del controlador).
const JOINT_SEED = [
  { angle: 177.40, temp: 42, amp: -0.1 },
  { angle: 107.60, temp: 42, amp: 0.5 },
  { angle: -108.90, temp: 41, amp: 0.9 },
  { angle: 93.30, temp: 46, amp: 0.1 },
  { angle: 90.60, temp: 47, amp: 0.0 },
  { angle: -93.80, temp: 50, amp: 0.0 },
];

const RIVET_DURATION_S = 30;

interface EngineState {
  clock: number;
  stage: Stage;
  stageT: number;
  cafiSeq: number;
  activeCafiId: number | null;

  // producción
  totalProduced: number;
  accepted: number;
  rejected: number;
  lastCycleTimeS: number;
  cycleStartClock: number;
  runningSinceClock: number;

  // conveyor
  convOn: boolean;
  convRunCurrentS: number;
  convRunTotalS: number;
  convOnAccum: number;       // para duty (EMA)
  convDuty5: number;
  convDuty15: number;
  convStarts: number;
  convStopReason: string;
  convWaitAfterPickS: number;
  convCafisWaiting: number;
  convSensor: boolean;
  convSensorBlockedS: number;
  convSensorTriggers: number;

  // turntable
  ttPos: 'HOME' | 'WORK' | 'MOVING';
  ttAngle: number;
  ttTarget: 'HOME' | 'WORK';
  ttMoving: boolean;
  ttMoveT: number;
  ttIndexCount: number;
  ttHomeHits: number;
  ttWorkHits: number;
  ttFailedHome: number;
  ttFailedWork: number;
  ttLastMoveDur: number;
  ttNominalDur: number;
  ttCyclesSinceMaint: number;

  // gripper
  airBar: number;
  gripCmd: 'OPEN' | 'CLOSE';
  gripState: 'OPEN' | 'CLOSED' | 'UNKNOWN';
  gripCloseMs: number;
  gripOpenMs: number;
  gripCycles: number;
  gripFaults: number;

  // fixtures
  fx: { present: boolean; cafiId: number | null; state: FixtureSnap['state']; inserts: number; switchCycles: number }[];

  // sensores
  camSensor: boolean;
  camSensorBlockedS: number;
  camSensorTriggers: number;

  // cámara
  camTriggers: number;
  camInspections: number;
  camPass: number;
  camFail: number;
  camNoRead: number;
  camLast: 'PASS' | 'FAIL' | 'NO_READ' | '—';
  camLastMs: number;
  camAvgMs: number;
  camMaxMs: number;
  camStorageMb: number;
  camSavedImages: number;
  camComm: 'ONLINE' | 'OFFLINE' | 'ERROR';

  // cobot
  speedMagPct: number;
  ctrlTempC: number;
  ctrlAvgCurrentA: number;
  ctrlAvgPowerW: number;
  jointTempC: number[];
  jointAmpA: number[];
  jointAngleDeg: number[];
  tcpErrMm: number;
  tcpOriErrDeg: number;
  eeForceN: [number, number, number];
  eeTorqueNm: [number, number, number];

  // alarmas
  alarms: Map<string, Alarm>;
}

function rnd(a: number, b: number): number { return a + Math.random() * (b - a); }

export interface ScadaEngine {
  tick: (dt: number) => void;
  snapshot: () => ScadaSnapshot;
  acknowledge: (id: string) => void;
  acknowledgeAll: () => void;
  thresholds: typeof SCADA_THRESHOLDS;
}

export function createScadaEngine(): ScadaEngine {
  const s: EngineState = {
    clock: 0, stage: 'CONVEYOR_FEED', stageT: 0, cafiSeq: 1, activeCafiId: 1,
    totalProduced: 128, accepted: 109, rejected: 19, lastCycleTimeS: 74, cycleStartClock: 0, runningSinceClock: 0,
    convOn: true, convRunCurrentS: 0, convRunTotalS: 51_300, convOnAccum: 0.42, convDuty5: 64, convDuty15: 58,
    convStarts: 642, convStopReason: '—', convWaitAfterPickS: 0, convCafisWaiting: 1, convSensor: false,
    convSensorBlockedS: 0, convSensorTriggers: 642,
    ttPos: 'HOME', ttAngle: 0, ttTarget: 'HOME', ttMoving: false, ttMoveT: 0, ttIndexCount: 4218,
    ttHomeHits: 2110, ttWorkHits: 2108, ttFailedHome: 1, ttFailedWork: 0, ttLastMoveDur: 2.4, ttNominalDur: 2.4,
    ttCyclesSinceMaint: 1218,
    airBar: T.pressureNominalBar, gripCmd: 'OPEN', gripState: 'OPEN', gripCloseMs: 240, gripOpenMs: 220,
    gripCycles: 1284, gripFaults: 2,
    fx: [
      { present: false, cafiId: null, state: 'EMPTY', inserts: 2109, switchCycles: 4221 },
      { present: false, cafiId: null, state: 'EMPTY', inserts: 2107, switchCycles: 4216 },
    ],
    camSensor: false, camSensorBlockedS: 0, camSensorTriggers: 230,
    camTriggers: 230, camInspections: 230, camPass: 196, camFail: 30, camNoRead: 4, camLast: 'PASS',
    camLastMs: 420, camAvgMs: 410, camMaxMs: 980, camStorageMb: 512, camSavedImages: 230, camComm: 'ONLINE',
    speedMagPct: 100, ctrlTempC: 32.0, ctrlAvgCurrentA: 0, ctrlAvgPowerW: 0,
    jointTempC: JOINT_SEED.map((j) => j.temp),
    jointAmpA: JOINT_SEED.map((j) => j.amp),
    jointAngleDeg: JOINT_SEED.map((j) => j.angle),
    tcpErrMm: 1.2, tcpOriErrDeg: 0.4,
    eeForceN: [0, 0, 0], eeTorqueNm: [0, 0, 0],
    alarms: new Map(),
  };

  // ── Avance del ciclo simulado ──────────────────────────────────────────────
  function advanceCycle(dt: number): void {
    s.stageT += dt;
    const moving = s.stage !== 'IDLE' && s.stage !== 'RIVET' && s.stage !== 'INSPECT';
    // conveyor on sólo cuando alimenta
    s.convOn = s.stage === 'CONVEYOR_FEED';
    s.convStopReason = s.convOn ? '—' : (s.stage === 'RIVET' ? 'Remachando' : 'Cobot ocupado');
    s.ttMoving = s.stage === 'INDEX_TO_WORK' || s.stage === 'INDEX_TO_HOME';
    s.ttPos = s.ttMoving ? 'MOVING' : (s.ttTarget === 'WORK' ? 'WORK' : 'HOME');

    // joints: corriente sube en movimiento
    for (let i = 0; i < 6; i++) {
      const base = JOINT_SEED[i].amp;
      s.jointAmpA[i] = moving ? base + rnd(0.2, 1.1) : base + rnd(-0.05, 0.05);
      s.jointAngleDeg[i] = JOINT_SEED[i].angle + (moving ? rnd(-3, 3) : rnd(-0.2, 0.2));
      // temperatura deriva lentamente hacia equilibrio (sube con trabajo)
      const target = JOINT_SEED[i].temp + (moving ? 2.5 : 0);
      s.jointTempC[i] += (target - s.jointTempC[i]) * Math.min(1, dt * 0.05);
    }
    s.ctrlTempC += (32 + (moving ? 1.5 : 0) - s.ctrlTempC) * Math.min(1, dt * 0.05);
    updateLoadMetrics(moving);

    switch (s.stage) {
      case 'CONVEYOR_FEED':
        s.convRunCurrentS += dt; s.convRunTotalS += dt;
        s.convCafisWaiting = 1; s.convSensor = s.stageT > 2.2;
        if (s.convSensor) { s.convSensorBlockedS += dt; } else { s.convSensorBlockedS = 0; }
        if (s.stageT > 3.0) { s.convSensorTriggers++; nextStage('PICK_CONVEYOR'); s.convStarts++; }
        break;
      case 'PICK_CONVEYOR':
        gripperClose();
        if (s.stageT > 2.0) { s.convCafisWaiting = 0; s.convSensor = false; s.convSensorBlockedS = 0; nextStage('PLACE_FIXTURE'); }
        break;
      case 'PLACE_FIXTURE': {
        const fi = s.ttTarget === 'WORK' ? 1 : 0;
        if (s.stageT > 2.4) {
          gripperOpen();
          s.fx[fi].present = true; s.fx[fi].cafiId = s.activeCafiId; s.fx[fi].state = 'LOADED';
          s.fx[fi].inserts++; s.fx[fi].switchCycles += 2;
          nextStage('INDEX_TO_WORK');
        }
        break;
      }
      case 'INDEX_TO_WORK':
        s.ttMoveT += dt; s.ttAngle = Math.min(180, s.ttAngle + (180 / s.ttNominalDur) * dt);
        if (s.ttAngle >= 180 || s.stageT > s.ttNominalDur) { settleTable('WORK'); s.fx[0].state = 'RIVETING'; nextStage('RIVET'); }
        break;
      case 'RIVET':
        s.fx[0].state = 'RIVETING';
        if (s.stageT > RIVET_DURATION_S * 0.12) { s.fx[0].state = 'RIVETED'; nextStage('INDEX_TO_HOME'); } // acelerado para demo
        break;
      case 'INDEX_TO_HOME':
        s.ttMoveT += dt; s.ttAngle = Math.max(0, s.ttAngle - (180 / s.ttNominalDur) * dt);
        if (s.ttAngle <= 0 || s.stageT > s.ttNominalDur) { settleTable('HOME'); nextStage('PICK_RIVETED'); }
        break;
      case 'PICK_RIVETED':
        gripperClose();
        if (s.stageT > 2.0) { s.fx[0].present = false; s.fx[0].cafiId = null; s.fx[0].state = 'EMPTY'; s.fx[0].switchCycles += 2; nextStage('PLACE_CAMERA'); }
        break;
      case 'PLACE_CAMERA':
        if (s.stageT > 2.0) { gripperOpen(); s.camSensor = true; nextStage('INSPECT'); }
        break;
      case 'INSPECT': {
        s.camSensorBlockedS += dt;
        if (s.stageT > 1.0) {
          const ms = rnd(360, 620);
          s.camTriggers++; s.camInspections++; s.camSensorTriggers++; s.camSavedImages++;
          s.camStorageMb += rnd(1.5, 2.5);
          s.camLastMs = ms; s.camAvgMs = s.camAvgMs * 0.9 + ms * 0.1; s.camMaxMs = Math.max(s.camMaxMs, ms);
          const pass = Math.random() < 0.84;
          if (pass) { s.camPass++; s.camLast = 'PASS'; } else { s.camFail++; s.camLast = 'FAIL'; }
          nextStage('PICK_CAMERA');
        }
        break;
      }
      case 'PICK_CAMERA':
        gripperClose();
        if (s.stageT > 1.6) { s.camSensor = false; s.camSensorBlockedS = 0; nextStage('PLACE_BIN'); }
        break;
      case 'PLACE_BIN':
        if (s.stageT > 1.8) {
          gripperOpen();
          s.totalProduced++;
          if (s.camLast === 'PASS') s.accepted++; else s.rejected++;
          s.lastCycleTimeS = s.clock - s.cycleStartClock;
          s.cycleStartClock = s.clock;
          s.cafiSeq++; s.activeCafiId = s.cafiSeq;
          nextStage('CONVEYOR_FEED');
        }
        break;
      default:
        nextStage('CONVEYOR_FEED');
    }
  }

  // Métricas de carga del controlador / TCP / F-T derivadas del movimiento.
  function updateLoadMetrics(moving: boolean): void {
    const amps = s.jointAmpA.reduce((a, b) => a + Math.abs(b), 0);
    s.eeForceN = moving ? [rnd(-2, 2), rnd(-2, 2), rnd(-3, 1)] : [0, 0, 0];
    s.eeTorqueNm = moving ? [rnd(-0.4, 0.4), rnd(-0.4, 0.4), rnd(-0.3, 0.3)] : [0, 0, 0];
    s.tcpErrMm = moving ? rnd(0.6, 2.4) : rnd(0.2, 1.0);
    s.tcpOriErrDeg = moving ? rnd(0.2, 1.0) : rnd(0.05, 0.4);
    s.ctrlAvgCurrentA = amps / 6;
    s.ctrlAvgPowerW = s.ctrlAvgCurrentA * 48; // ~48V bus
  }

  function nextStage(st: Stage): void { s.stage = st; s.stageT = 0; }
  function settleTable(t: 'HOME' | 'WORK'): void {
    s.ttMoving = false; s.ttTarget = t; s.ttPos = t; s.ttMoveT = 0;
    s.ttAngle = t === 'WORK' ? 180 : 0;
    s.ttIndexCount++; s.ttCyclesSinceMaint++;
    s.ttLastMoveDur = s.ttNominalDur + rnd(-0.15, 0.25);
    if (t === 'HOME') s.ttHomeHits++; else s.ttWorkHits++;
  }
  function gripperClose(): void {
    if (s.gripState !== 'CLOSED') { s.gripState = 'CLOSED'; s.gripCmd = 'CLOSE'; s.gripCycles++; s.gripCloseMs = rnd(200, 320); }
  }
  function gripperOpen(): void {
    if (s.gripState !== 'OPEN') { s.gripState = 'OPEN'; s.gripCmd = 'OPEN'; s.gripOpenMs = rnd(190, 300); }
  }

  // ── Duty cycle (EMA sobre on/off) ──────────────────────────────────────────
  function updateDuty(dt: number): void {
    const on = s.convOn ? 1 : 0;
    const a5 = Math.min(1, dt / 60);   // ventana ~5 min aproximada (acelerada)
    const a15 = Math.min(1, dt / 180);
    s.convDuty5 = s.convDuty5 * (1 - a5) + on * 100 * a5;
    s.convDuty15 = s.convDuty15 * (1 - a15) + on * 100 * a15;
    s.airBar = T.pressureNominalBar; // CONFIGURADA (no medida)
  }

  // temperatura estimada del motor del conveyor por duty cycle (sin sensor real)
  function convMotorTempEstimated(): number {
    return 28 + (s.convDuty5 / 100) * 28 + Math.min(20, s.convRunCurrentS * 0.4);
  }

  // ── Alarmas ────────────────────────────────────────────────────────────────
  function raise(code: string, severity: Severity, station: string, message: string): void {
    const ex = s.alarms.get(code);
    if (ex) { ex.active = true; ex.severity = severity; ex.message = message; ex.durationS = (s.clock - ex.raisedAt) / 1; }
    else s.alarms.set(code, { id: code, code, severity, station, message, raisedAt: s.clock, durationS: 0, acknowledged: false, active: true });
  }
  function clear(code: string): void {
    const ex = s.alarms.get(code);
    if (ex) { if (ex.acknowledged) s.alarms.delete(code); else { ex.active = false; } }
  }
  function rule(code: string, cond: boolean, sev: Severity, station: string, msg: string): void {
    if (cond) raise(code, sev, station, msg); else clear(code);
  }

  function evaluateAlarms(): void {
    const convT = convMotorTempEstimated();
    // Conveyor
    rule('CNV_ON_WARN', s.convRunCurrentS > T.conveyorMaxOnTimeWarningS && s.convRunCurrentS <= T.conveyorMaxOnTimeAlarmS, 'WARNING', 'Conveyor', `Motor encendido ${s.convRunCurrentS.toFixed(0)}s continuos`);
    rule('CNV_ON_ALARM', s.convRunCurrentS > T.conveyorMaxOnTimeAlarmS, 'ALARM', 'Conveyor', `Motor encendido ${s.convRunCurrentS.toFixed(0)}s continuos (>${T.conveyorMaxOnTimeAlarmS}s)`);
    rule('CNV_DUTY_WARN', s.convDuty5 > T.conveyorDutyWarningPct && s.convDuty5 <= T.conveyorDutyAlarmPct, 'WARNING', 'Conveyor', `Duty cycle ${s.convDuty5.toFixed(0)}% (>${T.conveyorDutyWarningPct}%)`);
    rule('CNV_DUTY_ALARM', s.convDuty5 > T.conveyorDutyAlarmPct, 'ALARM', 'Conveyor', `Duty cycle ${s.convDuty5.toFixed(0)}% (>${T.conveyorDutyAlarmPct}%) — posible sobrecalentamiento`);
    rule('CNV_SENSOR_BLOCK', s.convSensorBlockedS > T.conveyorSensorBlockedAlarmS, 'ALARM', 'Conveyor', `Sensor de banda bloqueado ${s.convSensorBlockedS.toFixed(0)}s`);
    rule('CNV_CAFI_STUCK', s.convOn && s.convRunCurrentS > T.conveyorCafiStuckAlarmS, 'ALARM', 'Conveyor', 'Posible CAFI atorado en la banda');
    rule('CNV_TEMP_EST', convT > 60, 'WARNING', 'Conveyor', `Temp. estimada motor ${convT.toFixed(0)}°C (estimada)`);

    // Turntable
    rule('TT_MOVE_TIMEOUT', s.ttMoving && s.ttMoveT > T.turntableMoveTimeoutS, 'ALARM', 'Mesa rotatoria', `Mesa no llegó a ${s.ttTarget} en ${T.turntableMoveTimeoutS}s`);
    rule('TT_TIME_DRIFT', s.ttLastMoveDur > s.ttNominalDur * (1 + T.turntableTimeDriftWarningPct / 100), 'WARNING', 'Mesa rotatoria', `Tiempo de giro +${(((s.ttLastMoveDur / s.ttNominalDur) - 1) * 100).toFixed(0)}%`);
    rule('TT_HITS_WARN', (s.ttHomeHits + s.ttWorkHits) > T.turntableHitsWarningCount, 'WARNING', 'Mesa rotatoria', 'Demasiados golpes acumulados en limit switches');
    rule('TT_BOTH_LIMITS', !s.ttMoving && s.ttPos === 'WORK' && s.ttAngle === 0, 'ALARM', 'Mesa rotatoria', 'Ambos limit switches activos (inconsistente)');
    rule('TT_NO_LIMIT', false, 'ALARM', 'Mesa rotatoria', 'Ningún limit activo tras giro');

    // Gripper
    rule('GRP_P_LOW_WARN', s.airBar < T.pressureMinWarningBar && s.airBar >= T.pressureMinAlarmBar, 'WARNING', 'Gripper', `Presión ${s.airBar.toFixed(1)} bar (<${T.pressureMinWarningBar})`);
    rule('GRP_P_LOW_ALARM', s.airBar < T.pressureMinAlarmBar, 'ALARM', 'Gripper', `Presión ${s.airBar.toFixed(1)} bar (<${T.pressureMinAlarmBar})`);
    rule('GRP_P_HIGH_WARN', s.airBar > T.pressureMaxWarningBar, 'WARNING', 'Gripper', `Presión ${s.airBar.toFixed(1)} bar (>${T.pressureMaxWarningBar})`);
    rule('GRP_CLOSE_TO', s.gripCloseMs > T.gripperCloseTimeoutMs, 'ALARM', 'Gripper', 'Gripper no cerró en tiempo máximo');
    rule('GRP_OPEN_TO', s.gripOpenMs > T.gripperOpenTimeoutMs, 'ALARM', 'Gripper', 'Gripper no abrió en tiempo máximo');
    rule('GRP_CLOSE_NOPRESS', s.gripCmd === 'CLOSE' && s.airBar < T.pressureMinAlarmBar, 'ALARM', 'Gripper', 'Comando CLOSE sin presión suficiente');

    // Sensores
    rule('SNS_CNV_BLOCK', s.convSensorBlockedS > T.sensorBlockedAlarmS, 'ALARM', 'Sensor conveyor', `Bloqueado ${s.convSensorBlockedS.toFixed(0)}s`);
    rule('SNS_CAM_NOPIECE', false, 'ALARM', 'Sensor cámara', 'No detecta CAFI tras place');

    // Fixtures
    rule('FX_NO_DETECT', false, 'ALARM', 'Fixtures', 'Fixture no detecta CAFI tras place');
    rule('FX_STILL_DETECT', false, 'ALARM', 'Fixtures', 'Fixture sigue detectando CAFI tras pick');
    rule('FX_BLOCK_PICK', s.fx[1].present && s.stage === 'CONVEYOR_FEED' && s.stageT > 8, 'ALARM', 'Fixtures', 'Fixture externo ocupado bloquea pick conveyor');

    // Cámara
    rule('CAM_OFFLINE', s.camComm !== 'ONLINE', 'ALARM', 'Cámara Datalogic', 'Cámara no responde');
    rule('CAM_INSP_TIMEOUT', s.camLastMs > T.cameraInspectionTimeoutS * 1000, 'ALARM', 'Cámara Datalogic', `Inspección ${(s.camLastMs / 1000).toFixed(1)}s (>${T.cameraInspectionTimeoutS}s)`);
    const failRate = s.camInspections > 0 ? (s.camFail / s.camInspections) * 100 : 0;
    rule('CAM_FAIL_RATE', failRate > T.cameraFailRateWarningPct, 'WARNING', 'Cámara Datalogic', `Tasa FAIL ${failRate.toFixed(0)}% (>${T.cameraFailRateWarningPct}%)`);
    rule('CAM_STORAGE', s.camStorageMb > T.cameraStorageWarningMb, 'WARNING', 'Cámara Datalogic', `Almacenamiento ${(s.camStorageMb / 1024).toFixed(1)} GB`);

    // Cobot — joints temp
    s.jointTempC.forEach((tc, i) => {
      const st = `Cobot J${i + 1}`;
      rule(`J${i + 1}_TEMP_CRIT`, tc > T.jointTempCriticalC, 'CRITICAL', st, `J${i + 1} temp ${tc.toFixed(0)}°C (>${T.jointTempCriticalC})`);
      rule(`J${i + 1}_TEMP_ALARM`, tc > T.jointTempAlarmC && tc <= T.jointTempCriticalC, 'ALARM', st, `J${i + 1} temp ${tc.toFixed(0)}°C (>${T.jointTempAlarmC})`);
      rule(`J${i + 1}_TEMP_WARN`, tc > T.jointTempWarningC && tc <= T.jointTempAlarmC, 'WARNING', st, `J${i + 1} temp ${tc.toFixed(0)}°C (>${T.jointTempWarningC})`);
    });
    const ftMag = Math.hypot(...s.eeForceN);
    rule('EE_FORCE_ALARM', ftMag > T.eeForceAlarmN, 'ALARM', 'Cobot TCP', `Fuerza EE ${ftMag.toFixed(0)} N (>${T.eeForceAlarmN})`);
    rule('EE_FORCE_WARN', ftMag > T.eeForceWarningN && ftMag <= T.eeForceAlarmN, 'WARNING', 'Cobot TCP', `Fuerza EE ${ftMag.toFixed(0)} N (>${T.eeForceWarningN})`);
    rule('TCP_ERR_ALARM', s.tcpErrMm > T.tcpPositionAlarmMm, 'ALARM', 'Cobot TCP', `Error TCP ${s.tcpErrMm.toFixed(1)} mm (>${T.tcpPositionAlarmMm})`);
    rule('TCP_ERR_WARN', s.tcpErrMm > T.tcpPositionWarningMm && s.tcpErrMm <= T.tcpPositionAlarmMm, 'WARNING', 'Cobot TCP', `Error TCP ${s.tcpErrMm.toFixed(1)} mm (>${T.tcpPositionWarningMm})`);

    // duración de alarmas activas
    s.alarms.forEach((a) => { if (a.active) a.durationS = (s.clock - a.raisedAt) / 1; });
  }

  function tick(dt: number): void {
    const d = Math.min(0.1, dt);
    s.clock += d;
    advanceCycle(d);
    updateDuty(d);
    if (!s.convOn) s.convRunCurrentS = Math.max(0, s.convRunCurrentS - d * 4); // enfría al apagar
    evaluateAlarms();
  }

  function acknowledge(id: string): void {
    const a = s.alarms.get(id);
    if (a) { a.acknowledged = true; if (!a.active) s.alarms.delete(id); }
  }
  function acknowledgeAll(): void { s.alarms.forEach((a) => { a.acknowledged = true; if (!a.active) s.alarms.delete(a.id); }); }

  // ── Snapshot ────────────────────────────────────────────────────────────────
  function tag(name: string, value: number | boolean | string, unit: string | undefined, source: DataSource, good = true): Tag {
    return { name, value, unit, source, good };
  }

  function snapshot(): ScadaSnapshot {
    const failRate = s.camInspections > 0 ? (s.camFail / s.camInspections) * 100 : 0;
    const availability = s.clock > 0 ? Math.max(0, 100 - (s.alarms.size * 2)) : 100;
    const convMotorTemp = convMotorTempEstimated();
    const ctrlAvgCurrent = s.ctrlAvgCurrentA;
    const ctrlAvgPower = s.ctrlAvgPowerW;

    const inputs: Tag[] = [
      tag('I_CONVEYOR_PHOTOEYE', s.convSensor, undefined, 'SIM'),
      tag('I_CAMERA_PHOTOEYE', s.camSensor, undefined, 'SIM'),
      tag('I_FIXTURE_1_PRESENT', s.fx[0].present, undefined, 'SIM'),
      tag('I_FIXTURE_2_PRESENT', s.fx[1].present, undefined, 'SIM'),
      tag('I_TABLE_HOME_LIMIT', !s.ttMoving && s.ttTarget === 'HOME', undefined, 'SIM'),
      tag('I_TABLE_WORK_LIMIT', !s.ttMoving && s.ttTarget === 'WORK', undefined, 'SIM'),
      tag('I_AIR_PRESSURE_OK', s.airBar >= T.pressureMinWarningBar, undefined, 'CONFIGURED'),
      tag('I_GRIPPER_OPEN', s.gripState === 'OPEN', undefined, 'SIM'),
      tag('I_GRIPPER_CLOSED', s.gripState === 'CLOSED', undefined, 'SIM'),
      tag('I_CAMERA_PASS', s.camLast === 'PASS', undefined, 'SIM'),
      tag('I_CAMERA_FAIL', s.camLast === 'FAIL', undefined, 'SIM'),
      tag('I_COBOT_READY', s.stage === 'IDLE' || s.stage === 'CONVEYOR_FEED', undefined, 'SIM'),
      tag('I_COBOT_MOVING', s.stage !== 'IDLE' && s.stage !== 'RIVET' && s.stage !== 'INSPECT', undefined, 'SIM'),
      tag('I_ESTOP', false, undefined, 'SIM'),
      tag('I_STOP', false, undefined, 'SIM'),
    ];
    const outputs: Tag[] = [
      tag('O_CONVEYOR_MOTOR', s.convOn, undefined, 'SIM'),
      tag('O_TABLE_STEP', s.ttMoving, undefined, 'SIM'),
      tag('O_TABLE_DIR', s.ttTarget === 'WORK', undefined, 'SIM'),
      tag('O_GRIPPER_OPEN', s.gripCmd === 'OPEN', undefined, 'SIM'),
      tag('O_GRIPPER_CLOSE', s.gripCmd === 'CLOSE', undefined, 'SIM'),
      tag('O_RIVET_START', s.stage === 'RIVET', undefined, 'SIM'),
      tag('O_CAMERA_TRIGGER', s.stage === 'INSPECT', undefined, 'SIM'),
      tag('O_STACKLIGHT_GREEN', s.alarms.size === 0, undefined, 'SIM'),
      tag('O_STACKLIGHT_YELLOW', hasSeverity('WARNING'), undefined, 'SIM'),
      tag('O_STACKLIGHT_RED', hasSeverity('ALARM') || hasSeverity('CRITICAL'), undefined, 'SIM'),
      tag('O_BUZZER', hasSeverity('CRITICAL'), undefined, 'SIM'),
    ];

    const fixtures: FixtureSnap[] = s.fx.map((f, i) => ({
      id: (i + 1) as 1 | 2, present: f.present, cafiId: f.cafiId, state: f.state,
      insertCount: f.inserts, switchCycles: f.switchCycles,
    }));
    const sensors: SensorSnap[] = [
      { name: 'sensor_conveyor', state: s.convSensor, blockedTimeS: s.convSensorBlockedS, triggerCount: s.convSensorTriggers },
      { name: 'sensor_camera', state: s.camSensor, blockedTimeS: s.camSensorBlockedS, triggerCount: s.camSensorTriggers },
    ];

    const cobotTags: Tag[] = [
      tag('controller_temperature_c', round1(s.ctrlTempC), '°C', 'SIM'),
      tag('controller_avg_power_w', round1(ctrlAvgPower), 'W', 'SIM'),
      tag('controller_avg_current_a', round2(ctrlAvgCurrent), 'A', 'SIM'),
      tag('controller_speed_magnification_percent', s.speedMagPct, '%', 'SIM'),
      ...s.jointAngleDeg.flatMap((ang, i) => [
        tag(`joint_${i + 1}_angle_deg`, round2(ang), '°', 'SIM'),
        tag(`joint_${i + 1}_temp_c`, round1(s.jointTempC[i]), '°C', 'SIM'),
        tag(`joint_${i + 1}_current_a`, round2(s.jointAmpA[i]), 'A', 'SIM'),
      ]),
      tag('tcp_x_mm', -279.88, 'mm', 'SIM'), tag('tcp_y_mm', -101.68, 'mm', 'SIM'), tag('tcp_z_mm', 279.70, 'mm', 'SIM'),
      tag('tcp_rx_deg', -179.53, '°', 'SIM'), tag('tcp_ry_deg', -2.04, '°', 'SIM'), tag('tcp_rz_deg', -178.80, '°', 'SIM'),
      tag('tcp_target_pose_name', poseForStage(s.stage), undefined, 'SIM'),
      tag('tcp_position_error_mm', round1(s.tcpErrMm), 'mm', 'SIM'),
      tag('tcp_orientation_error_deg', round1(s.tcpOriErrDeg), '°', 'SIM'),
      tag('ee_force_x_n', round1(s.eeForceN[0]), 'N', 'SIM'), tag('ee_force_y_n', round1(s.eeForceN[1]), 'N', 'SIM'), tag('ee_force_z_n', round1(s.eeForceN[2]), 'N', 'SIM'),
      tag('ee_torque_x_nm', round2(s.eeTorqueNm[0]), 'Nm', 'SIM'), tag('ee_torque_y_nm', round2(s.eeTorqueNm[1]), 'Nm', 'SIM'), tag('ee_torque_z_nm', round2(s.eeTorqueNm[2]), 'Nm', 'SIM'),
    ];

    const convTags: Tag[] = [
      tag('conveyor_motor_on', s.convOn, undefined, 'SIM'),
      tag('conveyor_running_time_current_cycle', round1(s.convRunCurrentS), 's', 'SIM'),
      tag('conveyor_running_time_total', Math.round(s.convRunTotalS), 's', 'SIM'),
      tag('conveyor_duty_cycle_5min', round1(s.convDuty5), '%', 'SIM'),
      tag('conveyor_duty_cycle_15min', round1(s.convDuty15), '%', 'SIM'),
      tag('conveyor_stop_reason', s.convStopReason, undefined, 'SIM'),
      tag('conveyor_sensor_present', s.convSensor, undefined, 'SIM'),
      tag('conveyor_wait_after_pick_timer', round1(s.convWaitAfterPickS), 's', 'SIM'),
      tag('conveyor_cafis_waiting_count', s.convCafisWaiting, undefined, 'SIM'),
      tag('conveyor_motor_temp_c', round1(convMotorTemp), '°C', 'ESTIMATED'),
    ];
    const ttTags: Tag[] = [
      tag('turntable_position', s.ttPos, undefined, 'SIM'), tag('turntable_angle_deg', round1(s.ttAngle), '°', 'SIM'),
      tag('turntable_target', s.ttTarget, undefined, 'SIM'), tag('turntable_motor_running', s.ttMoving, undefined, 'SIM'),
      tag('turntable_move_time', round1(s.ttMoveT), 's', 'SIM'),
      tag('turntable_home_limit', !s.ttMoving && s.ttTarget === 'HOME', undefined, 'SIM'),
      tag('turntable_work_limit', !s.ttMoving && s.ttTarget === 'WORK', undefined, 'SIM'),
      tag('turntable_index_count', s.ttIndexCount, undefined, 'SIM'),
      tag('turntable_home_hit_count', s.ttHomeHits, undefined, 'SIM'), tag('turntable_work_hit_count', s.ttWorkHits, undefined, 'SIM'),
      tag('turntable_failed_home_count', s.ttFailedHome, undefined, 'SIM'), tag('turntable_failed_work_count', s.ttFailedWork, undefined, 'SIM'),
      tag('turntable_last_move_duration', round2(s.ttLastMoveDur), 's', 'SIM'),
    ];
    const grpTags: Tag[] = [
      tag('air_pressure_bar', round1(s.airBar), 'bar', 'CONFIGURED'),
      tag('gripper_command', s.gripCmd, undefined, 'SIM'), tag('gripper_state', s.gripState, undefined, 'SIM'),
      tag('gripper_close_time_ms', Math.round(s.gripCloseMs), 'ms', 'SIM'), tag('gripper_open_time_ms', Math.round(s.gripOpenMs), 'ms', 'SIM'),
      tag('gripper_cycle_count', s.gripCycles, undefined, 'SIM'), tag('gripper_fault_count', s.gripFaults, undefined, 'SIM'),
      tag('pneumatic_pressure_low', s.airBar < T.pressureMinWarningBar, undefined, 'CONFIGURED'),
      tag('pneumatic_pressure_high', s.airBar > T.pressureMaxWarningBar, undefined, 'CONFIGURED'),
    ];
    const camTags: Tag[] = [
      tag('camera_trigger_count', s.camTriggers, undefined, 'SIM'), tag('camera_inspection_count', s.camInspections, undefined, 'SIM'),
      tag('camera_pass_count', s.camPass, undefined, 'SIM'), tag('camera_fail_count', s.camFail, undefined, 'SIM'),
      tag('camera_no_read_count', s.camNoRead, undefined, 'SIM'), tag('camera_last_result', s.camLast, undefined, 'SIM'),
      tag('camera_last_inspection_time_ms', Math.round(s.camLastMs), 'ms', 'SIM'), tag('camera_avg_inspection_time_ms', Math.round(s.camAvgMs), 'ms', 'SIM'),
      tag('camera_max_inspection_time_ms', Math.round(s.camMaxMs), 'ms', 'SIM'),
      tag('camera_comm_status', s.camComm, undefined, 'SIM'), tag('camera_error_code', '0x00', undefined, 'SIM'),
      tag('camera_storage_used_mb', round1(s.camStorageMb), 'MB', 'SIM'), tag('camera_saved_images_count', s.camSavedImages, undefined, 'SIM'),
      tag('camera_trigger_rate_per_hour', Math.round((s.camTriggers / Math.max(1, s.clock)) * 3600), '/h', 'SIM'),
    ];
    const fxTags: Tag[] = fixtures.flatMap((f) => [
      tag(`fixture_${f.id}_present`, f.present, undefined, 'SIM'),
      tag(`fixture_${f.id}_cafi_id`, f.cafiId ?? -1, undefined, 'SIM'),
      tag(`fixture_${f.id}_state`, f.state, undefined, 'SIM'),
      tag(`fixture_${f.id}_insert_count`, f.insertCount, undefined, 'SIM'),
      tag(`fixture_${f.id}_switch_cycles`, f.switchCycles, undefined, 'SIM'),
    ]);
    const snsTags: Tag[] = [
      tag('sensor_conveyor_state', s.convSensor, undefined, 'SIM'), tag('sensor_conveyor_blocked_time', round1(s.convSensorBlockedS), 's', 'SIM'),
      tag('sensor_conveyor_trigger_count', s.convSensorTriggers, undefined, 'SIM'),
      tag('sensor_camera_state', s.camSensor, undefined, 'SIM'), tag('sensor_camera_blocked_time', round1(s.camSensorBlockedS), 's', 'SIM'),
      tag('sensor_camera_trigger_count', s.camSensorTriggers, undefined, 'SIM'),
    ];

    const allTags = [...inputs, ...outputs, ...cobotTags, ...convTags, ...ttTags, ...grpTags, ...camTags, ...fxTags, ...snsTags];
    const alarmsArr = [...s.alarms.values()].sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || b.raisedAt - a.raisedAt);

    return {
      ts: s.clock, mode: 'SIM',
      overview: {
        plantState: s.alarms.size && hasSeverity('CRITICAL') ? 'FAULT' : (s.stage === 'IDLE' ? 'IDLE' : 'RUNNING'),
        stage: STAGE_LABEL[s.stage], activeCafiId: s.activeCafiId,
        totalProduced: s.totalProduced, accepted: s.accepted, rejected: s.rejected,
        cycleTimeS: round1(s.lastCycleTimeS), availabilityPct: round1(availability),
        activeFaults: alarmsArr.filter((a) => a.active).length, mode: 'SIM',
      },
      io: { inputs, outputs },
      alarms: alarmsArr,
      maintenance: {
        conveyorMotorHours: round1(s.convRunTotalS / 3600), conveyorStarts: s.convStarts, conveyorDutyCyclePct: round1(s.convDuty15),
        turntableCycles: s.ttIndexCount, homeLimitHits: s.ttHomeHits, workLimitHits: s.ttWorkHits,
        fixture1SwitchCycles: s.fx[0].switchCycles, fixture2SwitchCycles: s.fx[1].switchCycles,
        gripperCycles: s.gripCycles, cameraTriggerCount: s.camTriggers, cameraInspectionCount: s.camInspections,
        jointTemps: s.jointTempC.map(round1),
      },
      quality: {
        passCount: s.camPass, failCount: s.camFail, rejectRatePct: round1(failRate),
        lastResult: s.camLast === 'PASS' ? 'PASS' : s.camLast === 'FAIL' ? 'FAIL' : '—',
        cameraProcessingMs: Math.round(s.camLastMs), noReadCount: s.camNoRead,
      },
      cobot: {
        controllerTempC: round1(s.ctrlTempC), avgPowerW: round1(ctrlAvgPower), avgCurrentA: round2(ctrlAvgCurrent), speedMagnificationPct: s.speedMagPct,
        joints: s.jointAngleDeg.map((ang, i) => ({ index: i + 1, angleDeg: round2(ang), tempC: round1(s.jointTempC[i]), currentA: round2(s.jointAmpA[i]) })),
        tcp: { xMm: -279.88, yMm: -101.68, zMm: 279.70, rxDeg: -179.53, ryDeg: -2.04, rzDeg: -178.80, targetPoseName: poseForStage(s.stage), positionErrorMm: round1(s.tcpErrMm), orientationErrorDeg: round1(s.tcpOriErrDeg) },
        ft: { fxN: round1(s.eeForceN[0]), fyN: round1(s.eeForceN[1]), fzN: round1(s.eeForceN[2]), txNm: round2(s.eeTorqueNm[0]), tyNm: round2(s.eeTorqueNm[1]), tzNm: round2(s.eeTorqueNm[2]) },
      },
      conveyor: {
        motorOn: s.convOn, runningTimeCurrentCycleS: round1(s.convRunCurrentS), runningTimeTotalS: Math.round(s.convRunTotalS),
        dutyCycle5minPct: round1(s.convDuty5), dutyCycle15minPct: round1(s.convDuty15), stopReason: s.convStopReason,
        sensorPresent: s.convSensor, waitAfterPickTimerS: round1(s.convWaitAfterPickS), cafisWaitingCount: s.convCafisWaiting,
        motorTempC: round1(convMotorTemp), motorTempSource: 'ESTIMATED', starts: s.convStarts,
      },
      turntable: {
        position: s.ttPos, angleDeg: round1(s.ttAngle), target: s.ttTarget, motorRunning: s.ttMoving, moveTimeS: round1(s.ttMoveT),
        homeLimit: !s.ttMoving && s.ttTarget === 'HOME', workLimit: !s.ttMoving && s.ttTarget === 'WORK',
        indexCount: s.ttIndexCount, homeHitCount: s.ttHomeHits, workHitCount: s.ttWorkHits,
        failedHomeCount: s.ttFailedHome, failedWorkCount: s.ttFailedWork, lastMoveDurationS: round2(s.ttLastMoveDur),
        nominalMoveDurationS: round2(s.ttNominalDur), cyclesSinceMaintenance: s.ttCyclesSinceMaint,
      },
      gripper: {
        airPressureBar: round1(s.airBar), pressureSource: 'CONFIGURED', command: s.gripCmd, state: s.gripState,
        closeTimeMs: Math.round(s.gripCloseMs), openTimeMs: Math.round(s.gripOpenMs), cycleCount: s.gripCycles,
        faultCount: s.gripFaults, pressureLow: s.airBar < T.pressureMinWarningBar, pressureHigh: s.airBar > T.pressureMaxWarningBar, strokeCm: 2.5,
      },
      fixtures, sensors,
      camera: {
        triggerCount: s.camTriggers, inspectionCount: s.camInspections, passCount: s.camPass, failCount: s.camFail,
        noReadCount: s.camNoRead, lastResult: s.camLast, lastInspectionTimeMs: Math.round(s.camLastMs),
        avgInspectionTimeMs: Math.round(s.camAvgMs), maxInspectionTimeMs: Math.round(s.camMaxMs), commStatus: s.camComm,
        errorCode: '0x00', storageUsedMb: round1(s.camStorageMb), savedImagesCount: s.camSavedImages,
        triggerRatePerHour: Math.round((s.camTriggers / Math.max(1, s.clock)) * 3600),
      },
      tags: allTags,
    };
  }

  function hasSeverity(sev: Severity): boolean {
    for (const a of s.alarms.values()) if (a.active && a.severity === sev) return true;
    return false;
  }

  return { tick, snapshot, acknowledge, acknowledgeAll, thresholds: SCADA_THRESHOLDS };
}

// CAMBIO 13: snapshot SCADA completo (tags + alarmas + contadores + mantenimiento
// + cobot + cámara + conveyor + gripper + fixtures + mesa). Sirve para dashboard,
// IA, export futuro y logs.
export function buildScadaSnapshot(engine: ScadaEngine): ScadaSnapshot {
  return engine.snapshot();
}

function sevRank(s: Severity): number { return s === 'CRITICAL' ? 3 : s === 'ALARM' ? 2 : s === 'WARNING' ? 1 : 0; }
function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function poseForStage(st: Stage): string {
  switch (st) {
    case 'PICK_CONVEYOR': return 'PICK_CONVEYOR';
    case 'PLACE_FIXTURE': return 'PLACE_FIXTURE_1';
    case 'PICK_RIVETED': return 'PICK_FIXTURE_1';
    case 'PLACE_CAMERA': return 'PLACE_CAMERA';
    case 'INSPECT': case 'PICK_CAMERA': return 'PICK_CAMERA';
    case 'PLACE_BIN': return 'ACCEPTED_PLACE';
    default: return 'SAFE_RETURN';
  }
}

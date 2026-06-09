// ─────────────────────────────────────────────────────────────────────────────
// scadaEngine.ts — Motor SCADA REAL-ONLY (independiente de FSM / Celda 3D).
//
// Por defecto NO simula nada: deriva el estado SÓLO de telemetría real —
//   • cobot: frame WebSocket del gateway (mismo que "Cobot en Vivo")
//   • PLC:   bloque telemetry.io del gateway (conveyor/mesa/gripper/fixtures/cámara)
// Si un dato no llega, su valor es null y su fuente NOT_CONNECTED (no se inventa).
//
// Alarmas con ciclo de vida (ACTIVE/ACKNOWLEDGED/RESOLVED): NO se borran por click,
// se reactivan si la condición vuelve, y NO se pueden resolver si la condición real
// sigue presente. Historial ligero (acotado) para las gráficas. Comentarios del
// operador → log de mantenimiento. MODO DEMO (toggle OFF) sintetiza datos marcados DEMO.
// ─────────────────────────────────────────────────────────────────────────────

import { SCADA_THRESHOLDS } from './scadaConfig';
import type {
  Alarm, ScadaSnapshot, Severity, Tag, DataSource, IoSignal, CobotHealthSnap,
  MaintItem, MaintChecklistItem, ScadaMode, LinkState, MaintLogEntry, ScadaHistory,
} from './scadaTypes';
import type { ScadaIoFrame } from './cobotTelemetrySource';

const T = SCADA_THRESHOLDS;
const HIST_MAX = 120;   // puntos de temperatura (≈ últimos 120 s a 1 Hz)
const CONV_MAX = 10;    // últimos 10 ON-times del conveyor
const CYCLE_MAX = 10;   // últimos 10 tiempos de ciclo
const DEMO_CYCLE_DUR = 48;   // duración nominal de un ciclo en modo DEMO (s)
const DEMO_CYCLE_STEPS = 12; // pasos totales del ciclo en modo DEMO

// Telemetría real del cobot (subconjunto que consume el motor).
export interface CobotTelemetryInput {
  controller: { temperature_c: number; avg_power_w: number; avg_current_a: number };
  status: {
    speed_magnification_pct: number; emergency_stop: boolean; protective_stop: boolean;
    robot_enabled: boolean; power_on?: boolean; on_soft_limit?: boolean; motion_errcode?: number;
  };
  joint_positions_deg: number[];
  joint_temperatures_c?: number[];
  joint_speeds_deg_s?: number[];
  joint_states: { current_a: number; error?: boolean; collision?: boolean }[];
  tcp_position: { x_mm: number; y_mm: number; z_mm: number; rx_deg: number; ry_deg: number; rz_deg: number };
  end_effector: { fx_n: number; fy_n: number; fz_n: number; torque_rx_nm: number; torque_ry_nm: number; torque_rz_nm: number };
}

interface CobotData {
  ctrlTempC: number; avgPowerW: number; avgCurrentA: number; speedMagPct: number;
  angleDeg: number[]; tempC: number[]; ampA: number[];
  tcp: { x: number; y: number; z: number; rx: number; ry: number; rz: number };
  ft: { fx: number; fy: number; fz: number; tx: number; ty: number; tz: number };
  estop: boolean; protStop: boolean; enabled: boolean; moving: boolean;
  softLimit: boolean; collision: boolean; motionErr: number; powerOn: boolean;
}

interface EngineState {
  clock: number;
  mode: ScadaMode;

  // ── enlace cobot ──
  cobotConnected: boolean;
  cobotData: CobotData | null;
  cobotAgeS: number;
  cobotEverSeen: boolean;

  // ── enlace PLC (telemetry.io) ──
  io: ScadaIoFrame | null;
  plcAgeS: number;
  plcEverSeen: boolean;

  // ── conveyor on-time ──
  convOnTimeS: number;
  prevConvOn: boolean | null;

  // ── historial para gráficas ──
  conveyorOnDurations: number[];
  conveyorOnTimeHist: { t: number; v: number }[];
  controllerTemps: { t: number; v: number }[];
  jointTemps: { t: number; temps: number[] }[];
  cycleTimes: number[];          // tiempos de ciclo (últimos 10) — sólo se llena en DEMO
  demoLastCycleNo: number;       // nº de ciclo DEMO ya contabilizado (para el flanco)
  lastHistSec: number;

  // ── alarmas + log mantenimiento ──
  alarms: Map<string, Alarm>;
  maintenanceLog: MaintLogEntry[];
  logSeq: number;
}

export interface ScadaEngine {
  tick: (dt: number) => void;
  snapshot: () => ScadaSnapshot;
  acknowledge: (id: string, by?: string) => void;
  acknowledgeAll: (by?: string) => void;
  resolve: (id: string, by?: string) => { ok: boolean; reason?: string };
  addComment: (text: string, alarmCode?: string | null, by?: string) => void;
  setCobotTelemetry: (t: CobotTelemetryInput | null) => void;
  setConnected: (connected: boolean) => void;
  setPlcIo: (io: ScadaIoFrame | null) => void;
  setDemo: (on: boolean) => void;
  thresholds: typeof SCADA_THRESHOLDS;
}

export function createScadaEngine(): ScadaEngine {
  const s: EngineState = {
    clock: 0, mode: 'REAL',
    cobotConnected: false, cobotData: null, cobotAgeS: Infinity, cobotEverSeen: false,
    io: null, plcAgeS: Infinity, plcEverSeen: false,
    convOnTimeS: 0, prevConvOn: null,
    conveyorOnDurations: [], conveyorOnTimeHist: [], controllerTemps: [], jointTemps: [],
    cycleTimes: [], demoLastCycleNo: -1, lastHistSec: -1,
    alarms: new Map(), maintenanceLog: [], logSeq: 0,
  };

  // ── Entradas reales ─────────────────────────────────────────────────────────
  function setConnected(connected: boolean): void { s.cobotConnected = connected; }

  function setCobotTelemetry(t: CobotTelemetryInput | null): void {
    if (!t) return;
    const sm = t.status.speed_magnification_pct;
    s.cobotData = {
      ctrlTempC: t.controller.temperature_c,
      avgPowerW: t.controller.avg_power_w,
      avgCurrentA: t.controller.avg_current_a,
      speedMagPct: sm <= 2 ? Math.round(sm * 100) : Math.round(sm),
      angleDeg: (t.joint_positions_deg ?? []).slice(),
      tempC: (t.joint_temperatures_c ?? []).slice(),
      ampA: (t.joint_states ?? []).map((j) => j.current_a),
      tcp: { x: t.tcp_position.x_mm, y: t.tcp_position.y_mm, z: t.tcp_position.z_mm, rx: t.tcp_position.rx_deg, ry: t.tcp_position.ry_deg, rz: t.tcp_position.rz_deg },
      ft: { fx: t.end_effector.fx_n, fy: t.end_effector.fy_n, fz: t.end_effector.fz_n, tx: t.end_effector.torque_rx_nm, ty: t.end_effector.torque_ry_nm, tz: t.end_effector.torque_rz_nm },
      estop: t.status.emergency_stop, protStop: t.status.protective_stop, enabled: t.status.robot_enabled,
      moving: (t.joint_speeds_deg_s ?? []).some((v) => Math.abs(v) > 0.5),
      softLimit: !!t.status.on_soft_limit,
      collision: (t.joint_states ?? []).some((j) => j.collision === true),
      motionErr: t.status.motion_errcode ?? 0,
      powerOn: t.status.power_on ?? t.status.robot_enabled,
    };
    s.cobotAgeS = 0; s.cobotEverSeen = true;
  }

  function setPlcIo(io: ScadaIoFrame | null): void {
    if (!io) return;
    s.io = io; s.plcAgeS = 0; s.plcEverSeen = true;
  }

  function resetHistory(): void {
    s.convOnTimeS = 0; s.prevConvOn = null; s.lastHistSec = -1;
    s.conveyorOnDurations = []; s.conveyorOnTimeHist = []; s.controllerTemps = []; s.jointTemps = [];
    s.cycleTimes = []; s.demoLastCycleNo = -1;
  }

  function setDemo(on: boolean): void {
    s.mode = on ? 'DEMO' : 'REAL';
    if (on) { s.alarms.forEach((a) => { if (!a.demo) { a.active = false; } }); }
    else { s.alarms.clear(); }
    resetHistory();   // los datos cambian de fuente → empezar series limpias
    // En DEMO sembramos algunos tiempos de ciclo para que el promedio/gráfica no salgan vacíos.
    if (on) { s.cycleTimes = [46, 49, 44, 47, 51]; s.demoLastCycleNo = -1; }
  }

  // ── Frescura de enlaces ───────────────────────────────────────────────────────
  function cobotSource(): DataSource {
    if (s.mode === 'DEMO') return (s.cobotConnected && s.cobotData && s.cobotAgeS <= T.staleAfterS) ? 'REAL' : 'DEMO';
    if (!s.cobotConnected || !s.cobotData) return 'NOT_CONNECTED';
    return s.cobotAgeS > T.staleAfterS ? 'STALE' : 'REAL';
  }
  function plcSource(): DataSource {
    if (s.mode === 'DEMO') return (s.plcEverSeen && s.plcAgeS <= T.staleAfterS) ? 'REAL' : 'DEMO';
    if (!s.plcEverSeen || !s.io) return 'NOT_CONNECTED';
    return s.plcAgeS > T.staleAfterS ? 'STALE' : 'REAL';
  }

  // ── Demo sintético (determinista, marcado DEMO) ──────────────────────────────
  function demoIo(): ScadaIoFrame {
    const t = s.clock; const sc = t % 120; const p = t % 12;
    const gripOpen = (p % 4) >= 2;
    return {
      // inputs
      conveyor_photoeye: p > 2 && p < 3.4,
      fixture_1_present: p > 3 && p < 9,
      fixture_2_present: false,
      table_home_limit: p < 6,
      table_work_limit: p >= 6.5 && p < 11.5,
      camera_pass: p > 8.9 && p < 9.4,
      camera_fail: false,
      camera_ready: !(p > 8 && p < 9),
      camera_error: false,
      camera_no_read: false,
      gripper_open: gripOpen,
      gripper_closed: !gripOpen,
      // outputs
      conveyor_motor_on: sc < 70,
      camera_trigger: p > 7.9 && p < 8.15,
      table_nema_moving: (p > 5.8 && p < 6.6) || (p > 11.6),
      rivet_active: p > 9.5 && p < 11.4,
      stacklight_green: sc < 70,
      stacklight_yellow: sc >= 70 && sc < 110,
      stacklight_red: false,
      // legacy
      camera_photoeye: p > 8 && p < 10,
      air_pressure_bar: Math.round((5.8 + Math.sin(t) * 0.3) * 10) / 10,
      estop: false, stop_button: false,
    };
  }
  function demoCobot(): CobotData {
    const t = s.clock;
    const angle = [177.4, 107.6, -108.9, 93.3, 90.6, -93.8];
    const baseTemp = [42, 42, 41, 46, 47, 50];
    const tempC = baseTemp.map((b, i) => Math.round((b + Math.sin(t * 0.1 + i) * 3 + (i === 5 ? 8 : 0)) * 10) / 10);
    return {
      ctrlTempC: Math.round((34 + Math.sin(t * 0.07) * 2) * 10) / 10,
      avgPowerW: Math.round(30 + Math.abs(Math.sin(t * 0.3)) * 40),
      avgCurrentA: Math.round((0.6 + Math.abs(Math.sin(t * 0.3)) * 0.8) * 100) / 100,
      speedMagPct: 100,
      angleDeg: angle.map((a, i) => Math.round((a + Math.sin(t * 0.5 + i) * 2) * 100) / 100),
      tempC,
      ampA: angle.map((_, i) => Math.round((Math.sin(t * 0.4 + i) * 0.9) * 100) / 100),
      tcp: { x: -279.88, y: -101.68, z: 279.70, rx: -179.53, ry: -2.04, rz: -178.80 },
      ft: { fx: Math.round(Math.sin(t) * 2 * 10) / 10, fy: Math.round(Math.cos(t) * 2 * 10) / 10, fz: Math.round(Math.sin(t * 0.5) * 3 * 10) / 10, tx: 0, ty: 0, tz: 0 },
      estop: false, protStop: false, enabled: true, moving: (t % 6) < 4,
      softLimit: false, collision: false, motionErr: 0, powerOn: true,
    };
  }

  function effCobot(): { data: CobotData | null; src: DataSource } {
    const src = cobotSource();
    if (src === 'DEMO') return { data: demoCobot(), src };
    if (src === 'NOT_CONNECTED') return { data: null, src };
    return { data: s.cobotData, src };
  }
  function effIo(): { io: ScadaIoFrame | null; src: DataSource } {
    const src = plcSource();
    if (src === 'DEMO') return { io: demoIo(), src };
    if (src === 'NOT_CONNECTED') return { io: null, src };
    return { io: s.io, src };
  }

  // ── Tick ──────────────────────────────────────────────────────────────────────
  function tick(dt: number): void {
    const d = Math.min(0.1, dt);
    s.clock += d;
    s.cobotAgeS += d;
    s.plcAgeS += d;

    // conveyor on-time + captura del ON-time al apagarse (flanco ON→OFF)
    const { io } = effIo();
    const convOn = io && (io.conveyor_motor_on === true || io.conveyor_motor_on === false) ? io.conveyor_motor_on : null;
    if (convOn === true) {
      s.convOnTimeS += d;
    } else if (convOn === false) {
      if (s.prevConvOn === true && s.convOnTimeS > 0.2) {
        s.conveyorOnDurations.push(round1(s.convOnTimeS));
        if (s.conveyorOnDurations.length > CONV_MAX) s.conveyorOnDurations.shift();
      }
      s.convOnTimeS = 0;
    }
    s.prevConvOn = convOn;

    // historial de temperaturas a 1 Hz (solo si hay cobot)
    const sec = Math.floor(s.clock);
    if (sec !== s.lastHistSec) {
      s.lastHistSec = sec;
      const { data: cb } = effCobot();
      if (cb) {
        s.controllerTemps.push({ t: round1(s.clock), v: round1(cb.ctrlTempC) });
        if (s.controllerTemps.length > HIST_MAX) s.controllerTemps.shift();
        if (cb.tempC.length >= 6) {
          s.jointTemps.push({ t: round1(s.clock), temps: cb.tempC.slice(0, 6).map(round1) });
          if (s.jointTemps.length > HIST_MAX) s.jointTemps.shift();
        }
      }
      // tiempo encendido del conveyor en vivo (sube mientras ON, 0 al apagar)
      if (convOn !== null) {
        s.conveyorOnTimeHist.push({ t: round1(s.clock), v: round1(s.convOnTimeS) });
        if (s.conveyorOnTimeHist.length > HIST_MAX) s.conveyorOnTimeHist.shift();
      }
    }

    // tiempos de ciclo — SÓLO en DEMO (en REAL no hay enlace a la FSM/ciclo).
    // Al cruzar un borde de ciclo se registra su duración (con ligera variación).
    if (s.mode === 'DEMO') {
      const cycleNo = Math.floor(s.clock / DEMO_CYCLE_DUR);
      if (s.demoLastCycleNo >= 0 && cycleNo !== s.demoLastCycleNo) {
        const ct = round1(DEMO_CYCLE_DUR + ((cycleNo % 5) - 2) * 2.3);   // ≈ 43..53 s
        s.cycleTimes.push(ct);
        if (s.cycleTimes.length > CYCLE_MAX) s.cycleTimes.shift();
      }
      s.demoLastCycleNo = cycleNo;
    }

    evaluateAlarms();
  }

  // ── Alarmas (ciclo de vida; NO se borran por click) ──────────────────────────
  function raise(code: string, severity: Severity, station: string, message: string, demo: boolean): void {
    const ex = s.alarms.get(code);
    if (ex) {
      ex.active = true; ex.severity = severity; ex.message = message; ex.demo = demo;
      if (ex.status === 'RESOLVED') {
        // la condición volvió tras resolverse → nueva ocurrencia: reactivar
        ex.status = 'ACTIVE'; ex.resolvedAt = null; ex.resolvedBy = null;
        ex.operatorComment = null; ex.raisedAt = s.clock; ex.durationS = 0;
      } else {
        ex.durationS = s.clock - ex.raisedAt;
      }
    } else {
      s.alarms.set(code, {
        id: code, code, severity, station, message, raisedAt: s.clock, durationS: 0,
        active: true, status: 'ACTIVE', acknowledgedAt: null, acknowledgedBy: null,
        resolvedAt: null, resolvedBy: null, operatorComment: null, demo,
      });
    }
  }
  function clear(code: string): void {
    const ex = s.alarms.get(code);
    if (ex) ex.active = false;   // condición ya no presente; el operador resuelve manualmente
  }
  function rule(code: string, cond: boolean, sev: Severity, station: string, msg: string, demo: boolean): void {
    if (cond) raise(code, sev, station, msg, demo); else clear(code);
  }

  function pushLog(kind: MaintLogEntry['kind'], text: string, alarmCode: string | null, by: string): void {
    s.maintenanceLog.unshift({ id: `L${++s.logSeq}`, at: round1(s.clock), by, kind, text, alarmCode });
    if (s.maintenanceLog.length > 50) s.maintenanceLog.pop();
  }

  function acknowledge(id: string, by = 'Operador'): void {
    const a = s.alarms.get(id);
    if (!a || a.status === 'RESOLVED' || a.status === 'ACKNOWLEDGED') return;
    a.status = 'ACKNOWLEDGED'; a.acknowledgedAt = round1(s.clock); a.acknowledgedBy = by;
    pushLog('ACK', `Reconocida [${a.code}] ${a.message}`, a.code, by);
  }
  function acknowledgeAll(by = 'Operador'): void {
    s.alarms.forEach((a) => { if (a.status === 'ACTIVE') acknowledge(a.id, by); });
  }
  function resolve(id: string, by = 'Operador'): { ok: boolean; reason?: string } {
    const a = s.alarms.get(id);
    if (!a) return { ok: false, reason: 'Alarma no encontrada' };
    if (a.active) return { ok: false, reason: 'No se puede marcar como resuelta: la condición sigue presente en la lectura en tiempo real.' };
    a.status = 'RESOLVED'; a.resolvedAt = round1(s.clock); a.resolvedBy = by;
    pushLog('RESOLVE', `Resuelta [${a.code}] ${a.message}`, a.code, by);
    return { ok: true };
  }
  function addComment(text: string, alarmCode: string | null = null, by = 'Operador'): void {
    const t = (text || '').trim();
    if (!t) return;
    if (alarmCode) { const a = s.alarms.get(alarmCode); if (a) a.operatorComment = t; }
    pushLog('COMMENT', t, alarmCode, by);
  }

  function evaluateAlarms(): void {
    const { data: cb, src: cbSrc } = effCobot();
    const { io, src: ioSrc } = effIo();
    const cbAvail = cbSrc !== 'NOT_CONNECTED' && !!cb;
    const cbDemo = cbSrc === 'DEMO';
    const ioDemo = ioSrc === 'DEMO';

    if (cbAvail && cb) {
      rule('CB_ESTOP', cb.estop, 'CRITICAL', 'Cobot', 'Emergency stop ACTIVO', cbDemo);
      rule('CB_PSTOP', cb.protStop, 'ALARM', 'Cobot', 'Protective stop activo', cbDemo);
      rule('CB_NOT_ENABLED', !cb.enabled, 'WARNING', 'Cobot', 'Robot no habilitado (not enabled)', cbDemo);
      rule('CB_MOTION_ERR', cb.motionErr !== 0, 'ALARM', 'Cobot', `Motion errcode ${cb.motionErr}`, cbDemo);
      rule('CB_COLLISION', cb.collision, 'ALARM', 'Cobot', 'Colisión detectada en una articulación', cbDemo);
      rule('CB_SOFTLIMIT', cb.softLimit, 'WARNING', 'Cobot', 'Cobot en soft limit', cbDemo);
      cb.tempC.forEach((tc, i) => {
        const st = `Cobot J${i + 1}`;
        rule(`J${i + 1}_TEMP_CRIT`, tc > T.jointTempCriticalC, 'CRITICAL', st, `J${i + 1} temp ${tc.toFixed(0)}°C (>${T.jointTempCriticalC})`, cbDemo);
        rule(`J${i + 1}_TEMP_ALARM`, tc > T.jointTempAlarmC && tc <= T.jointTempCriticalC, 'ALARM', st, `J${i + 1} temp ${tc.toFixed(0)}°C (>${T.jointTempAlarmC})`, cbDemo);
        rule(`J${i + 1}_TEMP_WARN`, tc > T.jointTempWarningC && tc <= T.jointTempAlarmC, 'WARNING', st, `J${i + 1} temp ${tc.toFixed(0)}°C (>${T.jointTempWarningC})`, cbDemo);
      });
      const ftMag = Math.hypot(cb.ft.fx, cb.ft.fy, cb.ft.fz);
      rule('EE_FORCE_ALARM', ftMag > T.eeForceAlarmN, 'ALARM', 'Cobot TCP', `Fuerza EE ${ftMag.toFixed(0)} N (>${T.eeForceAlarmN})`, cbDemo);
      rule('EE_FORCE_WARN', ftMag > T.eeForceWarningN && ftMag <= T.eeForceAlarmN, 'WARNING', 'Cobot TCP', `Fuerza EE ${ftMag.toFixed(0)} N (>${T.eeForceWarningN})`, cbDemo);
    } else {
      ['CB_ESTOP', 'CB_PSTOP', 'CB_NOT_ENABLED', 'CB_MOTION_ERR', 'CB_COLLISION', 'CB_SOFTLIMIT', 'EE_FORCE_ALARM', 'EE_FORCE_WARN'].forEach(clear);
      for (let i = 1; i <= 6; i++) { clear(`J${i}_TEMP_CRIT`); clear(`J${i}_TEMP_ALARM`); clear(`J${i}_TEMP_WARN`); }
    }

    const convSignal = !!io && (io.conveyor_motor_on === true || io.conveyor_motor_on === false);
    if (convSignal) {
      rule('CNV_ON_ALARM', s.convOnTimeS > T.conveyorOnTimeAlarmS, 'ALARM', 'Conveyor',
        `Conveyor encendido ${s.convOnTimeS.toFixed(0)}s (>${T.conveyorOnTimeAlarmS}s). Detener y revisar motor/banda.`, ioDemo);
      rule('CNV_ON_WARN', s.convOnTimeS > T.conveyorOnTimeWarningS && s.convOnTimeS <= T.conveyorOnTimeAlarmS, 'WARNING', 'Conveyor',
        `Conveyor encendido ${s.convOnTimeS.toFixed(0)}s (>${T.conveyorOnTimeWarningS}s). Posible sobrecalentamiento.`, ioDemo);
    } else { clear('CNV_ON_ALARM'); clear('CNV_ON_WARN'); }

    const pbar = io && typeof io.air_pressure_bar === 'number' ? io.air_pressure_bar : null;
    if (pbar !== null) {
      rule('GRP_P_LOW_ALARM', pbar < T.pressureMinAlarmBar, 'ALARM', 'Gripper', `Presión ${pbar.toFixed(1)} bar (<${T.pressureMinAlarmBar})`, ioDemo);
      rule('GRP_P_LOW_WARN', pbar < T.pressureMinWarningBar && pbar >= T.pressureMinAlarmBar, 'WARNING', 'Gripper', `Presión ${pbar.toFixed(1)} bar (<${T.pressureMinWarningBar})`, ioDemo);
    } else { clear('GRP_P_LOW_ALARM'); clear('GRP_P_LOW_WARN'); }

    rule('PLC_STALE', s.mode === 'REAL' && s.plcEverSeen && plcSource() === 'STALE', 'WARNING', 'PLC I/O',
      `Sin actualización de telemetry.io hace ${s.plcAgeS.toFixed(0)}s`, false);

    s.alarms.forEach((a) => { if (a.active) a.durationS = s.clock - a.raisedAt; });
  }

  // ── Snapshot ────────────────────────────────────────────────────────────────
  function bool(v: boolean | null | undefined): boolean | null { return v === true || v === false ? v : null; }

  function snapshot(): ScadaSnapshot {
    const { data: cb, src: cbSrc } = effCobot();
    const { io, src: ioSrc } = effIo();
    const cbAvail = cbSrc !== 'NOT_CONNECTED' && !!cb;
    const plcAvail = ioSrc !== 'NOT_CONNECTED' && !!io;

    const cobotLink: LinkState = { state: cbSrc, connected: s.cobotConnected || s.mode === 'DEMO', ageS: s.cobotEverSeen ? round1(s.cobotAgeS) : null };
    const plcLink: LinkState = { state: ioSrc, connected: s.plcEverSeen || s.mode === 'DEMO', ageS: s.plcEverSeen ? round1(s.plcAgeS) : null };

    const joints = cbAvail && cb ? cb.angleDeg.map((ang, i) => ({
      index: i + 1, angleDeg: round2(ang), tempC: round1(cb.tempC[i] ?? 0), currentA: round2(cb.ampA[i] ?? 0),
    })) : [];
    const maxJointTempC = joints.length ? Math.max(...joints.map((j) => j.tempC)) : null;
    const maxJointTempJoint = maxJointTempC !== null ? (joints.find((j) => j.tempC === maxJointTempC)?.index ?? null) : null;
    const cobot: CobotHealthSnap = {
      available: cbAvail, source: cbSrc,
      controllerTempC: cbAvail && cb ? round1(cb.ctrlTempC) : null,
      avgPowerW: cbAvail && cb ? round1(cb.avgPowerW) : null,
      avgCurrentA: cbAvail && cb ? round2(cb.avgCurrentA) : null,
      speedMagnificationPct: cbAvail && cb ? cb.speedMagPct : null,
      joints, maxJointTempC, maxJointTempJoint,
      tcp: cbAvail && cb ? { xMm: round2(cb.tcp.x), yMm: round2(cb.tcp.y), zMm: round2(cb.tcp.z), rxDeg: round2(cb.tcp.rx), ryDeg: round2(cb.tcp.ry), rzDeg: round2(cb.tcp.rz) } : null,
      ft: cbAvail && cb ? { fxN: round1(cb.ft.fx), fyN: round1(cb.ft.fy), fzN: round1(cb.ft.fz), txNm: round2(cb.ft.tx), tyNm: round2(cb.ft.ty), tzNm: round2(cb.ft.tz) } : null,
      flags: {
        estop: !!cb?.estop, protectiveStop: !!cb?.protStop, enabled: !!cb?.enabled, moving: !!cb?.moving,
        softLimit: !!cb?.softLimit, collision: !!cb?.collision, motionErr: cb?.motionErr ?? 0, powerOn: !!cb?.powerOn,
      },
    };

    const convOn = plcAvail && io ? bool(io.conveyor_motor_on) : null;
    const convSignal = convOn !== null;
    const conveyor = {
      signalAvailable: convSignal,
      motorOn: convOn,
      onTimeS: convSignal ? round1(s.convOnTimeS) : 0,
      warning: (convSignal && s.convOnTimeS > T.conveyorOnTimeAlarmS ? 'ALARM'
        : convSignal && s.convOnTimeS > T.conveyorOnTimeWarningS ? 'WARNING' : 'NONE') as 'NONE' | 'WARNING' | 'ALARM',
      source: convSignal ? ioSrc : ('NOT_CONNECTED' as DataSource),
    };

    // ── Matriz de I/O canónica del HMI: 14 inputs + 8 outputs ──
    // COBOT: 2 inputs derivados de la telemetría del robot (no del PLC).
    // PLC: 12 inputs + 8 outputs del bloque telemetry.io del gateway.
    const io_: IoSignal[] = [];
    const cAge = s.cobotEverSeen ? round1(s.cobotAgeS) : null;
    const cobotSignals: { key: string; label: string; val: boolean | null }[] = [
      { key: 'I_COBOT_MOVING', label: 'Cobot moving', val: cbAvail ? !!cb?.moving : null },
      { key: 'I_COBOT_READY', label: 'Cobot ready', val: cbAvail ? !!cb?.enabled : null },
    ];
    cobotSignals.forEach((x) => io_.push({ key: x.key, label: x.label, group: 'COBOT', kind: 'INPUT', value: x.val, source: cbAvail ? cbSrc : 'NOT_CONNECTED', ageS: cbAvail ? cAge : null }));

    const pAge = s.plcEverSeen ? round1(s.plcAgeS) : null;
    const iob = (k: keyof ScadaIoFrame): boolean | null => (plcAvail && io ? bool(io[k] as boolean | null | undefined) : null);
    const plcSignals: { key: string; label: string; kind: 'INPUT' | 'OUTPUT'; val: boolean | null }[] = [
      // Inputs (12)
      { key: 'I_CONVEYOR_PHOTOEYE', label: 'Conveyor photoeye', kind: 'INPUT', val: iob('conveyor_photoeye') },
      { key: 'I_FIXTURE_1_PRESENT', label: 'Fixture 1 present', kind: 'INPUT', val: iob('fixture_1_present') },
      { key: 'I_FIXTURE_2_PRESENT', label: 'Fixture 2 present', kind: 'INPUT', val: iob('fixture_2_present') },
      { key: 'I_TABLE_HOME_LIMIT', label: 'Table HOME limit', kind: 'INPUT', val: iob('table_home_limit') },
      { key: 'I_TABLE_WORK_LIMIT', label: 'Table WORK limit', kind: 'INPUT', val: iob('table_work_limit') },
      { key: 'I_CAMERA_PASS', label: 'Camera PASS', kind: 'INPUT', val: iob('camera_pass') },
      { key: 'I_CAMERA_FAIL', label: 'Camera FAIL', kind: 'INPUT', val: iob('camera_fail') },
      { key: 'I_CAMERA_READY', label: 'Camera READY', kind: 'INPUT', val: iob('camera_ready') },
      { key: 'I_CAMERA_ERROR', label: 'Camera ERROR', kind: 'INPUT', val: iob('camera_error') },
      { key: 'I_CAMERA_NO_READ', label: 'Camera NO-READ', kind: 'INPUT', val: iob('camera_no_read') },
      { key: 'I_GRIPPER_OPEN', label: 'Gripper open', kind: 'INPUT', val: iob('gripper_open') },
      { key: 'I_GRIPPER_CLOSED', label: 'Gripper closed', kind: 'INPUT', val: iob('gripper_closed') },
      // Outputs (7)
      { key: 'O_CONVEYOR_MOTOR', label: 'Conveyor motor', kind: 'OUTPUT', val: iob('conveyor_motor_on') },
      { key: 'O_CAMERA_TRIGGER', label: 'Camera trigger', kind: 'OUTPUT', val: iob('camera_trigger') },
      { key: 'O_TABLE_NEMA_MOVING', label: 'Disco (NEMA) moving', kind: 'OUTPUT', val: iob('table_nema_moving') },
      { key: 'O_RIVET_ACTIVE', label: 'Rivet active', kind: 'OUTPUT', val: iob('rivet_active') },
      { key: 'O_STACKLIGHT_GREEN', label: 'Stacklight verde', kind: 'OUTPUT', val: iob('stacklight_green') },
      { key: 'O_STACKLIGHT_YELLOW', label: 'Stacklight ámbar', kind: 'OUTPUT', val: iob('stacklight_yellow') },
      { key: 'O_STACKLIGHT_RED', label: 'Stacklight rojo', kind: 'OUTPUT', val: iob('stacklight_red') },
    ];
    plcSignals.forEach((x) => io_.push({ key: x.key, label: x.label, group: 'PLC', kind: x.kind, value: x.val, source: plcAvail ? ioSrc : 'NOT_CONNECTED', ageS: plcAvail ? pAge : null }));

    // alarmas: activas primero, luego por severidad, luego recientes
    const alarmsArr = [...s.alarms.values()].sort((a, b) =>
      (Number(b.active) - Number(a.active)) || (sevRank(b.severity) - sevRank(a.severity)) || (b.raisedAt - a.raisedAt));
    const activeAlarms = alarmsArr.filter((a) => a.active);

    const items: MaintItem[] = [];
    if (cbAvail && maxJointTempC !== null) {
      items.push({ label: 'Joint máx. temp', value: `${maxJointTempC}°C`, source: cbSrc,
        status: maxJointTempC > T.jointTempCriticalC ? 'ALARM' : maxJointTempC > T.jointTempWarningC ? 'WARNING' : 'OK' });
    }
    if (cbAvail && cobot.speedMagnificationPct !== null) {
      items.push({ label: 'Speed magnification', value: `${cobot.speedMagnificationPct}%`, source: cbSrc, status: 'OK' });
    }
    if (convSignal) {
      items.push({ label: 'Conveyor on-time', value: `${conveyor.onTimeS}s`, source: ioSrc,
        status: conveyor.warning === 'ALARM' ? 'ALARM' : conveyor.warning === 'WARNING' ? 'WARNING' : 'OK' });
    }
    const gOpen = plcAvail && io ? bool(io.gripper_open) : null;
    const gClosed = plcAvail && io ? bool(io.gripper_closed) : null;
    if (gOpen !== null || gClosed !== null) {
      const st = gClosed && !gOpen ? 'CLOSED' : gOpen && !gClosed ? 'OPEN' : 'UNKNOWN';
      items.push({ label: 'Gripper state', value: st, source: ioSrc, status: st === 'UNKNOWN' ? 'WARNING' : 'OK' });
    }
    const fx1 = plcAvail && io ? bool(io.fixture_1_present) : null;
    const fx2 = plcAvail && io ? bool(io.fixture_2_present) : null;
    if (fx1 !== null || fx2 !== null) {
      items.push({ label: 'Fixtures present', value: `1:${fx1 === null ? 'NA' : fx1 ? 'SÍ' : 'no'} · 2:${fx2 === null ? 'NA' : fx2 ? 'SÍ' : 'no'}`, source: ioSrc, status: 'OK' });
    }
    const camReady = plcAvail && io ? bool(io.camera_ready) : null;
    if (camReady !== null) {
      items.push({ label: 'Cámara READY', value: camReady ? 'lista' : 'no lista', source: ioSrc, status: camReady ? 'OK' : 'WARNING' });
    }

    const checklist: MaintChecklistItem[] = [
      { label: 'Conectar telemetry.io en el gateway', done: plcAvail },
      { label: 'Agregar O_CONVEYOR_MOTOR', done: convSignal },
      { label: 'Agregar I_FIXTURE_1_PRESENT', done: fx1 !== null },
      { label: 'Agregar I_FIXTURE_2_PRESENT', done: fx2 !== null },
      { label: 'Agregar I_CAMERA_READY/PASS/FAIL', done: camReady !== null },
      { label: 'Agregar I_GRIPPER_OPEN / I_GRIPPER_CLOSED', done: gOpen !== null || gClosed !== null },
    ];

    const plantState = activeAlarms.some((a) => a.severity === 'CRITICAL') ? 'CRITICAL'
      : activeAlarms.some((a) => a.severity === 'ALARM') ? 'ALARM'
      : activeAlarms.some((a) => a.severity === 'WARNING') ? 'WARNING'
      : (cbAvail || plcAvail) ? 'NOMINAL' : 'OFFLINE';
    const worstSeverity: Severity | null = activeAlarms.length ? activeAlarms[0].severity : null;
    const fault = !!cb && (cb.estop || cb.protStop || cb.collision || cb.motionErr !== 0);

    // Etapa / progreso / tiempo de ciclo. En REAL son null: SCADA está aislado de la
    // FSM y no recibe un bloque de ciclo, así que se muestra N/D (real-only, sin fake).
    // En DEMO se sintetiza un ciclo determinista (claramente marcado DEMO).
    let stage: string | null = null, cycleStep: number | null = null, cycleTotal: number | null = null, cycleTimeS: number | null = null;
    if (s.mode === 'DEMO') {
      const elapsed = s.clock % DEMO_CYCLE_DUR;
      cycleTotal = DEMO_CYCLE_STEPS;
      cycleStep = Math.min(DEMO_CYCLE_STEPS, Math.floor((elapsed / DEMO_CYCLE_DUR) * DEMO_CYCLE_STEPS) + 1);
      cycleTimeS = round1(elapsed);
      stage = demoStage(elapsed / DEMO_CYCLE_DUR);
    }
    const avgCycleTimeS = s.cycleTimes.length ? round1(s.cycleTimes.reduce((a, b) => a + b, 0) / s.cycleTimes.length) : null;
    const convWarnTxt = conveyor.warning === 'ALARM'
      ? `Conveyor encendido ${conveyor.onTimeS}s — detener y revisar`
      : conveyor.warning === 'WARNING'
        ? `Conveyor encendido ${conveyor.onTimeS}s — posible sobrecalentamiento`
        : null;

    const tags: Tag[] = [];
    io_.forEach((sig) => { if (sig.value !== null) tags.push({ name: sig.key, value: sig.value, source: sig.source }); });
    if (cbAvail && cb) {
      tags.push({ name: 'controller_temperature_c', value: round1(cb.ctrlTempC), unit: '°C', source: cbSrc });
      tags.push({ name: 'controller_speed_magnification_pct', value: cb.speedMagPct, unit: '%', source: cbSrc });
      joints.forEach((j) => {
        tags.push({ name: `joint_${j.index}_angle_deg`, value: j.angleDeg, unit: '°', source: cbSrc });
        tags.push({ name: `joint_${j.index}_temp_c`, value: j.tempC, unit: '°C', source: cbSrc });
        tags.push({ name: `joint_${j.index}_current_a`, value: j.currentA, unit: 'A', source: cbSrc });
      });
      if (cobot.tcp) { tags.push({ name: 'tcp_x_mm', value: cobot.tcp.xMm, unit: 'mm', source: cbSrc }); tags.push({ name: 'tcp_y_mm', value: cobot.tcp.yMm, unit: 'mm', source: cbSrc }); tags.push({ name: 'tcp_z_mm', value: cobot.tcp.zMm, unit: 'mm', source: cbSrc }); }
    }

    const history: ScadaHistory = {
      conveyorOnDurations: [...s.conveyorOnDurations],
      conveyorOnTime: s.conveyorOnTimeHist.map((p) => ({ ...p })),
      controllerTemps: s.controllerTemps.map((p) => ({ ...p })),
      jointTemps: s.jointTemps.map((p) => ({ t: p.t, temps: [...p.temps] })),
      cycleTimes: [...s.cycleTimes],
    };

    return {
      ts: s.clock,
      mode: s.mode,
      cobotLink, plcLink,
      overview: {
        plantState,
        stage,
        activeCafiId: null,
        cobot: { connected: cbAvail, enabled: !!cb?.enabled, moving: !!cb?.moving, fault },
        plcConnected: plcAvail,
        activeAlarms: activeAlarms.length,
        worstSeverity,
        conveyorWarning: convWarnTxt,
        cycleStep, cycleTotal, cycleTimeS, avgCycleTimeS,
      },
      io: io_,
      alarms: alarmsArr,
      cobot,
      conveyor,
      maintenance: { items, checklist },
      maintenanceLog: s.maintenanceLog.map((e) => ({ ...e })),
      history,
      tags,
    };
  }

  return { tick, snapshot, acknowledge, acknowledgeAll, resolve, addComment, setCobotTelemetry, setConnected, setPlcIo, setDemo, thresholds: SCADA_THRESHOLDS };
}

// CAMBIO 10: snapshot SCADA completo para dashboard / IA / logs.
export function buildScadaSnapshot(engine: ScadaEngine): ScadaSnapshot {
  return engine.snapshot();
}

function sevRank(x: Severity): number { return x === 'CRITICAL' ? 3 : x === 'ALARM' ? 2 : x === 'WARNING' ? 1 : 0; }
// Etiqueta de etapa según el avance (0..1) del ciclo DEMO sintético.
function demoStage(f: number): string {
  if (f < 0.18) return 'Pick conveyor';
  if (f < 0.36) return 'Place fixture';
  if (f < 0.50) return 'Rotación de mesa';
  if (f < 0.74) return 'Remachado';
  if (f < 0.88) return 'Inspección visión';
  return 'Place bin';
}
function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }

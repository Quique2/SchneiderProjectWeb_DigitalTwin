// ─────────────────────────────────────────────────────────────────────────────
// cellStateMachine.ts — Máquina de estados PURA de la celda Schneider.
//
// Implementa LOGICA_PLANTA_SCHNEIDER.md como SUBSISTEMAS CONCURRENTES que avanzan
// cada `tick(dt)`: banda · mesa (2 fixtures A/B, roles que se intercambian al
// girar 180°) · remachadora (30 s exactos) · visión · cobot (recurso único con
// scheduler por prioridades). Soporta DOS CAFIs en el disco a la vez.
//
// Reglas: SIN React/Three.js/DOM. Determinista (reloj simulado `clock`, sin
// Date.now salvo política de visión inyectable). La HMI sólo manda eventos y lee
// `snapshot()`. Interlocks de seguridad / anti-colisión: la mesa nunca gira con
// el cobot en zona, el cobot nunca entra a zona con la mesa en movimiento.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  CafiEntity,
  CafiState,
  CellSnapshot,
  CellState,
  CobotTask,
  CountsSnapshot,
  DiSnapshot,
  DoSnapshot,
  FixtureId,
  FixtureSnapshot,
  OperatorEvent,
  RivetingState,
  SimMode,
  TableState,
  Verdict,
  VisionState,
} from './cellStateTypes';

export const MAX_WAITING_CAFIS = 2;

/** Estados que cuentan como "esperando" en la banda (aún no tomados). */
const WAITING_STATES: ReadonlyArray<CafiState> = ['DISPENSED', 'ON_CONVEYOR_WAITING', 'AT_SENSOR'];
/** Estados en los que la pieza está montada en un fixture del disco. */
const MOUNTED_STATES: ReadonlyArray<CafiState> = ['IN_OUTSIDE_FIXTURE', 'IN_RIVET_FIXTURE', 'RIVETING', 'RIVETED'];

const WORK_ANGLE_DEG = 180;

// ── Tiempos simulados (segundos). El remachado es 30 s EXACTOS (spec). ───────
export interface CellSimConfig {
  beltDelay: number;
  pickConveyor: number;
  placeOutside: number;
  pickRiveted: number;
  placeVision: number;
  inspect: number;
  pickVision: number;
  placeBin: number;
  rotate: number;       // giro de 180°
  riveting: number;     // dwell de remachado (30 s exactos)
  recoverySlow: number; // movimientos lentos de recuperación (RESTART)
  /** Multiplicador global de velocidad (1 = normal). El remachado lo ignora. */
  speed: number;
  /** Probabilidad de PASS para la política de visión por defecto. */
  passProb: number;
}

export const DEFAULT_CONFIG: CellSimConfig = {
  beltDelay: 1.5,
  pickConveyor: 1.6,
  placeOutside: 1.6,
  pickRiveted: 1.6,
  placeVision: 1.6,
  inspect: 1.6,
  pickVision: 1.6,
  placeBin: 1.6,
  rotate: 2.5,
  riveting: 30.0,
  recoverySlow: 3.0,
  speed: 1,
  passProb: 0.7,
};

export type VisionPolicy = () => Verdict;

export interface CreateCellOptions {
  config?: Partial<CellSimConfig>;
  visionPolicy?: VisionPolicy;
}

function ease(u: number): number {
  const c = Math.min(1, Math.max(0, u));
  return 0.5 * (1 - Math.cos(Math.PI * c));
}

export function createCellStateMachine(opts: CreateCellOptions = {}) {
  const cfg: CellSimConfig = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
  let visionPolicy: VisionPolicy =
    opts.visionPolicy ?? (() => (Math.random() < cfg.passProb ? 'PASS' : 'FAIL'));

  // ── Estado interno ─────────────────────────────────────────────────────────
  let mode: SimMode = 'HMI';
  let cell: CellState = 'IDLE';
  let clock = 0;

  let cafis: CafiEntity[] = [];
  let nextId = 1;
  let activeCafiId: number | null = null;
  let committedCafiId: number | null = null; // pieza remachada en flujo prioritario

  // Mesa: índice 0 (0°, outside=A) o 1 (180°, outside=B)
  let tableAtIndex: 0 | 1 = 0;
  let angleDeg = 0;
  let tableMoving = false;
  let tableT = 0;
  let fromAngle = 0;
  let toAngle = 0;
  let tableState: TableState = 'HOME';

  // Cobot
  let cobotTask: CobotTask = 'IDLE';
  let cobotT = 0;
  // Lockstep visual: cuando hay un cobot VISUAL (escena 3D) ejecutando la
  // secuencia, éste señala el fin de la tarea con notifyCobotVisualDone(). La
  // tarea se completa con ESA señal (o con el timer de taskDuration como tope).
  // Headless/tests: nadie señala → se usa el timer (comportamiento original).
  let cobotVisualDone = false;

  // Remachado / visión
  let riveting: RivetingState = 'IDLE';
  let rivetT = 0;
  let vision: VisionState = 'IDLE';
  let visionT = 0;
  let lastVerdict: Verdict | null = null;

  // Banda
  let beltT = 0;

  // Contadores / fault / debug
  let accepted = 0;
  let rejected = 0;
  let faultReason = '';
  let pausedByDebug = false;
  // FINALIZAR: fin de operación normal. No es STOP. Deja de alimentar conveyor y
  // de aceptar CAFIs nuevos; el cobot termina/drena el trabajo en proceso y, al
  // quedar libre, la celda pasa a IDLE y el cobot va a HOME (único camino a HOME).
  let finalizing = false;

  // ── Helpers ──────────────────────────────────────────────────────────────
  const dur = (seconds: number): number => seconds / Math.max(0.0001, cfg.speed);
  /** El remachado NO se acelera con `speed`: 30 s reales (spec). */
  const rivetDur = (): number => cfg.riveting;

  function outsideFixtureId(): FixtureId { return tableAtIndex === 0 ? 'A' : 'B'; }
  function rivetFixtureId(): FixtureId { return tableAtIndex === 0 ? 'B' : 'A'; }

  function waitingCafis(): CafiEntity[] {
    return cafis.filter((c) => WAITING_STATES.includes(c.state));
  }
  function sensorCafi(): CafiEntity | null {
    return cafis.find((c) => c.state === 'AT_SENSOR') ?? null;
  }
  function carriedCafi(): CafiEntity | null {
    return cafis.find((c) => c.state === 'IN_GRIPPER') ?? null;
  }
  function fixturePiece(fid: FixtureId): CafiEntity | null {
    return cafis.find((c) => c.fixtureId === fid && MOUNTED_STATES.includes(c.state)) ?? null;
  }
  function activeCafi(): CafiEntity | null {
    return activeCafiId == null ? null : cafis.find((c) => c.id === activeCafiId) ?? null;
  }
  function tableSettled(): boolean { return !tableMoving; }
  function cobotInTableZone(): boolean {
    return cobotTask === 'PLACE_OUTSIDE' || cobotTask === 'PICK_RIVETED';
  }
  function outsideFixturePresent(): boolean { return fixturePiece(outsideFixtureId()) != null; }
  function outsideFixtureAvailable(): boolean { return !outsideFixturePresent(); }

  function touch(c: CafiEntity): void { c.updatedAt = clock; }
  function setCafi(c: CafiEntity, state: CafiState): void {
    c.state = state;
    c.poseKey = state;
    touch(c);
  }

  // ── Gating de spawn / start ────────────────────────────────────────────────
  function spawnBlockReason(): string {
    if (mode !== 'HMI') return 'MODO DEBUG';
    if (finalizing) return 'FINALIZANDO';
    if (cell === 'FAULT' || faultReason) return 'FAULT';
    if (cell !== 'RUNNING') return 'CELDA NO RUNNING';
    if (sensorCafi()) return 'SENSOR OCUPADO';
    if (waitingCafis().length >= MAX_WAITING_CAFIS) return 'COLA LLENA (2)';
    return '';
  }
  function spawnAllowed(): boolean { return spawnBlockReason() === ''; }

  function startBlockReason(): string {
    if (mode !== 'HMI') return 'MODO DEBUG';
    if (cell !== 'IDLE') return 'CELDA NO IDLE';
    if (sensorCafi()) return 'SENSOR OCUPADO';
    if (fixturePiece('A') || fixturePiece('B')) return 'FIXTURE OCUPADO';
    if (cafis.some((c) => c.state === 'IN_INSPECTION')) return 'VISIÓN OCUPADA';
    return '';
  }

  // ── Acciones de operador ───────────────────────────────────────────────────
  function start(): boolean {
    if (startBlockReason() !== '') return false;
    cell = 'RUNNING';
    faultReason = '';
    pausedByDebug = false;
    return true;
  }

  function placeCafi(): boolean {
    if (finalizing) return false;   // FINALIZAR: no aceptar CAFIs nuevos
    if (!spawnAllowed()) return false;
    const c: CafiEntity = {
      id: nextId++,
      state: 'DISPENSED',
      riveted: false,
      verdict: null,
      fixtureId: null,
      bin: null,
      poseKey: 'DISPENSED',
      createdAt: clock,
      updatedAt: clock,
    };
    cafis.push(c);
    return true;
  }

  function stop(): boolean {
    if (cell !== 'RUNNING') return false;
    cell = 'PAUSED';
    pausedByDebug = false;
    return true;
  }

  function resume(): boolean {
    if (cell !== 'PAUSED') return false;
    if (faultReason) return false;
    cell = 'RUNNING';
    return true;
  }

  // FINALIZAR (≠ STOP): termina la operación normal de forma segura. Marca
  // `finalizing`; el scheduler deja de alimentar del conveyor pero SÍ termina lo
  // que ya está en proceso. Cuando el cobot queda libre y no hay piezas en proceso,
  // la celda pasa a IDLE y el cobot va a HOME (ver maybeFinishFinalize).
  function finalize(): boolean {
    if (cell !== 'RUNNING') return false;
    finalizing = true;
    return true;
  }

  // Piezas todavía "en proceso" activo (excluye cola del conveyor, bins y done).
  function activeProcessingRemains(): boolean {
    return cafis.some((c) =>
      c.state === 'IN_GRIPPER' || c.state === 'IN_OUTSIDE_FIXTURE' ||
      c.state === 'IN_RIVET_FIXTURE' || c.state === 'RIVETING' || c.state === 'RIVETED' ||
      c.state === 'IN_INSPECTION' || c.state === 'INSPECTED_PASS' || c.state === 'INSPECTED_FAIL');
  }

  // Cierra el FINALIZAR cuando el cobot está libre y ya no queda trabajo activo.
  function maybeFinishFinalize(): void {
    if (!finalizing) return;
    if (cobotTask !== 'IDLE') return;
    if (activeProcessingRemains()) return;
    finalizing = false;
    cell = 'IDLE';                 // único camino normal a IDLE → el cobot va a HOME
    activeCafiId = null;
    committedCafiId = null;
  }

  function restart(): boolean {
    if (cell !== 'PAUSED') return false;
    cell = 'RESTARTING';
    // Recuperación segura: si lleva pieza → bin de rechazo; si no → HOME lento.
    const carried = carriedCafi();
    if (carried) {
      activeCafiId = carried.id;
      startTask('RECOVERY_REJECT');
    } else {
      activeCafiId = null;
      startTask('RECOVERY_HOME');
    }
    return true;
  }

  function confirmClean(): boolean {
    if (cell !== 'CLEANING_REQUIRED') return false;
    // El operador retiró físicamente las piezas atrapadas; se descartan.
    cafis = cafis.filter((c) => c.state === 'ACCEPTED_BIN' || c.state === 'REJECTED_BIN');
    cell = 'IDLE';
    resetMechanicalState();
    return true;
  }

  function reset(): boolean {
    if (cell !== 'PAUSED' && cell !== 'FAULT' && cell !== 'CLEANING_REQUIRED') return false;
    doSafeReset();
    return true;
  }

  function resetMechanicalState(): void {
    activeCafiId = null;
    committedCafiId = null;
    tableAtIndex = 0;
    angleDeg = 0;
    tableMoving = false;
    tableState = 'HOME';
    cobotTask = 'IDLE';
    cobotT = 0;
    riveting = 'IDLE';
    rivetT = 0;
    vision = 'IDLE';
    visionT = 0;
    beltT = 0;
    faultReason = '';
    pausedByDebug = false;
    finalizing = false;
  }

  function doSafeReset(): void {
    cell = 'IDLE';
    cafis = [];
    accepted = 0;
    rejected = 0;
    lastVerdict = null;
    resetMechanicalState();
  }

  function switchMode(next: SimMode): boolean {
    if (next === mode) return true;
    if (next === 'DEBUG') {
      if (cell === 'RUNNING') { cell = 'PAUSED'; pausedByDebug = true; }
      mode = 'DEBUG';
      return true;
    }
    mode = 'HMI';
    return true;
  }

  function raiseFault(reason: string): void {
    cell = 'FAULT';
    faultReason = reason;
    tableMoving = false;
    cobotTask = 'IDLE';
    riveting = riveting === 'ACTIVE' ? 'FAULT' : riveting;
  }

  function dispatch(ev: OperatorEvent): boolean {
    switch (ev.type) {
      case 'START': return start();
      case 'PLACE_CAFI': return placeCafi();
      case 'STOP': return stop();
      case 'RESUME': return resume();
      case 'RESTART': return restart();
      case 'CONFIRM_CLEAN': return confirmClean();
      case 'RESET': return reset();
      case 'FINALIZE': return finalize();
      case 'SWITCH_MODE': return switchMode(ev.mode);
      default: return false;
    }
  }

  // ── Subsistema: banda ──────────────────────────────────────────────────────
  function advanceBelt(dt: number): void {
    if (sensorCafi()) return; // sólo una pieza AT_SENSOR a la vez
    const incoming = cafis
      .filter((c) => c.state === 'DISPENSED' || c.state === 'ON_CONVEYOR_WAITING')
      .sort((a, b) => a.id - b.id)[0];
    if (!incoming) return;
    if (incoming.state === 'DISPENSED') { setCafi(incoming, 'ON_CONVEYOR_WAITING'); beltT = 0; return; }
    beltT += dt;
    if (beltT >= dur(cfg.beltDelay)) { setCafi(incoming, 'AT_SENSOR'); beltT = 0; }
  }

  // ── Subsistema: mesa rotatoria ─────────────────────────────────────────────
  function shouldRotate(): boolean {
    if (tableMoving) return false;
    if (cobotInTableZone()) return false;       // anti-colisión
    if (cobotTask !== 'IDLE') return false;      // no girar mientras el cobot trabaja cerca
    if (riveting === 'ACTIVE') return false;     // no girar remachando
    const outPiece = fixturePiece(outsideFixtureId());
    const rivPiece = fixturePiece(rivetFixtureId());
    if (outPiece && outPiece.state === 'RIVETED') return false; // primero recoger la remachada
    const rivDoneOrEmpty = !rivPiece || rivPiece.state === 'RIVETED';
    const freshOutside = !!outPiece && outPiece.state === 'IN_OUTSIDE_FIXTURE';
    const rivetedAtRivet = !!rivPiece && rivPiece.state === 'RIVETED';
    return rivDoneOrEmpty && (freshOutside || rivetedAtRivet);
  }

  function startRotate(): void {
    tableMoving = true;
    tableT = 0;
    fromAngle = angleDeg;
    const nextIndex: 0 | 1 = tableAtIndex === 0 ? 1 : 0;
    toAngle = nextIndex * WORK_ANGLE_DEG;
    tableState = nextIndex === 1 ? 'INDEXING_TO_WORK' : 'INDEXING_TO_HOME';
  }

  function onRotationComplete(): void {
    // La pieza que quedó en el fixture de remachado (si es fresca) se arma.
    const rivPiece = fixturePiece(rivetFixtureId());
    if (rivPiece && rivPiece.state === 'IN_OUTSIDE_FIXTURE' && !rivPiece.riveted) {
      setCafi(rivPiece, 'IN_RIVET_FIXTURE');
      riveting = 'ARMED';
    }
  }

  function advanceTable(dt: number): void {
    if (tableMoving) {
      tableT += dt;
      const d = dur(cfg.rotate);
      const u = Math.min(1, tableT / d);
      angleDeg = fromAngle + (toAngle - fromAngle) * ease(u);
      if (u >= 1) {
        angleDeg = toAngle;
        tableAtIndex = toAngle === 0 ? 0 : 1;
        tableMoving = false;
        tableState = tableAtIndex === 0 ? 'HOME' : 'AT_WORK';
        onRotationComplete();
      }
    } else if (shouldRotate()) {
      startRotate();
    }
  }

  // ── Subsistema: remachadora (30 s exactos) ─────────────────────────────────
  function advanceRiveting(dt: number): void {
    const rivPiece = fixturePiece(rivetFixtureId());
    if (riveting === 'ARMED') {
      if (rivPiece && rivPiece.state === 'IN_RIVET_FIXTURE' && tableSettled() && !cobotInTableZone()) {
        riveting = 'ACTIVE';
        rivetT = 0;
        setCafi(rivPiece, 'RIVETING');
      }
      return;
    }
    if (riveting === 'ACTIVE') {
      if (!rivPiece || rivPiece.state !== 'RIVETING') { riveting = 'IDLE'; return; }
      rivetT += dt;
      if (rivetT >= rivetDur()) {
        rivPiece.riveted = true;
        setCafi(rivPiece, 'RIVETED');
        riveting = 'IDLE';
      }
    }
  }

  // ── Subsistema: visión ─────────────────────────────────────────────────────
  function advanceVision(dt: number): void {
    const v = cafis.find((c) => c.state === 'IN_INSPECTION') ?? null;
    if (!v) { if (vision === 'PRESENT' || vision === 'INSPECTING') vision = 'IDLE'; return; }
    if (vision === 'PRESENT') { vision = 'INSPECTING'; visionT = 0; return; }
    if (vision === 'INSPECTING') {
      visionT += dt;
      if (visionT >= dur(cfg.inspect)) {
        const verd = visionPolicy();
        v.verdict = verd;
        lastVerdict = verd;
        setCafi(v, verd === 'PASS' ? 'INSPECTED_PASS' : 'INSPECTED_FAIL');
        vision = verd === 'PASS' ? 'PASS' : 'FAIL';
      }
    }
  }

  // ── Subsistema: cobot (scheduler por prioridades) ──────────────────────────
  function startTask(t: CobotTask): void { cobotTask = t; cobotT = 0; cobotVisualDone = false; }

  function taskDuration(t: CobotTask): number {
    switch (t) {
      case 'PICK_CONVEYOR': return dur(cfg.pickConveyor);
      case 'PLACE_OUTSIDE': return dur(cfg.placeOutside);
      case 'PICK_RIVETED': return dur(cfg.pickRiveted);
      case 'PLACE_VISION': return dur(cfg.placeVision);
      case 'PICK_VISION': return dur(cfg.pickVision);
      case 'PLACE_ACCEPT':
      case 'PLACE_REJECT': return dur(cfg.placeBin);
      case 'RECOVERY_REJECT':
      case 'RECOVERY_HOME': return dur(cfg.recoverySlow);
      default: return 0;
    }
  }

  function cobotPickNext(): void {
    if (cobotTask !== 'IDLE') return;
    if (cell !== 'RUNNING') return;

    const carried = carriedCafi();
    if (carried) {
      activeCafiId = carried.id;
      if (carried.riveted && carried.verdict == null) startTask('PLACE_VISION');
      else if (carried.verdict != null) startTask(carried.verdict === 'PASS' ? 'PLACE_ACCEPT' : 'PLACE_REJECT');
      else startTask('PLACE_OUTSIDE');
      return;
    }
    // Pieza ya inspeccionada esperando en la cámara → recogerla (flujo prioritario).
    const inspected = cafis.find((c) => c.state === 'INSPECTED_PASS' || c.state === 'INSPECTED_FAIL') ?? null;
    if (inspected) { activeCafiId = inspected.id; startTask('PICK_VISION'); return; }
    // Pieza remachada en el fixture externo → retirarla (prioridad absoluta).
    const outPiece = fixturePiece(outsideFixtureId());
    if (outPiece && outPiece.state === 'RIVETED' && tableSettled()) {
      activeCafiId = outPiece.id;
      committedCafiId = outPiece.id;
      startTask('PICK_RIVETED');
      return;
    }
    // Alimentar del conveyor sólo si no hay pieza remachada en proceso y el
    // fixture externo está libre. Si FINALIZANDO, no se alimentan piezas nuevas
    // (sólo se drena lo que ya está en proceso).
    if (committedCafiId == null && !finalizing) {
      const s = sensorCafi();
      if (s && outsideFixtureAvailable() && tableSettled()) {
        activeCafiId = s.id;
        startTask('PICK_CONVEYOR');
      }
    }
  }

  function completeTask(): void {
    const a = activeCafi();
    switch (cobotTask) {
      case 'PICK_CONVEYOR':
        if (a && a.state === 'AT_SENSOR') setCafi(a, 'IN_GRIPPER');
        break;
      case 'PLACE_OUTSIDE':
        if (a) { a.fixtureId = outsideFixtureId(); setCafi(a, 'IN_OUTSIDE_FIXTURE'); }
        activeCafiId = null;
        break;
      case 'PICK_RIVETED':
        if (a) { a.fixtureId = null; setCafi(a, 'IN_GRIPPER'); }
        break;
      case 'PLACE_VISION':
        if (a) { setCafi(a, 'IN_INSPECTION'); vision = 'PRESENT'; }
        break;
      case 'PICK_VISION':
        if (a) { setCafi(a, 'IN_GRIPPER'); vision = 'IDLE'; }
        break;
      case 'PLACE_ACCEPT':
        if (a) { a.bin = 'ACCEPT'; setCafi(a, 'ACCEPTED_BIN'); accepted++; }
        committedCafiId = null;
        activeCafiId = null;
        break;
      case 'PLACE_REJECT':
        if (a) { a.bin = 'REJECT'; setCafi(a, 'REJECTED_BIN'); rejected++; }
        committedCafiId = null;
        activeCafiId = null;
        break;
      case 'RECOVERY_REJECT':
        if (a) { a.bin = 'REJECT'; setCafi(a, 'REJECTED_BIN'); rejected++; }
        committedCafiId = null;
        activeCafiId = null;
        startTask('RECOVERY_HOME');
        return; // sigue en RESTARTING
      case 'RECOVERY_HOME':
        finishRestart();
        break;
      default:
        break;
    }
    cobotTask = 'IDLE';
  }

  function advanceCobot(dt: number): void {
    if (cobotTask === 'IDLE') {
      cobotPickNext();
      if (cobotTask === 'IDLE') maybeFinishFinalize(); // libre y sin más trabajo → cierra FINALIZAR
      return;
    }
    cobotT += dt;
    // Completa con la señal del cobot VISUAL (lockstep) o con el timer (fallback).
    if (cobotVisualDone || cobotT >= taskDuration(cobotTask)) { cobotVisualDone = false; completeTask(); }
  }

  // ── Recuperación (RESTART → CLEANING_REQUIRED) ─────────────────────────────
  function advanceRecovery(dt: number): void {
    if (cobotTask === 'IDLE') return;
    cobotT += dt;
    if (cobotVisualDone || cobotT >= taskDuration(cobotTask)) { cobotVisualDone = false; completeTask(); }
  }

  function finishRestart(): void {
    cobotTask = 'IDLE';
    // Las piezas que quedaron en fixtures / banda / visión requieren retiro manual.
    cafis.forEach((c) => {
      if (c.state !== 'ACCEPTED_BIN' && c.state !== 'REJECTED_BIN' && c.state !== 'DONE') {
        setCafi(c, 'MANUAL_REMOVAL_REQUIRED');
        c.fixtureId = null;
      }
    });
    riveting = 'IDLE';
    vision = 'IDLE';
    cell = 'CLEANING_REQUIRED';
  }

  // ── Seguridad / anti-colisión ──────────────────────────────────────────────
  function checkSafety(): void {
    if (cobotInTableZone() && tableMoving) {
      raiseFault('COLISIÓN: cobot en zona con la mesa girando');
    }
  }

  // ── Avance principal ───────────────────────────────────────────────────────
  function tick(dt: number): void {
    if (dt <= 0) return;
    if (mode !== 'HMI') return;
    if (cell !== 'RUNNING' && cell !== 'RESTARTING') return; // IDLE/PAUSED/FAULT/CLEANING congelan
    clock += dt * 1000;
    if (cell === 'RUNNING') {
      advanceBelt(dt);
      advanceTable(dt);
      advanceRiveting(dt);
      advanceVision(dt);
      advanceCobot(dt);
      checkSafety();
    } else {
      advanceRecovery(dt);
    }
  }

  // ── Derivados para el snapshot ─────────────────────────────────────────────
  function limitHome(): boolean { return !tableMoving && tableAtIndex === 0; }
  function limitWork(): boolean { return !tableMoving && tableAtIndex === 1; }
  function rivetingDoneFlag(): boolean { return cafis.some((c) => c.state === 'RIVETED'); }
  function rivetProgress(): number {
    return riveting === 'ACTIVE' ? Math.min(1, rivetT / rivetDur()) : 0;
  }

  function fixtureSnap(fid: FixtureId): FixtureSnapshot {
    const piece = fixturePiece(fid);
    return {
      id: fid,
      cafiId: piece ? piece.id : null,
      role: fid === outsideFixtureId() ? 'OUTSIDE' : 'RIVET',
      present: piece != null,
    };
  }

  function di(): DiSnapshot {
    return {
      conveyor: sensorCafi() != null,
      rivet: fixturePiece(rivetFixtureId()) != null,
      vision: cafis.some((c) => c.state === 'IN_INSPECTION' || c.state === 'INSPECTED_PASS' || c.state === 'INSPECTED_FAIL'),
      cobotReady: cobotTask === 'IDLE',
    };
  }
  function doLamps(): DoSnapshot {
    const gripClose = carriedCafi() != null;
    return {
      convMotor: cafis.some((c) => c.state === 'ON_CONVEYOR_WAITING'),
      disco: tableMoving,
      remachado: riveting === 'ACTIVE',
      camara: vision === 'INSPECTING',
      gripOpen: !gripClose,
      gripClose,
      solLeft: outsideFixturePresent() || fixturePiece(rivetFixtureId()) != null,
      reservado: false,
    };
  }

  function counts(): CountsSnapshot {
    const inProcess = cafis.filter(
      (c) => c.state !== 'ACCEPTED_BIN' && c.state !== 'REJECTED_BIN' && c.state !== 'DONE' && c.state !== 'MANUAL_REMOVAL_REQUIRED',
    ).length;
    return { accepted, rejected, inProcess };
  }

  function snapshot(): CellSnapshot {
    const s = sensorCafi();
    return {
      mode,
      cell,
      cafis: cafis.map((c) => ({ ...c })),
      activeCafiId,
      waitingCount: waitingCafis().length,
      sensorOccupied: s != null,
      sensorCafiId: s ? s.id : null,
      spawnAllowed: spawnAllowed(),
      spawnBlockReason: spawnBlockReason(),
      turntable: {
        state: tableState,
        angleDeg: Math.round(angleDeg * 10) / 10,
        target: tableAtIndex === 0 ? 'HOME' : 'WORK',
        moving: tableMoving,
        limitHome: limitHome(),
        limitWork: limitWork(),
      },
      outsideFixtureId: outsideFixtureId(),
      rivetFixtureId: rivetFixtureId(),
      fixtureA: fixtureSnap('A'),
      fixtureB: fixtureSnap('B'),
      cobotTask,
      cobotBusy: cobotTask !== 'IDLE',
      cobotInTableZone: cobotInTableZone(),
      riveting,
      rivetingDone: rivetingDoneFlag(),
      rivetProgress: rivetProgress(),
      rivetSecondsLeft: riveting === 'ACTIVE' ? Math.max(0, Math.ceil(rivetDur() - rivetT)) : 0,
      vision,
      verdict: lastVerdict,
      counts: counts(),
      cleaningPending: cell === 'CLEANING_REQUIRED' && cafis.some((c) => c.state === 'MANUAL_REMOVAL_REQUIRED'),
      finalizing,
      fault: cell === 'FAULT' || faultReason !== '',
      faultReason,
      di: di(),
      do: doLamps(),
      clock,
    };
  }

  function setVisionPolicy(p: VisionPolicy): void { visionPolicy = p; }
  function angleRad(): number { return (angleDeg * Math.PI) / 180; }
  function getMode(): SimMode { return mode; }
  function isPausedByDebug(): boolean { return pausedByDebug; }
  // El cobot VISUAL (escena 3D) avisa que terminó la secuencia de la tarea actual
  // → la FSM completa esa tarea (lockstep). Sólo afecta si hay una tarea en curso.
  function notifyCobotVisualDone(): void { if (cobotTask !== 'IDLE') cobotVisualDone = true; }

  return {
    start, placeCafi, stop, resume, restart, confirmClean, reset, finalize, switchMode, dispatch,
    tick,
    snapshot, angleRad, getMode, isPausedByDebug,
    setVisionPolicy, notifyCobotVisualDone,
    config: cfg,
  };
}

export type CellStateMachine = ReturnType<typeof createCellStateMachine>;

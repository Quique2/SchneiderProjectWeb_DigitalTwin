// ─────────────────────────────────────────────────────────────────────────────
// runAggregator.ts — Capa OBSERVADORA. Construye el RunModel a partir de
// snapshots sucesivos de la FSM SIN tocar cellStateMachine.ts.
//
// Estrategia:
//   · Contadores de sensores/actuadores = flancos de subida entre snapshots.
//   · Tiempos ON de actuadores = acumular Δreloj-simulado mientras el bool está ON.
//   · Producción = espejo de cycleStats/counts.
//   · Eventos de operador = derivados de transiciones de estado de celda (Fase 1).
//   · Ciclo de corrida = arranca al ver la celda activa; termina al volver a IDLE,
//     a FAULT, o por abort externo (cierre de ventana / fuente perdida).
//   · RESTART: captura la ZONA de cada CAFI antes de que la FSM la borre.
//
// Es testeable: el tiempo de pared entra como parámetro (nowMs), no usa Date.now.
// ─────────────────────────────────────────────────────────────────────────────

import type { CellSnapshot, CellState, CafiEntity, CafiState } from '../cellStateTypes';
import type {
  RunModel, RunStatus, CafiDetail, CafiZone, RunEvent,
  SensorCounters, ActuatorCounters, OperatorCounters,
} from './runTypes';

// Factories de contadores en cero. Locales (no importadas) para que este módulo no
// tenga imports de VALORES relativos → carga limpio bajo type-stripping de Node en
// los scripts de validación (los `import type` se borran y no necesitan resolverse).
function emptySensors(): SensorCounters {
  return {
    conveyorPhotoeye: 0, fixture1Present: 0, fixture2Present: 0,
    limitHome: 0, limitWork: 0, visionPresent: 0,
    cameraTrigger: 0, cameraPass: 0, cameraFail: 0, cameraNoRead: 0,
  };
}
function emptyActuators(): ActuatorCounters {
  return {
    gripperClose: 0, gripperOpen: 0,
    conveyorStarts: 0, conveyorOnMs: 0,
    tableTurns: 0, tableHomeToWork: 0, tableWorkToHome: 0, tableMovingMs: 0,
    rivetCycles: 0, rivetActiveMs: 0,
    stacklightGreen: 0, stacklightYellow: 0, stacklightRed: 0,
  };
}
function emptyOperator(): OperatorCounters {
  return {
    start: 0, stop: 0, resume: 0, restart: 0, confirmClean: 0, finalize: 0,
    manualReject: 0, manualReusable: 0, manualReview: 0,
  };
}

const ACTIVE_CELL_STATES: CellState[] = ['RUNNING', 'PAUSED', 'RESTARTING', 'CLEANING_REQUIRED'];
const TERMINAL_CAFI: CafiState[] = ['ACCEPTED_BIN', 'REJECTED_BIN', 'DONE'];
const MAX_DT_MS = 2000; // recorte de Δreloj para que un salto/gap no infle los tiempos ON

export interface RunAggregatorOptions {
  /** Asigna el número de corrida (Corrida 1, 2, 3…). Por defecto, contador interno. */
  allocRunNumber?: () => number;
  onRunStarted?: (run: RunModel) => void;
  onRunEnded?: (run: RunModel) => void;
}

function zoneOf(c: CafiEntity): CafiZone {
  switch (c.state) {
    case 'DISPENSED': case 'ON_CONVEYOR_WAITING': return 'CONVEYOR';
    case 'AT_SENSOR': return 'SENSOR';
    case 'IN_GRIPPER': return 'GRIPPER';
    case 'IN_OUTSIDE_FIXTURE': return 'OUTSIDE_FIXTURE';
    case 'IN_RIVET_FIXTURE': case 'RIVETING': case 'RIVETED': return 'RIVET_ZONE';
    case 'IN_INSPECTION': case 'INSPECTED_PASS': case 'INSPECTED_FAIL': return 'CAMERA';
    case 'ACCEPTED_BIN': case 'REJECTED_BIN': case 'DONE': return 'BIN';
    default: return 'UNKNOWN';
  }
}

function cafiDetailFrom(c: CafiEntity, prev?: CafiDetail): CafiDetail {
  const sa = c.sensorAt ?? null;
  const da = c.doneAt ?? null;
  const cycleTimeMs = sa != null && da != null ? da - sa : null;
  return {
    id: c.id,
    finalState: c.state,
    verdict: c.verdict,
    fixtureId: c.fixtureId,
    sensorAt: sa,
    placedFixtureAt: c.placedFixtureAt ?? null,
    rivetedAt: c.rivetedAt ?? null,
    atCameraAt: c.atCameraAt ?? null,
    doneAt: da,
    cycleTimeMs,
    removalZone: prev?.removalZone ?? null,
    manualDecision: prev?.manualDecision ?? null,
    manualNote: prev?.manualNote ?? null,
  };
}

export class RunAggregator {
  private prev: CellSnapshot | null = null;
  private run: RunModel | null = null;
  private cafiMap = new Map<number, CafiDetail>();
  private internalRunNo = 0;
  private finalizeSeen = false;   // se observó FINALIZAR (snapshot.finalizing) en esta corrida
  private restartSeen = false;    // la corrida pasó por RESTARTING/CLEANING_REQUIRED
  private opts: RunAggregatorOptions;

  constructor(opts: RunAggregatorOptions = {}) {
    this.opts = opts;
  }

  getCurrentRun(): RunModel | null {
    return this.run;
  }

  /** ¿La corrida activa tiene CAFIs sin terminar? (para decidir abort). */
  hasCafisInProcess(): boolean {
    if (!this.run) return false;
    for (const c of this.cafiMap.values()) {
      if (!TERMINAL_CAFI.includes(c.finalState) && c.finalState !== 'MANUAL_REMOVAL_REQUIRED') return true;
      if (c.finalState === 'MANUAL_REMOVAL_REQUIRED') return true;
    }
    return false;
  }

  /** Procesa un snapshot nuevo. nowMs = reloj de pared del monitor. */
  ingest(snapshot: CellSnapshot, nowMs: number): void {
    // 1. ¿Arrancar corrida?
    if (!this.run) {
      const transitionedIntoActive = this.prev && this.prev.cell === 'IDLE' && snapshot.cell === 'RUNNING';
      const openedMidRun = !this.prev && ACTIVE_CELL_STATES.includes(snapshot.cell);
      if (transitionedIntoActive || openedMidRun) {
        this.startRun(snapshot, nowMs);
        this.prev = snapshot;          // baseline: no contar flancos del primer frame
        return;
      }
      this.prev = snapshot;
      return;
    }

    // 2. Corrida activa: actualizar todo.
    const prev = this.prev;
    if (prev) {
      this.countSensorEdges(prev, snapshot);
      this.countActuatorEdges(prev, snapshot);
      this.accumulateOnTimes(prev, snapshot);
      this.deriveOperatorEvents(prev, snapshot, nowMs);
      this.captureRestartZones(prev, snapshot);
    }
    this.updateProduction(snapshot);
    this.updateCafis(snapshot, nowMs);
    this.run.finalCellState = snapshot.cell;
    this.run.durationMs = nowMs - this.run.startedAtMs;

    // Banderas que deciden el ESTADO FINAL de la corrida.
    if (snapshot.finalizing) this.finalizeSeen = true;
    if (snapshot.cell === 'RESTARTING' || snapshot.cell === 'CLEANING_REQUIRED') this.restartSeen = true;

    // 3. ¿Terminar corrida? Esperamos a que la planta drene (cell IDLE = sin CAFIs
    //    en proceso porque la FSM ya volvió a reposo).
    const end = this.endStatusFor(prev, snapshot);
    if (end) this.endRun(snapshot, nowMs, end);

    this.prev = snapshot;
  }

  /** Abort externo: cierre de ventana o pérdida de la fuente. */
  abortCurrentRun(reason: RunStatus, nowMs: number): RunModel | null {
    if (!this.run || this.run.status !== 'ACTIVE') return null;
    // Marca los CAFIs en proceso como abortados en el detalle.
    for (const c of this.cafiMap.values()) {
      if (!TERMINAL_CAFI.includes(c.finalState)) {
        this.pushEvent(nowMs, this.prev?.clock ?? 0, 'CAFI_ABORTED', `CAFI ${c.id} abortado (${reason})`, c.id);
      }
    }
    this.endRun(this.prev ?? undefined, nowMs, reason);
    return this.run;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  private startRun(s: CellSnapshot, nowMs: number): void {
    const number = this.opts.allocRunNumber ? this.opts.allocRunNumber() : ++this.internalRunNo;
    this.cafiMap = new Map();
    this.finalizeSeen = false;
    this.restartSeen = false;
    this.run = {
      id: `run-${number}-${nowMs}`,
      number,
      startedAtMs: nowMs,
      startedClock: s.clock,
      endedAtMs: null,
      endedClock: null,
      status: 'ACTIVE',
      finalCellState: s.cell,
      durationMs: 0,
      production: {
        cellState: s.cell,
        completed: 0, accepted: 0, rejected: 0, inProcess: 0,
        review: 0, reusable: 0, aborted: 0,
        currentCycleMs: 0, averageCycleMs: 0, lastCycleMs: 0, last5AvgMs: 0,
        cobotIdlePct: 0, waitCameraMs: 0, waitTableMs: 0, waitRivetMs: 0, waitOtherMs: 0,
      },
      sensors: emptySensors(),
      actuators: emptyActuators(),
      operator: emptyOperator(),
      cafis: [],
      events: [],
    };
    this.run.operator.start += 1;
    this.pushEvent(nowMs, s.clock, 'RUN_START', `Corrida ${number} iniciada (celda ${s.cell})`);
    this.updateProduction(s);
    this.updateCafis(s, nowMs);
    this.opts.onRunStarted?.(this.run);
  }

  private endStatusFor(prev: CellSnapshot | null, s: CellSnapshot): RunStatus | null {
    if (s.cell === 'FAULT') return 'FAULTED';
    // Volver a IDLE desde un estado activo = fin de corrida. El motivo decide el estado:
    //   RESTART (pasó por RESTARTING/CLEANING) → ABORTED_RESTART
    //   FINALIZAR (finalizing visto)          → COMPLETED_BY_FINALIZE
    //   resto                                  → COMPLETED
    if (prev && ACTIVE_CELL_STATES.includes(prev.cell) && s.cell === 'IDLE') {
      if (this.restartSeen) return 'ABORTED_RESTART';
      if (this.finalizeSeen) return 'COMPLETED_BY_FINALIZE';
      return 'COMPLETED';
    }
    return null;
  }

  private endRun(s: CellSnapshot | undefined, nowMs: number, status: RunStatus): void {
    if (!this.run || this.run.status !== 'ACTIVE') return;
    this.run.status = status;
    this.run.endedAtMs = nowMs;
    this.run.endedClock = s ? s.clock : (this.prev?.clock ?? null);
    this.run.durationMs = nowMs - this.run.startedAtMs;
    if (s) this.run.finalCellState = s.cell;
    // FINALIZAR ocurre una vez por corrida; normalizamos el contador desde la bandera.
    if (this.finalizeSeen && this.run.operator.finalize === 0) this.run.operator.finalize = 1;
    this.run.cafis = Array.from(this.cafiMap.values());
    this.pushEvent(nowMs, s?.clock ?? this.prev?.clock ?? 0, 'RUN_END', `Corrida ${this.run.number} terminada (${status})`);
    this.opts.onRunEnded?.(this.run);
  }

  // ── Contadores por flanco ────────────────────────────────────────────────────
  private rise(prev: boolean, now: boolean): boolean { return !prev && now; }

  private countSensorEdges(p: CellSnapshot, s: CellSnapshot): void {
    const sc = this.run!.sensors;
    if (this.rise(p.di.conveyor, s.di.conveyor)) sc.conveyorPhotoeye += 1;
    if (this.rise(p.fixtureA.present, s.fixtureA.present)) sc.fixture1Present += 1;
    if (this.rise(p.fixtureB.present, s.fixtureB.present)) sc.fixture2Present += 1;
    if (this.rise(p.turntable.limitHome, s.turntable.limitHome)) sc.limitHome += 1;
    if (this.rise(p.turntable.limitWork, s.turntable.limitWork)) sc.limitWork += 1;
    if (this.rise(p.di.vision, s.di.vision)) sc.visionPresent += 1;
    if (this.rise(p.do.camara, s.do.camara)) sc.cameraTrigger += 1;
    if (this.rise(p.vision === 'PASS', s.vision === 'PASS')) sc.cameraPass += 1;
    if (this.rise(p.vision === 'FAIL', s.vision === 'FAIL')) sc.cameraFail += 1;
  }

  private countActuatorEdges(p: CellSnapshot, s: CellSnapshot): void {
    const a = this.run!.actuators;
    if (this.rise(p.do.gripClose, s.do.gripClose)) a.gripperClose += 1;
    if (this.rise(p.do.gripOpen, s.do.gripOpen)) a.gripperOpen += 1;
    if (this.rise(p.do.convMotor, s.do.convMotor)) a.conveyorStarts += 1;
    if (this.rise(p.turntable.moving, s.turntable.moving)) a.tableTurns += 1;
    if (this.rise(p.turntable.state === 'INDEXING_TO_WORK', s.turntable.state === 'INDEXING_TO_WORK')) a.tableHomeToWork += 1;
    if (this.rise(p.turntable.state === 'INDEXING_TO_HOME', s.turntable.state === 'INDEXING_TO_HOME')) a.tableWorkToHome += 1;
    if (this.rise(p.do.remachado, s.do.remachado)) a.rivetCycles += 1;
  }

  private accumulateOnTimes(p: CellSnapshot, s: CellSnapshot): void {
    let dt = s.clock - p.clock;
    if (dt <= 0 || dt > MAX_DT_MS) return; // reset/gap/pausa → no acumular
    const a = this.run!.actuators;
    if (s.do.convMotor) a.conveyorOnMs += dt;
    if (s.do.remachado) a.rivetActiveMs += dt;
    if (s.turntable.moving) a.tableMovingMs += dt;
  }

  private deriveOperatorEvents(p: CellSnapshot, s: CellSnapshot, nowMs: number): void {
    const op = this.run!.operator;
    if (p.cell !== s.cell) {
      this.pushEvent(nowMs, s.clock, 'CELL_STATE', `Celda ${p.cell} → ${s.cell}`, undefined, p.cell, s.cell);
      if (p.cell === 'RUNNING' && s.cell === 'PAUSED') op.stop += 1;
      else if (p.cell === 'PAUSED' && s.cell === 'RUNNING') op.resume += 1;
      else if (p.cell === 'PAUSED' && (s.cell === 'RESTARTING' || s.cell === 'CLEANING_REQUIRED')) op.restart += 1;
      else if (p.cell === 'CLEANING_REQUIRED' && s.cell === 'IDLE') op.confirmClean += 1;
    }
    // FINALIZAR vía snapshot: solo cuando hay trabajo que drenar `finalizing` se
    // vuelve true por uno o más frames. Si NO hay trabajo, la FSM va a IDLE en el
    // mismo tick y el snapshot nunca lo muestra → por eso el camino robusto es el
    // operatorEvent del bus (noteOperatorEvent). El conteo se normaliza en endRun.
    if (this.rise(p.finalizing, s.finalizing)) {
      this.finalizeSeen = true;
      this.pushEvent(nowMs, s.clock, 'OPERATOR', 'FINALIZAR (drenando planta)');
    }
  }

  /** La ventana HMI anunció un evento de operador por el bus (Fase 2B / FINALIZAR). */
  noteOperatorEvent(event: 'START' | 'STOP' | 'RESUME' | 'RESTART' | 'CONFIRM_CLEAN' | 'FINALIZE', nowMs: number): void {
    if (!this.run || this.run.status !== 'ACTIVE') return;
    if (event === 'FINALIZE') {
      this.finalizeSeen = true;
      this.pushEvent(nowMs, this.prev?.clock ?? 0, 'OPERATOR', 'FINALIZAR (operador)');
    } else if (event === 'RESTART') {
      this.restartSeen = true;
    }
    // START/STOP/RESUME/CONFIRM_CLEAN: sus contadores se derivan de la transición
    // de estado de celda (fiable), no del evento → aquí no se cuentan (evita doble).
  }

  private captureRestartZones(p: CellSnapshot, s: CellSnapshot): void {
    // Al entrar a RESTARTING, la ubicación de cada CAFI aún es legible; la FSM la
    // borra al pasar a CLEANING_REQUIRED. Capturamos la zona ANTES de perderla.
    if (p.cell !== 'RESTARTING' && s.cell === 'RESTARTING') {
      for (const c of s.cafis) {
        const d = this.cafiMap.get(c.id);
        if (d && d.removalZone == null) d.removalZone = zoneOf(c);
      }
    }
  }

  // ── Producción + CAFIs ───────────────────────────────────────────────────────
  private updateProduction(s: CellSnapshot): void {
    const r = this.run!;
    const cs = s.cycleStats;
    r.production.cellState = s.cell;
    r.production.accepted = s.counts.accepted;
    r.production.rejected = s.counts.rejected;
    r.production.inProcess = s.counts.inProcess;
    r.production.completed = cs?.completed ?? 0;
    r.production.currentCycleMs = cs?.currentCycleMs ?? 0;
    r.production.averageCycleMs = cs?.averageCycleMs ?? 0;
    r.production.lastCycleMs = cs?.lastCycleMs ?? 0;
    r.production.last5AvgMs = cs?.last5AvgMs ?? 0;
    r.production.cobotIdlePct = cs?.cobotIdlePct ?? 0;
    r.production.waitCameraMs = cs?.waitCameraMs ?? 0;
    r.production.waitTableMs = cs?.waitTableMs ?? 0;
    r.production.waitRivetMs = cs?.waitRivetMs ?? 0;
    r.production.waitOtherMs = cs?.waitOtherMs ?? 0;
  }

  private updateCafis(s: CellSnapshot, nowMs: number): void {
    for (const c of s.cafis) {
      const prevD = this.cafiMap.get(c.id);
      const wasDone = prevD?.doneAt != null;
      const d = cafiDetailFrom(c, prevD);
      this.cafiMap.set(c.id, d);
      if (!prevD) this.pushEvent(nowMs, s.clock, 'CAFI_NEW', `CAFI ${c.id} detectado`, c.id);
      if (!wasDone && d.doneAt != null) {
        this.pushEvent(nowMs, s.clock, 'CAFI_DONE',
          `CAFI ${c.id} terminado (${c.verdict ?? '—'}, ${d.cycleTimeMs ?? '?'} ms)`, c.id);
      }
    }
    this.run!.cafis = Array.from(this.cafiMap.values());
  }

  private pushEvent(t: number, simClock: number, type: string, description: string, cafiId?: number, prev?: string, next?: string): void {
    if (!this.run) return;
    const ev: RunEvent = { t, simClock, type, description };
    if (cafiId !== undefined) ev.cafiId = cafiId;
    if (prev !== undefined) ev.prev = prev;
    if (next !== undefined) ev.next = next;
    this.run.events.push(ev);
  }
}

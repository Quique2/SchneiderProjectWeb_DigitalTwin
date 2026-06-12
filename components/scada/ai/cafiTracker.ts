// ─────────────────────────────────────────────────────────────────────────────
// cafiTracker.ts — Seguimiento por CAFI INFERIDO de señales agregadas (real-only).
//
// El PLC real no manda IDs de CAFI; este tracker los infiere por flancos:
//  • flanco del fotoeléctrico → nuevo CAFI "esperando" en el conveyor.
//  • el ciclo de un CAFI ARRANCA cuando el conveyor comienza a moverlo.
//  • la etapa del pipeline (pick→fixture→remachado→inspección→resultado) se atribuye
//    al CAFI activo más antiguo (FIFO); los demás quedan "esperando".
//  • el ciclo TERMINA cuando el CAFI llega a su bin (veredicto de cámara = place).
// Soporta varios CAFIs a la vez (cola). No toca FSM/telemetría/Node-RED.
// ─────────────────────────────────────────────────────────────────────────────

export type CafiStage =
  | 'WAITING' | 'PICK' | 'FIXTURE' | 'RIVETING' | 'INSPECTION'
  | 'RESULT_PASS' | 'RESULT_FAIL' | 'DONE_ACCEPT' | 'DONE_REJECT' | 'COLLECTED';

// Capacidad máxima de CAFIs en la planta. Pasando de esto → alerta de recolección.
export const CAFI_CAPACITY = 8;

export interface CafiTrack {
  id: number;
  stage: CafiStage;
  label: string;                  // "Remachando CAFI 1", "CAFI 2 esperando"
  verdict: 'PASS' | 'FAIL' | null;
  step: number;                   // 1..10 (progreso)
  detectedAtS: number;
  cycleStartS: number | null;
  cycleTimeS: number | null;      // al completarse (conveyor→bin)
  elapsedS: number;               // tiempo en curso
  active: boolean;
}

// Señales que el tracker necesita (booleans crudos; null = sin dato).
export interface CafiIo {
  photoeye: boolean | null;
  conveyorMotor: boolean | null;
  cobotMoving: boolean | null;
  tableMoving: boolean | null;
  rivetActive: boolean | null;
  cameraTrigger: boolean | null;
  cameraPass: boolean | null;
  cameraFail: boolean | null;
  fixture1: boolean | null;
  fixture2: boolean | null;
}

export interface CafiTrackerSnap {
  cafis: CafiTrack[];             // activos + últimos completados
  total: number;
  accepted: number;
  rejected: number;
  inProcess: number;
  cycleTimes: number[];           // últimos 10 (s)
  lastCycleTimeS: number | null;
  running: boolean;               // hay un CAFI con ciclo en curso
  activeLabel: string | null;     // etiqueta del CAFI activo
  activeStep: number | null;
  overCapacity: boolean;          // inProcess > CAFI_CAPACITY → recoger CAFIs
}

export interface CafiSeed { total?: number; accepted?: number; rejected?: number; cycleTimes?: number[]; lastCycleTimeS?: number | null; }

const LIST_CAP = 10;        // CAFIs visibles (activos + completados recientes)
const CYCLE_CAP = 10;
const MIN_CYCLE_S = 3;      // descarta flancos espurios

const STEP: Record<CafiStage, number> = {
  WAITING: 1, PICK: 3, FIXTURE: 5, RIVETING: 6, INSPECTION: 8,
  RESULT_PASS: 9, RESULT_FAIL: 9, DONE_ACCEPT: 10, DONE_REJECT: 10, COLLECTED: 10,
};
const isTerminal = (s: CafiStage) => s === 'DONE_ACCEPT' || s === 'DONE_REJECT' || s === 'COLLECTED';
const on = (v: boolean | null): boolean => v === true;

export function labelFor(stage: CafiStage, id: number): string {
  switch (stage) {
    case 'WAITING': return `CAFI ${id} esperando`;
    case 'PICK': return `Pick CAFI ${id} (conveyor)`;
    case 'FIXTURE': return `CAFI ${id} en fixture`;
    case 'RIVETING': return `Remachando CAFI ${id}`;
    case 'INSPECTION': return `Inspección CAFI ${id}`;
    case 'RESULT_PASS': return `CAFI ${id}: aceptado`;
    case 'RESULT_FAIL': return `CAFI ${id}: rechazado`;
    case 'DONE_ACCEPT': return `CAFI ${id} → bin aceptado`;
    case 'DONE_REJECT': return `CAFI ${id} → bin rechazado`;
    case 'COLLECTED': return `CAFI ${id} recogido (manual)`;
  }
}

export interface CafiTracker {
  update: (io: CafiIo, clock: number, dt: number) => CafiTrackerSnap;
  snapshot: () => CafiTrackerSnap;
  collectActive: () => CafiTrackerSnap;   // operador recoge los CAFIs de la mesa
  reset: () => void;
}

export function createCafiTracker(seed?: CafiSeed): CafiTracker {
  let list: CafiTrack[] = [];
  let nextId = (seed?.total ?? 0) + 1;
  let accepted = seed?.accepted ?? 0;
  let rejected = seed?.rejected ?? 0;
  let cycleTimes: number[] = (seed?.cycleTimes ?? []).slice(-CYCLE_CAP);
  let lastCycleTimeS: number | null = seed?.lastCycleTimeS ?? null;

  let prevPhotoeye = false, prevPass = false, prevFail = false;

  // CAFI activo = el más antiguo no terminal.
  const activeCafi = (): CafiTrack | undefined => list.find((c) => c.active && !isTerminal(c.stage));

  function setStage(c: CafiTrack, stage: CafiStage): void {
    if (STEP[stage] < STEP[c.stage]) return;   // solo avanza (no regresa)
    c.stage = stage; c.step = STEP[stage]; c.label = labelFor(stage, c.id);
  }

  function finish(c: CafiTrack, verdict: 'PASS' | 'FAIL', clock: number): void {
    c.verdict = verdict;
    setStage(c, verdict === 'PASS' ? 'RESULT_PASS' : 'RESULT_FAIL');
    setStage(c, verdict === 'PASS' ? 'DONE_ACCEPT' : 'DONE_REJECT');
    const start = c.cycleStartS ?? c.detectedAtS;
    const dur = clock - start;
    c.cycleTimeS = dur >= MIN_CYCLE_S ? round1(dur) : c.elapsedS || round1(dur);
    c.active = false;
    if (verdict === 'PASS') accepted++; else rejected++;
    if (c.cycleTimeS !== null && c.cycleTimeS >= MIN_CYCLE_S) {
      lastCycleTimeS = c.cycleTimeS;
      cycleTimes.push(c.cycleTimeS);
      if (cycleTimes.length > CYCLE_CAP) cycleTimes.shift();
    }
  }

  function update(io: CafiIo, clock: number, dt: number): CafiTrackerSnap {
    // 1) Detección: flanco del fotoeléctrico → nuevo CAFI esperando.
    if (on(io.photoeye) && !prevPhotoeye) {
      const id = nextId++;
      list.push({
        id, stage: 'WAITING', label: labelFor('WAITING', id), verdict: null, step: 1,
        detectedAtS: clock, cycleStartS: on(io.conveyorMotor) ? clock : null,
        cycleTimeS: null, elapsedS: 0, active: true,
      });
    }
    if (io.photoeye !== null) prevPhotoeye = on(io.photoeye);

    // 2) Arranque del ciclo: cuando el conveyor se mueve (para los que esperan sin start).
    if (on(io.conveyorMotor)) list.forEach((c) => { if (c.active && c.cycleStartS === null) c.cycleStartS = clock; });

    // 3) Etapa dominante del pipeline (de las señales agregadas).
    const pipeline: CafiStage | null =
      on(io.rivetActive) ? 'RIVETING'
      : on(io.cameraTrigger) ? 'INSPECTION'
      : on(io.tableMoving) ? 'FIXTURE'
      : (on(io.fixture1) || on(io.fixture2)) ? 'FIXTURE'
      : on(io.cobotMoving) ? 'PICK'
      : null;

    const act = activeCafi();
    if (act && pipeline) setStage(act, pipeline);

    // 4) Veredicto de cámara (flanco) → cierra el CAFI activo (place en bin).
    const pass = on(io.cameraPass), fail = on(io.cameraFail);
    if (pass && !prevPass && act) finish(act, 'PASS', clock);
    else if (fail && !prevFail && act) finish(act, 'FAIL', clock);
    if (io.cameraPass !== null) prevPass = pass;
    if (io.cameraFail !== null) prevFail = fail;

    // 5) Elapsed de los activos.
    list.forEach((c) => { if (c.active && c.cycleStartS !== null) c.elapsedS = round1(clock - c.cycleStartS); });

    // 6) Cap: conserva activos + últimos completados.
    const done = list.filter((c) => !c.active);
    if (list.length > LIST_CAP && done.length) {
      const dropN = Math.min(done.length, list.length - LIST_CAP);
      const dropIds = new Set(done.slice(0, dropN).map((c) => c.id));
      list = list.filter((c) => !dropIds.has(c.id));
    }

    return snapshot();
  }

  function snapshot(): CafiTrackerSnap {
    const act = activeCafi();
    const inProcess = list.filter((c) => c.active).length;
    return {
      cafis: list.map((c) => ({ ...c })),
      total: nextId - 1,
      accepted, rejected, inProcess,
      cycleTimes: [...cycleTimes],
      lastCycleTimeS,
      running: !!(act && act.cycleStartS !== null),
      activeLabel: act ? act.label : null,
      activeStep: act ? act.step : null,
      overCapacity: inProcess > CAFI_CAPACITY,
    };
  }

  // El operador recoge los CAFIs de la mesa: marca los activos como recogidos
  // (terminal, NO cuentan como aceptado/rechazado) → inProcess vuelve a 0.
  function collectActive(): CafiTrackerSnap {
    list.forEach((c) => {
      if (c.active && !isTerminal(c.stage)) {
        c.stage = 'COLLECTED'; c.step = STEP.COLLECTED; c.label = labelFor('COLLECTED', c.id); c.active = false;
      }
    });
    return snapshot();
  }

  function reset(): void {
    list = []; nextId = 1; accepted = 0; rejected = 0; cycleTimes = []; lastCycleTimeS = null;
    prevPhotoeye = false; prevPass = false; prevFail = false;
  }

  return { update, snapshot, collectActive, reset };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

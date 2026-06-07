// ─────────────────────────────────────────────────────────────────────────────
// turntableSim.ts — Simulación de la mesa rotatoria (turntable) del Digital Twin
//
// Máquina de estados COMPLETA del disco giratorio + zona de remachado, alineada
// al contrato JSON acordado con la Raspberry Pi (PASO 6 / PASO 9 del brief).
//
//   HOME → MOVING_TO_WORK → WORK → RIVETING → RIVETING_DONE
//        → MOVING_TO_HOME → CYCLE_DONE → (HOME)
//
// Es 100% mock / sin hardware: corre en el navegador y produce exactamente el
// mismo JSON que emitirá el gateway FastAPI de la Raspberry. Así la web ya
// funciona "en simulación" hoy, y mañana sólo cambia la fuente (WebSocket real)
// sin tocar la HMI ni la escena 3D.
//
// Visual:  HOME = 0°,  WORK = 180°.  El ángulo se interpola con easing coseno.
// ─────────────────────────────────────────────────────────────────────────────

export type TurntablePosition =
  | 'HOME'
  | 'MOVING_TO_WORK'
  | 'WORK'
  | 'RIVETING'
  | 'RIVETING_DONE'
  | 'MOVING_TO_HOME'
  | 'CYCLE_DONE'
  | 'ERROR';

export type TurntableTarget = 'HOME' | 'WORK';
export type LastDirection = 'TO_WORK' | 'TO_HOME' | 'NONE';

/** Estado de la celda al estilo de la HMI V62 (state_manager de la simulación). */
export type CellState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'FAULT';

/** Veredicto de la cámara de visión (Cognex), igual que la HMI ROS. */
export type CameraVerdict = '' | 'PASS' | 'FAIL';

/** Bloque `turntable` del contrato JSON (idéntico al de la Raspberry). */
export interface TurntableContract {
  angle_deg: number;
  position: TurntablePosition;
  moving: boolean;
  target: TurntableTarget;
  last_direction: LastDirection;
  limit_home: boolean;
  limit_work: boolean;
  riveting: boolean;
  riveting_done: boolean;
  fault: boolean;
  message: string;
}

/** Sobre completo del contrato (lo que viaja por `/ws/turntable`). */
export interface TurntableTelemetry {
  timestamp: string;
  ok: boolean;
  _demo: boolean;
  turntable: TurntableContract;
}

/** Snapshot completo que consume la HMI (mesa + celda + lámparas DI/DO). */
export interface SimSnapshot {
  cell: CellState;
  cafiPresent: boolean;
  spawnAllowed: boolean;
  verdict: CameraVerdict;
  cycleStage: string;
  faultReason: string;
  turntable: TurntableContract;
  telemetry: TurntableTelemetry;
  /** Lámparas Digital Input (4) de la HMI V62. */
  di: { conveyor: boolean; rivet: boolean; vision: boolean; cobotReady: boolean };
  /** Lámparas Digital Output (8) de la HMI V62. */
  do: {
    convMotor: boolean;
    disco: boolean;
    remachado: boolean;
    camara: boolean;
    gripOpen: boolean;
    gripClose: boolean;
    solLeft: boolean;
    reservado: boolean;
  };
}

// ── Parámetros de tiempo (segundos) ──────────────────────────────────────────
// En el navegador el ciclo es "snappy" para demo. El remachado real en la
// Raspberry dura RIVET_SECONDS_REAL (10 s); aquí usamos un valor presentable.
export const MOVE_SECONDS = 2.5; // giro 0°↔180°
export const RIVET_SECONDS = 3.0; // remachado simulado (web)
export const RIVET_SECONDS_REAL = 10.0; // dwell físico de la Raspberry (referencia)
export const SETTLE_SECONDS = 0.5; // asentamiento en WORK / DONE
export const DONE_SECONDS = 1.5; // tiempo mostrando "REMACHADO ACABADO"

const WORK_ANGLE_DEG = 180;

/** Easing coseno (idéntico al usado por el SequencePlayer de la celda). */
function ease(u: number): number {
  const c = Math.min(1, Math.max(0, u));
  return 0.5 * (1 - Math.cos(Math.PI * c));
}

function nowIso(): string {
  // En la app (navegador) `Date` está disponible normalmente.
  return new Date().toISOString();
}

/**
 * Simulador puro de la mesa. Sin React, sin DOM: avanza con tick(dt).
 * Ideal para la web (mock) y como espejo del comportamiento de la Raspberry.
 */
export function createTurntableSim() {
  // Estado de celda (HMI)
  let cell: CellState = 'IDLE';
  let cafiPresent = false;
  let verdict: CameraVerdict = '';
  let faultReason = '';

  // Estado de la mesa
  let position: TurntablePosition = 'HOME';
  let phaseT = 0; // tiempo dentro de la fase actual
  let angleDeg = 0;
  let lastDirection: LastDirection = 'NONE';
  let riveting = false;
  let rivetingDone = false;

  function cycleActive(): boolean {
    return position !== 'HOME' && position !== 'ERROR';
  }

  function spawnAllowed(): boolean {
    return cell === 'RUNNING' && position === 'HOME' && !cafiPresent;
  }

  // ── Acciones de operador (botones HMI V62) ────────────────────────────────
  function start(): boolean {
    if (cell !== 'IDLE') return false;
    cell = 'RUNNING';
    faultReason = '';
    return true;
  }

  /** "Colocar CAFI": coloca la pieza y dispara el ciclo de la mesa. */
  function placeCafi(): boolean {
    if (!spawnAllowed()) return false;
    cafiPresent = true;
    verdict = '';
    rivetingDone = false;
    // Arranca el ciclo de la mesa hacia WORK.
    position = 'MOVING_TO_WORK';
    phaseT = 0;
    lastDirection = 'TO_WORK';
    return true;
  }

  function stop(): boolean {
    if (cell !== 'RUNNING') return false;
    cell = 'PAUSED';
    return true;
  }

  function reset(): boolean {
    if (cell !== 'PAUSED' && cell !== 'FAULT') return false;
    cell = 'IDLE';
    position = 'HOME';
    phaseT = 0;
    angleDeg = 0;
    lastDirection = 'NONE';
    riveting = false;
    rivetingDone = false;
    cafiPresent = false;
    verdict = '';
    faultReason = '';
    return true;
  }

  // ── Avance de la máquina de estados ───────────────────────────────────────
  function tick(dt: number): void {
    // Pausa congela el ciclo (STOP). FAULT también detiene.
    if (cell === 'PAUSED' || cell === 'FAULT') return;
    if (!cycleActive()) return;

    phaseT += dt;

    switch (position) {
      case 'MOVING_TO_WORK': {
        const u = phaseT / MOVE_SECONDS;
        angleDeg = WORK_ANGLE_DEG * ease(u);
        if (u >= 1) {
          angleDeg = WORK_ANGLE_DEG;
          position = 'WORK';
          phaseT = 0;
        }
        break;
      }
      case 'WORK': {
        if (phaseT >= SETTLE_SECONDS) {
          position = 'RIVETING';
          phaseT = 0;
          riveting = true;
        }
        break;
      }
      case 'RIVETING': {
        if (phaseT >= RIVET_SECONDS) {
          riveting = false;
          rivetingDone = true;
          position = 'RIVETING_DONE';
          phaseT = 0;
          // Veredicto de visión (demo: siempre PASS salvo fallo inyectado).
          verdict = 'PASS';
        }
        break;
      }
      case 'RIVETING_DONE': {
        if (phaseT >= SETTLE_SECONDS) {
          position = 'MOVING_TO_HOME';
          phaseT = 0;
          lastDirection = 'TO_HOME';
        }
        break;
      }
      case 'MOVING_TO_HOME': {
        const u = phaseT / MOVE_SECONDS;
        angleDeg = WORK_ANGLE_DEG * (1 - ease(u));
        if (u >= 1) {
          angleDeg = 0;
          position = 'CYCLE_DONE';
          phaseT = 0;
        }
        break;
      }
      case 'CYCLE_DONE': {
        if (phaseT >= DONE_SECONDS) {
          // Ciclo terminado: la pieza sale, la mesa queda lista en HOME.
          position = 'HOME';
          phaseT = 0;
          cafiPresent = false;
          rivetingDone = false;
        }
        break;
      }
      default:
        break;
    }
  }

  // ── Derivados / mensajes ──────────────────────────────────────────────────
  function moving(): boolean {
    return position === 'MOVING_TO_WORK' || position === 'MOVING_TO_HOME';
  }

  function target(): TurntableTarget {
    // Hacia dónde apunta el siguiente movimiento, igual que los ejemplos del brief.
    if (position === 'HOME' || position === 'MOVING_TO_WORK') return 'WORK';
    return 'HOME';
  }

  function limitHome(): boolean {
    return position === 'HOME' || position === 'CYCLE_DONE';
  }

  function limitWork(): boolean {
    return position === 'WORK' || position === 'RIVETING' || position === 'RIVETING_DONE';
  }

  function message(): string {
    switch (position) {
      case 'HOME':
        return cell === 'IDLE' ? 'Esperando inicio' : 'En HOME — listo para CAFI';
      case 'MOVING_TO_WORK':
        return 'Moviendo hacia zona de remachado';
      case 'WORK':
        return 'En posición de remachado';
      case 'RIVETING':
        return 'Remachando';
      case 'RIVETING_DONE':
        return 'Remachado terminado';
      case 'MOVING_TO_HOME':
        return 'Regresando a HOME';
      case 'CYCLE_DONE':
        return 'REMACHADO ACABADO';
      case 'ERROR':
        return faultReason || 'Fault';
      default:
        return '';
    }
  }

  function cycleStage(): string {
    if (cell === 'IDLE') return 'IDLE';
    if (cell === 'PAUSED') return 'PAUSED';
    switch (position) {
      case 'HOME':
        return cafiPresent ? 'LOAD' : 'READY';
      case 'MOVING_TO_WORK':
        return 'INDEX_TO_WORK';
      case 'WORK':
        return 'AT_WORK';
      case 'RIVETING':
        return 'RIVETING';
      case 'RIVETING_DONE':
        return 'INSPECT';
      case 'MOVING_TO_HOME':
        return 'INDEX_TO_HOME';
      case 'CYCLE_DONE':
        return 'DONE';
      default:
        return position;
    }
  }

  function turntable(): TurntableContract {
    return {
      angle_deg: Math.round(angleDeg * 10) / 10,
      position,
      moving: moving(),
      target: target(),
      last_direction: lastDirection,
      limit_home: limitHome(),
      limit_work: limitWork(),
      riveting,
      riveting_done: rivetingDone,
      fault: cell === 'FAULT' || position === 'ERROR',
      message: message(),
    };
  }

  function telemetry(): TurntableTelemetry {
    return { timestamp: nowIso(), ok: true, _demo: true, turntable: turntable() };
  }

  function snapshot(): SimSnapshot {
    const tt = turntable();
    return {
      cell,
      cafiPresent,
      spawnAllowed: spawnAllowed(),
      verdict,
      cycleStage: cycleStage(),
      faultReason,
      turntable: tt,
      telemetry: { timestamp: nowIso(), ok: true, _demo: true, turntable: tt },
      di: {
        conveyor: cafiPresent && position === 'HOME',
        rivet: limitWork(), // sensor de presencia en fixture de remachado
        vision: position === 'RIVETING_DONE' || (position === 'CYCLE_DONE' && verdict !== ''),
        cobotReady: !moving(),
      },
      do: {
        convMotor: false,
        disco: moving(), // disco indexando
        remachado: riveting,
        camara: position === 'RIVETING_DONE',
        gripOpen: false,
        gripClose: false,
        solLeft: limitWork(), // solenoide de fixture activo en estación de trabajo
        reservado: false,
      },
    };
  }

  /** Ángulo del disco en radianes (para escribir en discAngleRef de la escena). */
  function angleRad(): number {
    return (angleDeg * Math.PI) / 180;
  }

  return {
    start,
    placeCafi,
    stop,
    reset,
    tick,
    snapshot,
    telemetry,
    angleRad,
    angleDeg: () => angleDeg,
  };
}

export type TurntableSim = ReturnType<typeof createTurntableSim>;

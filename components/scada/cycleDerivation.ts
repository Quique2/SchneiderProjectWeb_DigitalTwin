// ─────────────────────────────────────────────────────────────────────────────
// cycleDerivation.ts — Derivación del estado de CICLO a partir de señales REALES.
//
// El gateway todavía NO publica un bloque FSM (etapa/progreso/tiempos). Pero SÍ
// publica el I/O canónico (telemetry.io: conveyor, mesa, gripper, fixtures, cámara,
// rivet, stacklight) y la telemetría del cobot (moving/ready/fault). Estas funciones
// PURAS infieren etapa, estado general y progreso aproximado SOLO de esas señales
// reales — no inventan nada: si no hay señal, devuelven 'Sin señal'/step 0 y el motor
// lo trata como N/D (real-only).
//
// El TIMER de ciclo, los contadores PASS/FAIL (rising-edge) y la persistencia son
// ESTADO y viven en scadaEngine.ts; aquí solo está la lógica de inferencia sin estado.
// ─────────────────────────────────────────────────────────────────────────────

import type { ScadaIoFrame } from './cobotTelemetrySource';

export type DerivedCellState = 'RUNNING' | 'WARNING' | 'FAULT' | 'IDLE' | 'NOT_CONNECTED';
export type CycleSource = 'IO' | 'COBOT' | 'MIXED' | 'NONE';

// Pipeline lógico de 10 etapas (CAMBIO 5). El step que devuelve inferStage indexa
// (1..10) sobre este pipeline para la barra de progreso aproximada.
export const CYCLE_PIPELINE: string[] = [
  'Espera CAFI',          // 1
  'Conveyor',             // 2
  'Pick conveyor',        // 3
  'Place fixture',        // 4
  'Mesa / index',         // 5
  'Remachado',            // 6
  'Pick fixture',         // 7
  'Cámara',               // 8
  'Clasificación',        // 9
  'Safe return / listo',  // 10
];
export const CYCLE_TOTAL = CYCLE_PIPELINE.length;

// Subconjunto de la telemetría del cobot que la derivación necesita.
export interface CobotLite {
  moving: boolean;
  ready: boolean;       // robot_enabled
  fault: boolean;       // estop / protective stop / colisión / motion errcode
  available: boolean;   // hay telemetría de cobot (REAL/STALE)
}

export interface DerivedStage {
  stage: string;        // etiqueta legible de la etapa actual
  step: number;         // 1..10 (0 = sin señal / sin progreso)
  source: CycleSource;  // de dónde salió la inferencia
}

// Solo cuenta como activo si la señal es estrictamente true (null/undefined = sin dato).
const on = (v: boolean | null | undefined): boolean => v === true;

function cycleSource(io: ScadaIoFrame | null, cb: CobotLite): CycleSource {
  const ioA = !!io, cA = cb.available;
  return ioA && cA ? 'MIXED' : ioA ? 'IO' : cA ? 'COBOT' : 'NONE';
}

// CAMBIO 3/4 — Etapa actual por PRIORIDAD sobre señales reales canónicas.
// Orden (alto → bajo): rivet > mesa > trigger cámara > resultado cámara >
// movimiento cobot > conveyor motor > fixture presente > photoeye > cámara lista > idle.
export function inferStage(io: ScadaIoFrame | null, cobot: CobotLite): DerivedStage {
  const src = cycleSource(io, cobot);

  if (!io) {
    // Solo telemetría de cobot disponible.
    if (cobot.available && cobot.moving) return { stage: 'Movimiento cobot', step: 3, source: src };
    if (cobot.available && cobot.ready) return { stage: 'En espera', step: 1, source: src };
    return { stage: 'Sin señal', step: 0, source: 'NONE' };
  }

  if (on(io.rivet_active))       return { stage: 'Remachando', step: 6, source: src };
  if (on(io.table_nema_moving))  return { stage: 'Mesa rotatoria', step: 5, source: src };
  if (on(io.camera_trigger))     return { stage: 'Inspección cámara', step: 8, source: src };
  if (on(io.camera_pass))        return { stage: 'Resultado: aceptado', step: 9, source: src };
  if (on(io.camera_fail))        return { stage: 'Resultado: rechazado', step: 9, source: src };
  if (on(io.camera_error))       return { stage: 'Error cámara', step: 8, source: src };
  if (on(io.camera_no_read))     return { stage: 'No-read cámara', step: 8, source: src };

  if (cobot.available && cobot.moving) {
    if (on(io.conveyor_photoeye)) return { stage: 'Pick conveyor / mov. cobot', step: 3, source: src };
    return { stage: 'Movimiento cobot', step: 3, source: src };
  }

  if (on(io.conveyor_motor_on)) {
    if (on(io.conveyor_photoeye) && cobot.ready) return { stage: 'CAFI en conveyor', step: 2, source: src };
    return { stage: 'Conveyor', step: 2, source: src };
  }

  if (on(io.fixture_1_present) || on(io.fixture_2_present)) return { stage: 'Fixture cargado', step: 4, source: src };
  if (on(io.conveyor_photoeye)) return { stage: 'CAFI en conveyor', step: 2, source: src };
  if (on(io.camera_ready))      return { stage: 'Cámara lista', step: 8, source: src };

  if (cobot.ready || cobot.available) return { stage: 'En espera', step: 1, source: src };
  return { stage: 'En espera', step: 1, source: src };
}

// CAMBIO 2 — Estado general derivado de torreta / alarmas críticas / ready.
export function inferCellState(io: ScadaIoFrame | null, cobot: CobotLite, hasCriticalAlarm: boolean): DerivedCellState {
  if (!io && !cobot.available) return 'NOT_CONNECTED';
  if (hasCriticalAlarm || cobot.fault || (io && on(io.stacklight_red))) return 'FAULT';
  if (io && on(io.stacklight_green)) return 'RUNNING';
  if (io && on(io.stacklight_yellow)) return 'WARNING';
  const anyOutput = !!io && (on(io.conveyor_motor_on) || on(io.table_nema_moving) || on(io.rivet_active) || on(io.camera_trigger));
  if (cobot.ready && !anyOutput && !cobot.moving) return 'IDLE';
  if (anyOutput || cobot.moving) return 'RUNNING';
  return 'IDLE';
}

// ¿Hay actividad de ciclo? Dispara/cierra el timer (CAMBIO 6).
export function hasCycleActivity(io: ScadaIoFrame | null, cobot: CobotLite): boolean {
  const anyOutput = !!io && (on(io.conveyor_motor_on) || on(io.table_nema_moving) || on(io.rivet_active) || on(io.camera_trigger));
  const photoeye = !!io && on(io.conveyor_photoeye);
  return anyOutput || photoeye || (cobot.available && cobot.moving);
}

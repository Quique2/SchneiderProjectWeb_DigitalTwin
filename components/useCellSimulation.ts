// ─────────────────────────────────────────────────────────────────────────────
// useCellSimulation.ts — Hook React que corre la máquina de estados de la celda.
//
// - Crea una instancia de createCellStateMachine() una sola vez.
// - Avanza la FSM en un loop requestAnimationFrame (dt real, clamp anti-saltos).
// - Re-renderiza la HMI ~10 Hz con un snapshot inmutable.
// - Opcionalmente escribe el ángulo del disco (rad) en `angleRef` (discAngleRef
//   de la escena 3D) para que el URDF gire siguiendo la simulación, SIN que el
//   resto de la escena tenga que conocer la lógica.
//
// La React/Three.js NO contienen lógica de negocio: sólo consumen este snapshot
// y mandan eventos. (Plan de Codex: "No meter lógica pesada en React".)
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createCellStateMachine,
  type CellStateMachine,
  type CreateCellOptions,
} from './cellStateMachine';
import type { CellSnapshot, SimMode } from './cellStateTypes';

const RENDER_INTERVAL_MS = 100; // refresco de la HMI (≈10 Hz, como la HMI ROS)

export interface UseCellSimulation {
  snapshot: CellSnapshot;
  /** Acceso directo a la instancia (para el binder visual de la escena). */
  machine: CellStateMachine;
  start: () => void;
  placeCafi: () => void;
  stop: () => void;
  resume: () => void;
  restart: () => void;
  confirmClean: () => void;
  reset: () => void;
  finalize: () => void;
  switchMode: (mode: SimMode) => void;
}

export function useCellSimulation(
  angleRef?: React.MutableRefObject<number>,
  opts?: CreateCellOptions,
): UseCellSimulation {
  // La instancia vive una sola vez por montaje del componente.
  const machine = useMemo(() => createCellStateMachine(opts), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [snapshot, setSnapshot] = useState<CellSnapshot>(() => machine.snapshot());
  const angleRefStable = useRef(angleRef);
  angleRefStable.current = angleRef;

  useEffect(() => {
    let raf = 0;
    let prev = performance.now();
    let lastRender = 0;

    const loop = (t: number) => {
      const dt = Math.min(0.1, (t - prev) / 1000); // clamp al volver a la pestaña
      prev = t;

      machine.tick(dt);
      // Sólo en modo HMI la simulación es dueña del disco. En DEBUG se deja el
      // ref a los controles manuales (slider de mesa / SequencePlayer).
      const ar = angleRefStable.current;
      if (ar && machine.getMode() === 'HMI') ar.current = machine.angleRad();

      if (t - lastRender >= RENDER_INTERVAL_MS) {
        lastRender = t;
        setSnapshot(machine.snapshot());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [machine]);

  // Acciones: aplican el evento y refrescan el snapshot de inmediato para que
  // la UI responda sin esperar al siguiente frame.
  const refresh = () => setSnapshot(machine.snapshot());
  return {
    snapshot,
    machine,
    start: () => { machine.start(); refresh(); },
    placeCafi: () => { machine.placeCafi(); refresh(); },
    stop: () => { machine.stop(); refresh(); },
    resume: () => { machine.resume(); refresh(); },
    restart: () => { machine.restart(); refresh(); },
    confirmClean: () => { machine.confirmClean(); refresh(); },
    reset: () => { machine.reset(); refresh(); },
    finalize: () => { machine.finalize(); refresh(); },
    switchMode: (mode: SimMode) => { machine.switchMode(mode); refresh(); },
  };
}

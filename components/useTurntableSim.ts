// ─────────────────────────────────────────────────────────────────────────────
// useTurntableSim.ts — Hook React que corre la simulación de la mesa rotatoria.
//
// - Crea un createTurntableSim() una sola vez.
// - Avanza la máquina de estados en un loop requestAnimationFrame (dt real).
// - Escribe el ángulo (radianes) en `angleRef` (el discAngleRef de la escena 3D),
//   de modo que el disco URDF gira siguiendo la simulación, sin tocar nada más.
// - Re-renderiza la HMI ~10 veces/seg con un snapshot del contrato.
//
// La web queda en "modo simulación" puro (mock, sin hardware). Cuando exista la
// Raspberry real, basta sustituir la fuente del snapshot por el WebSocket
// `/ws/turntable` — el contrato JSON es idéntico.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { createTurntableSim, type SimSnapshot, type TurntableSim } from './turntableSim';

const RENDER_INTERVAL_MS = 100; // refresco de la HMI (≈10 Hz, como la HMI ROS)

export interface UseTurntableSim {
  snapshot: SimSnapshot;
  start: () => void;
  placeCafi: () => void;
  stop: () => void;
  reset: () => void;
}

export function useTurntableSim(
  angleRef?: React.MutableRefObject<number>,
): UseTurntableSim {
  const simRef = useRef<TurntableSim | null>(null);
  if (simRef.current === null) simRef.current = createTurntableSim();
  const sim = simRef.current;

  const [snapshot, setSnapshot] = useState<SimSnapshot>(() => sim.snapshot());

  useEffect(() => {
    let raf = 0;
    let prev = performance.now();
    let lastRender = 0;

    const loop = (t: number) => {
      const dt = Math.min(0.1, (t - prev) / 1000); // clamp para evitar saltos al volver a la pestaña
      prev = t;

      sim.tick(dt);
      if (angleRef) angleRef.current = sim.angleRad();

      if (t - lastRender >= RENDER_INTERVAL_MS) {
        lastRender = t;
        setSnapshot(sim.snapshot());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [sim, angleRef]);

  return {
    snapshot,
    start: () => { sim.start(); setSnapshot(sim.snapshot()); },
    placeCafi: () => { sim.placeCafi(); setSnapshot(sim.snapshot()); },
    stop: () => { sim.stop(); setSnapshot(sim.snapshot()); },
    reset: () => { sim.reset(); setSnapshot(sim.snapshot()); },
  };
}

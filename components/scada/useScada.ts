// ─────────────────────────────────────────────────────────────────────────────
// useScada.ts — Hook React que corre el motor SCADA y expone el snapshot.
// Independiente de la FSM / Celda 3D: NO toca ninguna lógica existente.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from 'react';
import { createScadaEngine, type ScadaEngine } from './scadaEngine';
import type { ScadaSnapshot } from './scadaTypes';

const REFRESH_MS = 250; // ~4 Hz, suficiente para un HMI SCADA

export interface UseScada {
  snapshot: ScadaSnapshot;
  engine: ScadaEngine;
  acknowledge: (id: string) => void;
  acknowledgeAll: () => void;
}

export function useScada(): UseScada {
  const engine = useMemo(() => createScadaEngine(), []);
  const [snapshot, setSnapshot] = useState<ScadaSnapshot>(() => engine.snapshot());
  const engineRef = useRef(engine);
  engineRef.current = engine;

  useEffect(() => {
    let raf = 0;
    let prev = performance.now();
    let last = 0;
    const loop = (t: number) => {
      const dt = Math.min(0.1, (t - prev) / 1000);
      prev = t;
      engineRef.current.tick(dt);
      if (t - last >= REFRESH_MS) { last = t; setSnapshot(engineRef.current.snapshot()); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return {
    snapshot,
    engine,
    acknowledge: (id: string) => { engine.acknowledge(id); setSnapshot(engine.snapshot()); },
    acknowledgeAll: () => { engine.acknowledgeAll(); setSnapshot(engine.snapshot()); },
  };
}

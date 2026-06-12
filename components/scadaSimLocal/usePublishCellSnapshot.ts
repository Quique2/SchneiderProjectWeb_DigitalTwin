// ─────────────────────────────────────────────────────────────────────────────
// usePublishCellSnapshot.ts — La Celda 3D PUBLICA el snapshot de la FSM al bus
// SCADA SIM (BroadcastChannel). Reemplaza al viejo usePublishSimToNodeRed: NO usa
// red, NO usa Node-RED, NO toca la FSM. Publica throttled (~4 Hz) para no saturar
// el canal. Si no hay snapshot todavía, no publica.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import type { CellSnapshot } from '../cellStateTypes';
import { createScadaSimBus, type ScadaSimBus } from './bus';

const PUBLISH_INTERVAL_MS = 250; // ~4 Hz

/**
 * Publica el snapshot al bus y DEVUELVE el bus, para que la ventana principal
 * pueda anunciar eventos de operador (p.ej. FINALIZAR) por el mismo canal. El bus
 * se crea de forma perezosa (ref) para estar disponible desde el primer render.
 */
export function usePublishCellSnapshot(snapshot: CellSnapshot | null | undefined): ScadaSimBus {
  const busRef = useRef<ScadaSimBus | null>(null);
  if (!busRef.current) busRef.current = createScadaSimBus();
  const latest = useRef<CellSnapshot | null>(null);

  // Mantén la referencia al snapshot más reciente sin recrear el intervalo.
  latest.current = snapshot ?? null;

  useEffect(() => {
    const bus = busRef.current!;
    const id = setInterval(() => {
      const s = latest.current;
      if (s) bus.publishSnapshot(s);
    }, PUBLISH_INTERVAL_MS);
    return () => {
      clearInterval(id);
      bus.close();
      busRef.current = null;
    };
  }, []);

  return busRef.current!;
}

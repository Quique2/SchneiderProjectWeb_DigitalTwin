// ─────────────────────────────────────────────────────────────────────────────
// useScada.ts — Hook React que corre el motor SCADA y expone el snapshot.
// Independiente de la FSM / Celda 3D: NO toca ninguna lógica existente.
//
// PERSISTENCIA EN MEMORIA (sesión): el motor y el loop viven a NIVEL DE MÓDULO
// (singletons), no dentro del componente. Así, aunque ScadaView se desmonte/monte
// (cambio de pestaña) o la ventana pase a segundo plano, el estado, el historial y
// los timers SIGUEN en tiempo real y NO se reinician — solo se reinician al
// refrescar la página (recarga del módulo).
//
// El driver usa setInterval (sigue disparando en background, a diferencia de rAF que
// el navegador pausa) y hace catch-up en visibilitychange/focus para refrescar al
// volver. El dt se calcula con performance.now() (tiempo real), y el motor lo capa a
// 2 s/tick para no saltar tras un congelado largo.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { createScadaEngine, type ScadaEngine } from './scadaEngine';
import type { ScadaSnapshot } from './scadaTypes';

const REFRESH_MS = 250; // ~4 Hz, suficiente para un HMI SCADA

export interface UseScada {
  snapshot: ScadaSnapshot;
  engine: ScadaEngine;
  acknowledge: (id: string) => void;
  acknowledgeAll: () => void;
  resolve: (id: string) => { ok: boolean; reason?: string };
  addComment: (text: string, alarmCode?: string | null) => void;
  confirmCafiCollection: () => void;
}

// ── Singletons de módulo (viven mientras no se refresque la página) ──────────────
let sharedEngine: ScadaEngine | null = null;
let lastSnap: ScadaSnapshot | null = null;
let driverStarted = false;
const subscribers = new Set<() => void>();

function getEngine(): ScadaEngine {
  if (!sharedEngine) sharedEngine = createScadaEngine();
  return sharedEngine;
}

function emit(): void {
  lastSnap = getEngine().snapshot();
  subscribers.forEach((fn) => fn());
}

// Arranca UNA sola vez el loop global. setInterval sigue corriendo en background
// (throttled a ~1 s) en vez de pausarse como requestAnimationFrame.
function startDriver(): void {
  if (driverStarted || typeof window === 'undefined') return;
  driverStarted = true;
  const eng = getEngine();
  let prev = performance.now();
  let lastEmit = 0;

  const step = () => {
    const t = performance.now();
    const dt = (t - prev) / 1000;   // segundos reales transcurridos
    prev = t;
    eng.tick(dt);                   // el motor capa el dt a 2 s/tick
    if (t - lastEmit >= REFRESH_MS) { lastEmit = t; emit(); }
  };

  setInterval(step, REFRESH_MS);

  // Al volver a primer plano: re-sincroniza el reloj (evita un salto enorme) y
  // refresca de inmediato para que la UI no se vea "congelada" un instante.
  const resync = () => { prev = performance.now(); step(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resync(); });
  window.addEventListener('focus', resync);
}

export function useScada(): UseScada {
  const engine = getEngine();
  const [snapshot, setSnapshot] = useState<ScadaSnapshot>(() => lastSnap ?? engine.snapshot());

  useEffect(() => {
    startDriver();
    const sub = () => { if (lastSnap) setSnapshot(lastSnap); };
    subscribers.add(sub);
    sub();   // pinta el último estado conocido de inmediato (sin esperar al primer tick)
    return () => { subscribers.delete(sub); };
  }, []);

  return {
    snapshot,
    engine,
    acknowledge: (id: string) => { engine.acknowledge(id); emit(); },
    acknowledgeAll: () => { engine.acknowledgeAll(); emit(); },
    resolve: (id: string) => { const r = engine.resolve(id); emit(); return r; },
    addComment: (text: string, alarmCode: string | null = null) => { engine.addComment(text, alarmCode); emit(); },
    confirmCafiCollection: () => { engine.confirmCafiCollection(); emit(); },
  };
}

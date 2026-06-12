// ─────────────────────────────────────────────────────────────────────────────
// bus.ts — Puente entre ventanas para SCADA SIM (SIN Node-RED, SIN red).
//
// La Celda 3D (ventana principal) PUBLICA el snapshot de la FSM por
// BroadcastChannel; la ventana SCADA SIM (#scada-sim) lo ESCUCHA. Misma sesión
// del navegador, mismo origen, distinta pestaña/ventana → BroadcastChannel es el
// transporte natural (no necesita servidor). Se espeja el último frame en
// localStorage para que un monitor recién abierto reciba algo de inmediato y
// como fallback si BroadcastChannel no existiera.
//
// FASE 1 = MONITOR PURO: solo se publican/escuchan snapshots. El canal de
// COMANDOS (ScadaSimCommand) queda TIPADO y con API lista, pero SCADA SIM NO
// envía comandos todavía (eso es Fase 2: SCADA SIM → Celda 3D).
// ─────────────────────────────────────────────────────────────────────────────

import type { CellSnapshot } from '../cellStateTypes';

export const SCADA_SIM_CHANNEL = 'schneider-scada-sim-bus';
export const SCADA_SIM_LAST_FRAME_KEY = 'scadaSim.lastFrame';
let commandSeq = 0;

/** Comandos SCADA SIM → Celda 3D. TIPADOS para Fase 2; NO usados en Fase 1. */
export type ScadaSimCommand =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'RESUME' }
  | { type: 'RESTART' }
  | { type: 'CONFIRM_CLEAN' }
  | { type: 'FINALIZE' }
  // Fase 2: clasificación manual tras RESTART (Pasa / No pasa / Reutilizable).
  | { type: 'CLASSIFY_CAFI'; cafiId: number; decision: 'PASS' | 'NO_PASS' | 'REUSABLE'; note?: string };

/** Frame de snapshot con marca de tiempo de pared (Date.now del emisor). */
export interface SnapshotFrame {
  t: number;
  snapshot: CellSnapshot;
}

/** Eventos de operador que la ventana HMI puede anunciar al monitor (Fase 2B). */
export type OperatorEventType = 'START' | 'STOP' | 'RESUME' | 'RESTART' | 'CONFIRM_CLEAN' | 'FINALIZE';

/** Envelope que viaja por el canal.
 *  Fase 1/2: solo se usa 'snapshot'. Los demás quedan TIPADOS para Fase 2B
 *  (heartbeat de fuente, eventos de operador explícitos, y comandos
 *  bidireccionales request/ack) pero NO se emiten todavía. */
export type ScadaSimBusMessage =
  | { kind: 'snapshot'; t: number; snapshot: CellSnapshot }
  | { kind: 'heartbeat'; t: number }
  | { kind: 'operatorEvent'; t: number; event: OperatorEventType }
  | { kind: 'command'; t: number; command: ScadaSimCommand }
  | { kind: 'commandRequest'; t: number; requestId: string; command: ScadaSimCommand }
  | { kind: 'commandAck'; t: number; requestId: string; command: ScadaSimCommand; ok: boolean; error?: string };

const KNOWN_KINDS = new Set(['snapshot', 'heartbeat', 'operatorEvent', 'command', 'commandRequest', 'commandAck']);

export interface ScadaSimBus {
  /** Celda 3D → bus: publica el snapshot actual de la FSM. */
  publishSnapshot(snapshot: CellSnapshot): void;
  /** HMI/Celda 3D → bus: anuncia un evento de operador (p.ej. FINALIZAR). */
  publishOperatorEvent(event: OperatorEventType): void;
  /** SCADA SIM → bus: envía un comando (Fase 2B; en Fase 2 nadie lo llama). */
  sendCommand(command: ScadaSimCommand): string;
  publishCommandAck(command: ScadaSimCommand, ok: boolean, requestId: string, error?: string): void;
  /** Suscribe un handler a todos los mensajes del canal. Devuelve un unsubscribe. */
  subscribe(handler: (msg: ScadaSimBusMessage) => void): () => void;
  /** Último frame espejado en localStorage (seed inmediato al abrir el monitor). */
  readLastFrame(): SnapshotFrame | null;
  close(): void;
}

function now(): number {
  // Date.now existe en el navegador; en SSR/headless devolvemos 0 (sin uso real).
  return typeof Date !== 'undefined' && typeof Date.now === 'function' ? Date.now() : 0;
}

function hasBroadcast(): boolean {
  return typeof window !== 'undefined' && typeof (window as { BroadcastChannel?: unknown }).BroadcastChannel === 'function';
}

function lsGet(key: string): string | null {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
}
function lsSet(key: string, val: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, val); } catch { /* quota / SSR */ }
}

/**
 * Crea un bus SCADA SIM. Si BroadcastChannel no está disponible cae a un
 * transporte por `storage` events de localStorage (también cross-tab).
 */
export function createScadaSimBus(): ScadaSimBus {
  const useBC = hasBroadcast();
  const channel: BroadcastChannel | null = useBC ? new BroadcastChannel(SCADA_SIM_CHANNEL) : null;
  const handlers = new Set<(msg: ScadaSimBusMessage) => void>();

  // Fallback cross-tab cuando no hay BroadcastChannel: el publisher escribe el
  // frame en localStorage (ya lo hace de todos modos) y el listener reacciona al
  // evento `storage` que dispara en las OTRAS pestañas.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== SCADA_SIM_LAST_FRAME_KEY || !e.newValue) return;
    try {
      const f = JSON.parse(e.newValue) as SnapshotFrame;
      const msg: ScadaSimBusMessage = { kind: 'snapshot', t: f.t, snapshot: f.snapshot };
      handlers.forEach((h) => h(msg));
    } catch { /* json roto */ }
  };

  if (channel) {
    channel.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as ScadaSimBusMessage;
      if (msg && KNOWN_KINDS.has((msg as { kind?: string }).kind ?? '')) handlers.forEach((h) => h(msg));
    };
  } else if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }

  return {
    publishSnapshot(snapshot: CellSnapshot) {
      const t = now();
      // Espejo en localStorage SIEMPRE (seed para monitores nuevos + fallback).
      lsSet(SCADA_SIM_LAST_FRAME_KEY, JSON.stringify({ t, snapshot } as SnapshotFrame));
      if (channel) channel.postMessage({ kind: 'snapshot', t, snapshot } as ScadaSimBusMessage);
    },
    publishOperatorEvent(event: OperatorEventType) {
      const t = now();
      if (channel) channel.postMessage({ kind: 'operatorEvent', t, event } as ScadaSimBusMessage);
      // (Sin BroadcastChannel, el monitor deriva los eventos de las transiciones.)
    },
    sendCommand(command: ScadaSimCommand) {
      const t = now();
      const requestId = `cmd-${t}-${++commandSeq}`;
      if (channel) channel.postMessage({ kind: 'commandRequest', t, requestId, command } as ScadaSimBusMessage);
      return requestId;
      // (Sin BroadcastChannel no hay canal de comandos; Fase 2B evaluará alternativa.)
    },
    publishCommandAck(command: ScadaSimCommand, ok: boolean, requestId: string, error?: string) {
      const t = now();
      if (channel) channel.postMessage({ kind: 'commandAck', t, requestId, command, ok, error } as ScadaSimBusMessage);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    readLastFrame() {
      const raw = lsGet(SCADA_SIM_LAST_FRAME_KEY);
      if (!raw) return null;
      try { return JSON.parse(raw) as SnapshotFrame; } catch { return null; }
    },
    close() {
      handlers.clear();
      if (channel) channel.close();
      else if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    },
  };
}

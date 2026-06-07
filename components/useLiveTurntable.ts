// ─────────────────────────────────────────────────────────────────────────────
// useLiveTurntable.ts — Cliente EN VIVO de la mesa rotatoria (Raspberry Pi).
//
// Se conecta al gateway FastAPI de la Raspberry con el MISMO patrón probado del
// cobot (WebSocket primario + fallback a REST polling + degradado silencioso a
// DEMO si el gateway no responde):
//
//   WS   /ws/turntable             ← stream del contrato (push)
//   GET  /api/turntable/state      ← snapshot REST (fallback)
//   POST /api/turntable/start-cycle ← disparar un ciclo en la Raspberry
//
// El contrato JSON es EXACTAMENTE el de turntableSim.ts (HOME/WORK/RIVETING…),
// así la mesa real mueve el disco 3D en tiempo real en "Cobot en Vivo".
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TurntableTelemetry } from './turntableSim';

export type LiveMode = 'demo' | 'connecting' | 'live' | 'error';

// Snapshot DEMO (mesa en HOME, esperando gateway). _demo:true como el cobot.
export const DEMO_TURNTABLE: TurntableTelemetry = {
  timestamp: '2026-05-28T00:00:00.000Z',
  ok: true,
  _demo: true,
  turntable: {
    angle_deg: 0,
    position: 'HOME',
    moving: false,
    target: 'WORK',
    last_direction: 'NONE',
    limit_home: true,
    limit_work: false,
    riveting: false,
    riveting_done: false,
    fault: false,
    message: 'Esperando gateway de la Raspberry',
  },
};

/** Deriva la base HTTP del gateway desde la URL del WebSocket. */
function restBase(wsUrl: string): string {
  let u = wsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
  u = u.replace(/\/ws\/turntable\/?$/, '');
  return u;
}

export interface UseLiveTurntable {
  mode: LiveMode;
  telemetry: TurntableTelemetry;
  url: string;
  setUrl: (u: string) => void;
  connErr: string | null;
  connect: (u?: string, auto?: boolean) => void;
  disconnect: () => void;
  startCycle: () => void;
}

export function useLiveTurntable(
  defaultUrl = 'wss://unmoral-shrink-cavalry.ngrok-free.dev/ws/turntable',
): UseLiveTurntable {
  const [mode, setMode] = useState<LiveMode>('demo');
  const [url, setUrl] = useState(defaultUrl);
  const [telemetry, setTelemetry] = useState<TurntableTelemetry>(DEMO_TURNTABLE);
  const [connErr, setConnErr] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<number | null>(null);
  const manualCloseRef = useRef(false);
  const autoStartedRef = useRef(false);

  const handleFail = useCallback((msg: string, auto: boolean) => {
    if (auto) { setMode('demo'); setTelemetry(DEMO_TURNTABLE); setConnErr(null); }
    else { setMode('error'); setConnErr(msg); }
  }, []);

  const disconnect = useCallback(() => {
    manualCloseRef.current = true;
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
    setMode('demo');
    setConnErr(null);
    setTelemetry(DEMO_TURNTABLE);
  }, []);

  const connect = useCallback((targetUrl?: string, auto = false) => {
    const u = targetUrl ?? url;
    manualCloseRef.current = false;
    setConnErr(null);
    setMode('connecting');
    const isWs = u.startsWith('ws://') || u.startsWith('wss://');
    if (isWs) {
      try {
        const ws = new WebSocket(u);
        wsRef.current = ws;
        const failTimer = window.setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) ws.close();
        }, 6000);
        ws.onopen = () => { window.clearTimeout(failTimer); setMode('live'); };
        ws.onmessage = (e) => {
          try { setTelemetry(JSON.parse(e.data)); } catch { /* frame inválido */ }
        };
        ws.onclose = () => {
          window.clearTimeout(failTimer);
          if (manualCloseRef.current) return;
          handleFail('WebSocket cerrado — ¿gateway de la mesa activo?', auto);
        };
      } catch (err) {
        handleFail(String(err), auto);
      }
    } else {
      const poll = () => {
        fetch(u, { cache: 'no-store', headers: { 'ngrok-skip-browser-warning': 'true' } })
          .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
          .then((j) => { setTelemetry(j); setMode('live'); setConnErr(null); })
          .catch((e) => {
            if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
            handleFail(String(e), auto);
          });
      };
      poll();
      pollRef.current = window.setInterval(poll, 300);
    }
  }, [url, handleFail]);

  /** POST /api/turntable/start-cycle — pide a la Raspberry que arranque el ciclo. */
  const startCycle = useCallback(() => {
    const endpoint = `${restBase(url)}/api/turntable/start-cycle`;
    fetch(endpoint, {
      method: 'POST',
      headers: { 'ngrok-skip-browser-warning': 'true', 'Content-Type': 'application/json' },
    }).catch(() => { /* en demo no hay gateway; se ignora */ });
  }, [url]);

  // Auto-conexión una vez al montar (silenciosa: cae a DEMO si no hay gateway).
  useEffect(() => {
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    connect(defaultUrl, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup al desmontar.
  useEffect(() => () => {
    manualCloseRef.current = true;
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    if (pollRef.current) window.clearInterval(pollRef.current);
  }, []);

  return { mode, telemetry, url, setUrl, connErr, connect, disconnect, startCycle };
}

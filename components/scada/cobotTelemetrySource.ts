// ─────────────────────────────────────────────────────────────────────────────
// cobotTelemetrySource.ts — Fuente de telemetría REAL del cobot para SCADA.
//
// SCADA abre su PROPIO WebSocket READ-ONLY al MISMO gateway del cobot que usa
// "Cobot en Vivo" (mismo stream de telemetría). NO toca CobotLiveView ni el
// gateway: sólo se suscribe al telemetría (no manda comandos). Así los datos del
// cobot en el dashboard SCADA "salen de" la misma fuente que Cobot en Vivo,
// independientemente de qué pestaña esté montada.
//
// URL: EXPO_PUBLIC_COBOT_WS_URL  (default = el mismo ngrok wss que Cobot en Vivo).
// Sin conexión → telemetry=null y SCADA usa sus valores SIM.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { SCADA_HEALTH_ENDPOINT } from './scadaConfig';
import type { AiBackendHealth } from './scadaTypes';

// Misma forma que CobotTelemetry de CobotLiveView (subconjunto que usa SCADA).
export interface CobotTelemetryLite {
  controller: { temperature_c: number; avg_power_w: number; avg_current_a: number };
  status: {
    speed_magnification_pct: number; emergency_stop: boolean; protective_stop: boolean;
    robot_enabled: boolean; power_on?: boolean; on_soft_limit?: boolean; inpos?: boolean;
    motion_errcode?: number; motion_mode_name?: string;
  };
  joint_positions_deg: number[];
  joint_temperatures_c?: number[];
  joint_speeds_deg_s?: number[];
  joint_states: { current_a: number; error?: boolean; collision?: boolean }[];
  tcp_position: { x_mm: number; y_mm: number; z_mm: number; rx_deg: number; ry_deg: number; rz_deg: number };
  end_effector: { fx_n: number; fy_n: number; fz_n: number; torque_rx_nm: number; torque_ry_nm: number; torque_rz_nm: number };
  // OPCIONAL: I/O digital de la celda. HOY el gateway NO lo manda (verificado).
  // Si el gateway lo agrega (ver server/RPI_GATEWAY_IO_SNIPPET.md), SCADA lo lee.
  io?: ScadaIoFrame;
}

// Forma del bloque `io` que expone el gateway (DI del cobot + GPIO de la RPi).
// Todo opcional/nullable: si un dato no existe físicamente, viene null o ausente
// (NO se inventa). SCADA usa lo que llega y deja el resto en SIM/CONFIGURED.
export interface ScadaIoFrame {
  // ── Inputs (sensores / DI del PLC) — lista canónica del HMI ──
  conveyor_photoeye?: boolean | null;     // I_CONVEYOR_PHOTOEYE
  fixture_1_present?: boolean | null;      // I_FIXTURE_1_PRESENT
  fixture_2_present?: boolean | null;      // I_FIXTURE_2_PRESENT
  table_home_limit?: boolean | null;       // I_TABLE_HOME_LIMIT
  table_work_limit?: boolean | null;       // I_TABLE_WORK_LIMIT
  camera_pass?: boolean | null;            // I_CAMERA_PASS
  camera_fail?: boolean | null;            // I_CAMERA_FAIL
  camera_ready?: boolean | null;           // I_CAMERA_READY
  camera_error?: boolean | null;           // I_CAMERA_ERROR
  camera_no_read?: boolean | null;         // I_CAMERA_NO_READ
  gripper_open?: boolean | null;           // I_GRIPPER_OPEN
  gripper_closed?: boolean | null;         // I_GRIPPER_CLOSED
  // ── Outputs (coils / DO del PLC) — lista canónica del HMI ──
  conveyor_motor_on?: boolean | null;      // O_CONVEYOR_MOTOR
  camera_trigger?: boolean | null;         // O_CAMERA_TRIGGER
  table_nema_moving?: boolean | null;      // O_TABLE_NEMA_MOVING
  rivet_active?: boolean | null;           // O_RIVET_ACTIVE
  stacklight_green?: boolean | null;       // O_STACKLIGHT_GREEN
  stacklight_yellow?: boolean | null;      // O_STACKLIGHT_YELLOW
  stacklight_red?: boolean | null;         // O_STACKLIGHT_RED
  // ── Legacy (compat; no se muestran en la matriz canónica) ──
  camera_photoeye?: boolean | null;
  air_pressure_bar?: number | null;
  estop?: boolean | null;
  stop_button?: boolean | null;
}

// Normaliza un frame io crudo (cualquier shape) → ScadaIoFrame seguro. No crashea
// si faltan campos; coacciona a boolean salvo air_pressure_bar (número o null).
export function normalizeIo(raw: unknown): ScadaIoFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const b = (k: string): boolean | null => (o[k] === undefined || o[k] === null ? null : !!o[k]);
  const n = (k: string): number | null => (typeof o[k] === 'number' ? (o[k] as number) : null);
  return {
    // inputs
    conveyor_photoeye: b('conveyor_photoeye'),
    fixture_1_present: b('fixture_1_present'), fixture_2_present: b('fixture_2_present'),
    table_home_limit: b('table_home_limit'), table_work_limit: b('table_work_limit'),
    camera_pass: b('camera_pass'), camera_fail: b('camera_fail'),
    camera_ready: b('camera_ready'), camera_error: b('camera_error'), camera_no_read: b('camera_no_read'),
    gripper_open: b('gripper_open'), gripper_closed: b('gripper_closed'),
    // outputs
    conveyor_motor_on: b('conveyor_motor_on'),
    camera_trigger: b('camera_trigger'), table_nema_moving: b('table_nema_moving'),
    rivet_active: b('rivet_active'),
    stacklight_green: b('stacklight_green'), stacklight_yellow: b('stacklight_yellow'), stacklight_red: b('stacklight_red'),
    // legacy
    camera_photoeye: b('camera_photoeye'), air_pressure_bar: n('air_pressure_bar'),
    estop: b('estop'), stop_button: b('stop_button'),
  };
}

const DEFAULT_WS =
  (typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_COBOT_WS_URL)
    ? String(process.env.EXPO_PUBLIC_COBOT_WS_URL)
    : 'wss://unmoral-shrink-cavalry.ngrok-free.dev/ws/cobot';

function isCobotTelemetry(x: unknown): x is CobotTelemetryLite {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return Array.isArray(o.joint_positions_deg) && !!o.controller && !!o.tcp_position;
}

export interface CobotTelemetryState {
  telemetry: CobotTelemetryLite | null;
  io: ScadaIoFrame | null;   // bloque PLC normalizado (null si el gateway no lo manda)
  connected: boolean;
  url: string;
}

// Hook: conexión read-only con auto-reconnect. Devuelve la última telemetría.
export function useCobotTelemetry(url: string = DEFAULT_WS): CobotTelemetryState {
  const [telemetry, setTelemetry] = useState<CobotTelemetryLite | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (!aliveRef.current) return;
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { schedule(); return; }
      wsRef.current = ws;
      ws.onopen = () => { if (aliveRef.current) setConnected(true); };
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(typeof e.data === 'string' ? e.data : '');
          if (isCobotTelemetry(data)) setTelemetry(data);
        } catch { /* frame malformado */ }
      };
      ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
      ws.onclose = () => { if (aliveRef.current) { setConnected(false); schedule(); } };
    };
    const schedule = () => { if (aliveRef.current && !retry) retry = setTimeout(() => { retry = null; open(); }, 4000); };

    open();
    return () => {
      aliveRef.current = false;
      if (retry) clearTimeout(retry);
      try { wsRef.current?.close(); } catch { /* noop */ }
    };
  }, [url]);

  const io = telemetry && telemetry.io ? normalizeIo(telemetry.io) : null;
  return { telemetry, io, connected, url };
}

// Estado del backend de IA (OpenAI) SIN exponer la key: sólo consulta el
// healthcheck que reporta { ok, model, keyConfigured }. Si el backend no existe o
// no responde → NOT_CONNECTED. Si responde pero sin key → NOT_CONFIGURED.
export function useAiBackendHealth(pollMs = 30000): AiBackendHealth {
  const [health, setHealth] = useState<AiBackendHealth>({ state: 'UNKNOWN', model: null });
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch(SCADA_HEALTH_ENDPOINT, {
          signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout(5000) : undefined,
        });
        if (!res.ok) throw new Error(String(res.status));
        const d = (await res.json()) as { model?: string; keyConfigured?: boolean };
        if (alive) setHealth({ state: d.keyConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED', model: d.model ?? null });
      } catch {
        if (alive) setHealth({ state: 'NOT_CONNECTED', model: null });
      }
    };
    check();
    const id = setInterval(check, pollMs);
    return () => { alive = false; clearInterval(id); };
  }, [pollMs]);
  return health;
}

// Live cobot monitor — the "digital twin" view that mirrors the physical
// Lexium Cobot read by the Raspberry Pi gateway over Modbus TCP.
//
// Data contract (from Quique2/RaspberryPiGIT · CONTEXT_DIGITAL_TWIN.md):
//   - RPi reads the controller at 10.5.5.100:6502 (Modbus FC04, read-only)
//   - cobot_reader.py emits the JSON mirrored by CobotTelemetry below
//   - planned backend: FastAPI on the RPi → WS /ws/cobot @100ms + REST /state
//
// Until that backend exists this view shows the real snapshot captured on the
// RPi (DEMO), and the connection bar is ready to stream live data the moment
// an endpoint is reachable.  Note: a Railway HTTPS deploy can't reach a plain
// http/ws LAN address (mixed-content) — live connect works locally or once the
// gateway is served over https.

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, Html } from '@react-three/drei';
import * as THREE from 'three';
import URDFLoader from 'urdf-loader';
import type { URDFRobot } from 'urdf-loader';

const SANS_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';

// HOME joints (radians) — matches POSE_HOME in CellViewer3D (V60 symmetric pose).
const HOME_JOINTS: [number, number, number, number, number, number] =
  [0, 0, 0, Math.PI / 2, -Math.PI / 2, 0];

// ── Telemetry shape (mirror of cobot_reader.py JSON) ────────────────────────
interface JointState {
  joint: number; error: boolean; enabled: boolean; collision: boolean; current_a: number;
}
interface CobotTelemetry {
  timestamp: string;
  ok: boolean;
  _demo?: boolean; // backend sets this true when it can't reach the real Modbus
  status: {
    protective_stop: boolean; emergency_stop: boolean; power_on: boolean;
    robot_enabled: boolean; on_soft_limit: boolean; inpos: boolean;
    motion_mode: number; motion_mode_name: string; reduction_level: number;
    speed_magnification_pct: number; motion_errcode: number;
  };
  controller: { temperature_c: number; avg_power_w: number; avg_current_a: number };
  joint_states: JointState[];
  joint_positions_deg: number[];
  joint_speeds_deg_s: number[];
  tcp_position: { x_mm: number; y_mm: number; z_mm: number; rx_deg: number; ry_deg: number; rz_deg: number };
  end_effector: { fx_n: number; fy_n: number; fz_n: number; torque_rx_nm: number; torque_ry_nm: number; torque_rz_nm: number };
  joint_temperatures_c: number[];
}

// Real snapshot captured on the RPi (CONTEXT_DIGITAL_TWIN.md).  Shown when
// no live endpoint is connected so the panel always reflects real fields.
const DEMO_TELEMETRY: CobotTelemetry = {
  timestamp: '2026-05-27T20:54:40Z',
  ok: true,
  status: {
    protective_stop: false, emergency_stop: false, power_on: true,
    robot_enabled: false, on_soft_limit: false, inpos: true,
    motion_mode: 0, motion_mode_name: 'Jog/Other', reduction_level: 0,
    speed_magnification_pct: 1.0, motion_errcode: 3182721,
  },
  controller: { temperature_c: 29.0, avg_power_w: 0.0, avg_current_a: 0.0 },
  joint_states: [
    { joint: 1, error: false, enabled: false, collision: false, current_a: 0.0 },
    { joint: 2, error: false, enabled: false, collision: false, current_a: 0.0 },
    { joint: 3, error: false, enabled: false, collision: false, current_a: 0.0 },
    { joint: 4, error: false, enabled: false, collision: false, current_a: 0.0 },
    { joint: 5, error: false, enabled: false, collision: false, current_a: 0.0 },
    { joint: 6, error: false, enabled: false, collision: false, current_a: 0.0 },
  ],
  joint_positions_deg: [60.439, 81.909, 7.191, 87.090, 7.354, -77.118],
  joint_speeds_deg_s: [0, 0, 0, 0, 0, 0],
  tcp_position: { x_mm: 20.96, y_mm: 56.38, z_mm: 738.96, rx_deg: -93.077, ry_deg: -80.883, rz_deg: -109.185 },
  end_effector: { fx_n: 0, fy_n: 0, fz_n: 0, torque_rx_nm: 0, torque_ry_nm: 0, torque_rz_nm: 0 },
  joint_temperatures_c: [33, 34, 32, 35, 36, 38],
};

type ConnMode = 'demo' | 'connecting' | 'live' | 'error';

// ── Minimal self-contained URDF loader (cobot only) ─────────────────────────
function useCobotUrdf(): URDFRobot | null {
  const [robot, setRobot] = useState<URDFRobot | null>(null);
  useEffect(() => {
    const loader = new URDFLoader();
    loader.workingPath = '';
    loader.parseCollision = false;
    fetch('/urdf/lexium_cobot.urdf')
      .then((res) => { if (!res.ok) throw new Error(`URDF ${res.status}`); return res.text(); })
      .then((text) => {
        const r = loader.parse(text);
        r.traverse((c) => { c.castShadow = true; c.receiveShadow = true; });
        setRobot(r);
      })
      .catch((e) => { console.error('Cobot URDF load failed:', e); });
  }, []);
  return robot;
}

// Cobot rendered at world origin (Z-up).  Joints are eased toward targetRef so
// live telemetry updates look smooth instead of snapping.
function LiveCobot({
  targetRef, tcpWorldRef,
}: {
  targetRef: React.MutableRefObject<[number, number, number, number, number, number]>;
  tcpWorldRef: React.MutableRefObject<[number, number, number]>;
}) {
  const robot = useCobotUrdf();
  const groupRef = useRef<THREE.Group>(null);
  const liveRef = useRef<[number, number, number, number, number, number]>([...HOME_JOINTS]);

  useFrame((_, dt) => {
    if (!robot) return;
    const k = Math.min(1, dt * 6); // ease factor
    for (let i = 0; i < 6; i++) {
      liveRef.current[i] += (targetRef.current[i] - liveRef.current[i]) * k;
      robot.setJointValue(`joint_${i + 1}`, liveRef.current[i]);
    }
    if (groupRef.current) groupRef.current.updateMatrixWorld(true);
    const tcp = robot.frames['tcp_link'];
    if (tcp) {
      const v = new THREE.Vector3();
      tcp.getWorldPosition(v);
      tcpWorldRef.current = [v.x, v.y, v.z];
    }
  });

  if (!robot) return null;
  return (
    <group ref={groupRef}>
      <primitive object={robot} />
    </group>
  );
}

function ZUp() {
  const { camera, scene } = useThree();
  useEffect(() => {
    camera.up.set(0, 0, 1);
    scene.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0.45);
    camera.updateProjectionMatrix();
  }, [camera, scene]);
  return null;
}

// ── Telemetry panel helpers ─────────────────────────────────────────────────
const statRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between',
  fontSize: 11, fontFamily: 'monospace', color: '#abc', padding: '3px 0',
};
function Flag({ label, on, goodWhenOn = true }: { label: string; on: boolean; goodWhenOn?: boolean }) {
  const good = goodWhenOn ? on : !on;
  return (
    <div style={{ ...statRow }}>
      <span>{label}</span>
      <span style={{ color: good ? '#22dd55' : '#ff5566', fontWeight: 700 }}>
        {on ? 'YES' : 'NO'}
      </span>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      border: '1px solid #1d2c44', borderRadius: 8, padding: 12,
      background: 'rgba(20,30,48,0.45)',
    }}>
      <div style={{
        fontSize: 9, letterSpacing: 2, color: '#5a6c84',
        textTransform: 'uppercase', fontWeight: 700, marginBottom: 8,
      }}>{title}</div>
      {children}
    </div>
  );
}

export default function CobotLiveView() {
  const [mode, setMode] = useState<ConnMode>('demo');
  // Permanent ngrok static domain fronting the RPi gateway (https/wss so it
  // works from the HTTPS Railway deploy — no mixed-content block).  Swap to
  // ws://192.168.1.167:8000/ws/cobot for a same-LAN local run.
  const [url, setUrl] = useState('wss://unmoral-shrink-cavalry.ngrok-free.dev/ws/cobot');
  const [telemetry, setTelemetry] = useState<CobotTelemetry>(DEMO_TELEMETRY);
  const [applyToModel, setApplyToModel] = useState(false);
  const [connErr, setConnErr] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<number | null>(null);
  const manualCloseRef = useRef(false);   // distinguishes user disconnect from a drop
  const autoStartedRef = useRef(false);    // auto-connect only once per mount
  // 3D cobot reads these; default HOME, driven by telemetry only when applyToModel.
  const targetJointsRef = useRef<[number, number, number, number, number, number]>([...HOME_JOINTS]);
  const tcpWorldRef = useRef<[number, number, number]>([0, 0, 0]);

  // Drive the model from telemetry (deg → rad direct map).  Joint zero-offsets
  // between the LXM controller and our URDF may differ; refine per-joint here
  // if the live pose looks rotated.
  useEffect(() => {
    if (applyToModel && telemetry.joint_positions_deg?.length === 6) {
      targetJointsRef.current = telemetry.joint_positions_deg.map((d) => THREE.MathUtils.degToRad(d)) as
        [number, number, number, number, number, number];
    } else {
      targetJointsRef.current = [...HOME_JOINTS];
    }
  }, [applyToModel, telemetry]);

  const disconnect = () => {
    manualCloseRef.current = true;
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
    setMode('demo');
    setConnErr(null);
    setTelemetry(DEMO_TELEMETRY);
  };

  // Failure handling.  On an *auto* connect (tab just opened) we degrade to
  // DEMO silently — no scary red banner if the gateway simply isn't up.  On a
  // manual CONECTAR we surface the error so the user knows their click failed.
  const handleFail = (msg: string, auto: boolean) => {
    if (auto) { setMode('demo'); setTelemetry(DEMO_TELEMETRY); setConnErr(null); }
    else { setMode('error'); setConnErr(msg); }
  };

  const connect = (targetUrl: string, auto = false) => {
    manualCloseRef.current = false;
    setConnErr(null);
    setMode('connecting');
    const isWs = targetUrl.startsWith('ws://') || targetUrl.startsWith('wss://');
    if (isWs) {
      try {
        const ws = new WebSocket(targetUrl);
        wsRef.current = ws;
        const failTimer = window.setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) ws.close(); // → onclose → handleFail
        }, 6000);
        ws.onopen = () => { window.clearTimeout(failTimer); setMode('live'); };
        ws.onmessage = (e) => {
          try { setTelemetry(JSON.parse(e.data)); } catch { /* ignore malformed frame */ }
        };
        // onerror always precedes onclose; let onclose be the single fail path.
        ws.onclose = () => {
          window.clearTimeout(failTimer);
          if (manualCloseRef.current) return;
          handleFail('WebSocket cerrado — ¿gateway activo?', auto);
        };
      } catch (err) {
        handleFail(String(err), auto);
      }
    } else {
      // REST polling (GET /api/cobot/state).  ngrok-skip-browser-warning keeps
      // the free-tier interstitial from replacing the JSON with an HTML page.
      const poll = () => {
        fetch(targetUrl, { cache: 'no-store', headers: { 'ngrok-skip-browser-warning': 'true' } })
          .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
          .then((j) => { setTelemetry(j); setMode('live'); setConnErr(null); })
          .catch((e) => {
            if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
            handleFail(String(e), auto);
          });
      };
      poll();
      pollRef.current = window.setInterval(poll, 500);
    }
  };

  // Auto-connect once when the tab mounts, using the default ngrok URL, so the
  // operator sees live data without typing anything when the gateway is up.
  useEffect(() => {
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    connect(url, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { // cleanup on unmount
    manualCloseRef.current = true;
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    if (pollRef.current) window.clearInterval(pollRef.current);
  }, []);

  const s = telemetry.status;
  // When connected but the gateway reports _demo, it reached the backend but
  // not the real Modbus — surface that instead of claiming live data.
  const backendDemo = mode === 'live' && telemetry._demo === true;
  const dotColor = backendDemo ? '#fbbf24'
    : mode === 'live' ? '#22dd55'
    : mode === 'connecting' ? '#fbbf24'
    : mode === 'error' ? '#ff5566' : '#5a6c84';
  const modeLabel = backendDemo ? 'GATEWAY OK · Modbus en demo'
    : mode === 'live' ? 'EN VIVO'
    : mode === 'connecting' ? 'CONECTANDO…'
    : mode === 'error' ? 'ERROR' : 'DEMO (snapshot RPi)';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#07111e', fontFamily: SANS_FONT }}>
      {/* Connection bar */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 16px', borderBottom: '1px solid #1a2c44',
        background: 'linear-gradient(180deg,#0c1a2c 0%,#091320 100%)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 200 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: dotColor, boxShadow: `0 0 8px ${dotColor}` }} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 9, letterSpacing: 2, color: '#22c55e', textTransform: 'uppercase', fontWeight: 600 }}>
              Raspberry Pi · Modbus TCP
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9' }}>{modeLabel}</span>
          </div>
        </div>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="ws://192.168.1.167:8000/ws/cobot  ó  http://…/api/cobot/state"
          spellCheck={false}
          style={{
            flex: 1, fontFamily: 'monospace', fontSize: 12, color: '#dde4f0',
            background: '#0a1422', border: '1px solid #1d2c44', borderRadius: 6,
            padding: '8px 10px', outline: 'none',
          }} />
        {mode === 'live' || mode === 'connecting' ? (
          <button onClick={disconnect} style={{
            fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: '#fff', cursor: 'pointer',
            border: 'none', borderRadius: 6, padding: '9px 18px',
            background: 'linear-gradient(180deg,#f47835 0%,#d96416 100%)',
          }}>DESCONECTAR</button>
        ) : (
          <button onClick={() => connect(url, false)} style={{
            fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: '#fff', cursor: 'pointer',
            border: 'none', borderRadius: 6, padding: '9px 18px',
            background: 'linear-gradient(180deg,#22cc55 0%,#15803d 100%)',
          }}>CONECTAR</button>
        )}
      </div>

      {connErr && (
        <div style={{
          flexShrink: 0, padding: '6px 16px', background: 'rgba(80,20,20,0.4)',
          borderBottom: '1px solid #ff556644', color: '#ff8a98', fontSize: 11, fontFamily: 'monospace',
        }}>
          ⚠ {connErr} — mostrando snapshot DEMO.
        </div>
      )}

      {/* Body: 3D + telemetry */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* 3D cobot */}
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <Canvas
            shadows
            camera={{ position: [1.5, -1.45, 1.05], fov: 42, near: 0.05, far: 50, up: [0, 0, 1] }}
            style={{ background: '#07111e' }}
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
          >
            <ZUp />
            <ambientLight intensity={0.6} />
            <directionalLight position={[3, 3, 5]} intensity={1.2} castShadow
              shadow-mapSize-width={2048} shadow-mapSize-height={2048} />
            <directionalLight position={[-2, -2, 3]} intensity={0.3} color="#a0c0ff" />
            <OrbitControls target={[0, 0, 0.45]} enableDamping dampingFactor={0.08}
              minDistance={0.8} maxDistance={6} maxPolarAngle={Math.PI / 2.02} />
            <Grid args={[4, 4]} position={[0, 0, 0.001]} rotation={[-Math.PI / 2, 0, 0]}
              cellSize={0.2} cellThickness={0.4} cellColor="#0f1e30"
              sectionSize={1} sectionThickness={0.8} sectionColor="#162840"
              fadeDistance={6} infiniteGrid={false} />
            <Suspense fallback={null}>
              <LiveCobot targetRef={targetJointsRef} tcpWorldRef={tcpWorldRef} />
            </Suspense>
            <Html position={[0, 0, 1.15]} center>
              <div style={{
                fontSize: 9, color: '#60a5fa', background: 'rgba(6,16,28,0.82)',
                border: '1px solid #60a5fa44', padding: '2px 7px', borderRadius: 4,
                whiteSpace: 'nowrap', fontFamily: 'monospace', pointerEvents: 'none',
              }}>Lexium Cobot {applyToModel ? '· live joints' : '· HOME'}</div>
            </Html>
          </Canvas>

          {/* model-source toggle */}
          <button onClick={() => setApplyToModel((v) => !v)} style={{
            position: 'absolute', left: 12, bottom: 12, fontFamily: SANS_FONT,
            fontSize: 11, fontWeight: 600, color: '#fff', cursor: 'pointer',
            border: '1px solid #1d2c44', borderRadius: 6, padding: '7px 12px',
            background: applyToModel ? 'linear-gradient(180deg,#3b8bff 0%,#2563eb 100%)' : 'rgba(20,30,48,0.85)',
          }}>
            {applyToModel ? '◉ 3D sigue joints en vivo' : '◯ 3D fijo en HOME'}
          </button>
        </div>

        {/* Telemetry side panel */}
        <div style={{
          width: 320, flexShrink: 0, overflowY: 'auto', padding: 14,
          display: 'flex', flexDirection: 'column', gap: 12,
          borderLeft: '1px solid #1d2c44',
          background: 'linear-gradient(180deg,#0c1828 0%,#0a1422 100%)',
        }}>
          <Section title="Estado del robot">
            <Flag label="Power ON" on={s.power_on} />
            <Flag label="Robot enabled" on={s.robot_enabled} />
            <Flag label="In position" on={s.inpos} />
            <Flag label="Protective stop" on={s.protective_stop} goodWhenOn={false} />
            <Flag label="Emergency stop" on={s.emergency_stop} goodWhenOn={false} />
            <Flag label="Soft limit" on={s.on_soft_limit} goodWhenOn={false} />
            <div style={statRow}><span>Motion mode</span><span style={{ color: '#9bf' }}>{s.motion_mode_name}</span></div>
            <div style={statRow}><span>Error code</span><span style={{ color: '#fbbf24' }}>{s.motion_errcode}</span></div>
          </Section>

          <Section title="Controlador">
            <div style={statRow}><span>Temperatura</span><span style={{ color: '#fb923c' }}>{telemetry.controller.temperature_c.toFixed(1)} °C</span></div>
            <div style={statRow}><span>Potencia media</span><span>{telemetry.controller.avg_power_w.toFixed(1)} W</span></div>
            <div style={statRow}><span>Corriente media</span><span>{telemetry.controller.avg_current_a.toFixed(2)} A</span></div>
            <div style={statRow}><span>Speed magnif.</span><span>{(s.speed_magnification_pct * 100).toFixed(0)} %</span></div>
          </Section>

          <Section title="Articulaciones (J1–J6)">
            <div style={{ display: 'grid', gridTemplateColumns: '0.8fr 1fr 0.8fr 0.8fr', gap: 2, fontSize: 10, fontFamily: 'monospace' }}>
              <span style={{ color: '#5a6c84' }}>eje</span>
              <span style={{ color: '#5a6c84', textAlign: 'right' }}>ángulo</span>
              <span style={{ color: '#5a6c84', textAlign: 'right' }}>temp</span>
              <span style={{ color: '#5a6c84', textAlign: 'right' }}>amp</span>
              {telemetry.joint_positions_deg.map((deg, i) => {
                const js = telemetry.joint_states[i];
                const bad = js && (js.error || js.collision);
                return (
                  <React.Fragment key={i}>
                    <span style={{ color: bad ? '#ff5566' : js?.enabled ? '#22dd55' : '#abc' }}>J{i + 1}</span>
                    <span style={{ textAlign: 'right', color: '#dde4f0' }}>{deg.toFixed(2)}°</span>
                    <span style={{ textAlign: 'right', color: '#fb923c' }}>{telemetry.joint_temperatures_c[i]}°</span>
                    <span style={{ textAlign: 'right', color: '#abc' }}>{(js?.current_a ?? 0).toFixed(1)}</span>
                  </React.Fragment>
                );
              })}
            </div>
          </Section>

          <Section title="TCP — Tool Center Point">
            <div style={statRow}><span>X</span><span style={{ color: '#dde4f0' }}>{telemetry.tcp_position.x_mm.toFixed(2)} mm</span></div>
            <div style={statRow}><span>Y</span><span style={{ color: '#dde4f0' }}>{telemetry.tcp_position.y_mm.toFixed(2)} mm</span></div>
            <div style={statRow}><span>Z</span><span style={{ color: '#dde4f0' }}>{telemetry.tcp_position.z_mm.toFixed(2)} mm</span></div>
            <div style={statRow}><span>RX</span><span style={{ color: '#9bf' }}>{telemetry.tcp_position.rx_deg.toFixed(2)}°</span></div>
            <div style={statRow}><span>RY</span><span style={{ color: '#9bf' }}>{telemetry.tcp_position.ry_deg.toFixed(2)}°</span></div>
            <div style={statRow}><span>RZ</span><span style={{ color: '#9bf' }}>{telemetry.tcp_position.rz_deg.toFixed(2)}°</span></div>
          </Section>

          <Section title="Fuerza / Par (end-effector)">
            <div style={statRow}><span>Fx / Fy / Fz</span><span>{telemetry.end_effector.fx_n.toFixed(1)} / {telemetry.end_effector.fy_n.toFixed(1)} / {telemetry.end_effector.fz_n.toFixed(1)} N</span></div>
            <div style={statRow}><span>Tx / Ty / Tz</span><span>{telemetry.end_effector.torque_rx_nm.toFixed(1)} / {telemetry.end_effector.torque_ry_nm.toFixed(1)} / {telemetry.end_effector.torque_rz_nm.toFixed(1)} Nm</span></div>
          </Section>

          <div style={{ fontSize: 9, color: '#5a6c84', fontFamily: 'monospace', textAlign: 'center' }}>
            {telemetry.timestamp} · 10.5.5.100:6502 · FC04
          </div>
        </div>
      </div>
    </div>
  );
}

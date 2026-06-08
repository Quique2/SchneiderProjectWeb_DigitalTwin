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
import { COBOT_BASE, TURNTABLE_BASE, MESA_CENTRE, BASE_CONVEYOR, BASE_TURNTABLE, BASE_VISION, BASE_BINS, Turntable, CellPrimitives, useLayoutOffsets, TeachPendant, ManualJogger, TeachPose, TcpInBase, collisionAABBs, JOG_REAL_DEFAULT_FRAC } from './CellViewer3D';
import HmiSvgPanel from './HmiSvgPanel';
import type { HmiBlock, PipelineBlock } from './HmiSvgPanel';

const SANS_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';

// HOME joints (radians) — matches POSE_HOME in CellViewer3D (V60 symmetric pose).
const HOME_JOINTS: [number, number, number, number, number, number] =
  [0, 0, 0, Math.PI / 2, -Math.PI / 2, 0];

// Mapping from the LXM controller convention to our URDF, per joint:
//   urdf_deg = JOINT_SIGN * controller_deg + JOINT_OFFSET_DEG
// J1: same direction (sign +1) + -90° offset.
// J2: inverted direction (sign -1) + +90° offset.
// J4: same direction (sign +1) + -90° offset.
// Used for the live display, the inverse pose-send, and (via POSE_LIBRARY_DEG)
// kept consistent with the green ghost.  Adjust here if a joint still looks
// rotated/reversed.
const JOINT_SIGN: [number, number, number, number, number, number] =
  [1, -1, 1, 1, 1, 1];
const JOINT_OFFSET_DEG: [number, number, number, number, number, number] =
  [-90, 90, 0, -90, 0, 0];

// Joint command slider bounds (deg, controller convention) from the LXM ranges
// documented for the cell.  Sent verbatim to move_joint — NOT remapped, since
// the controller speaks its own convention.
const JOINT_LIMITS_DEG: [number, number, number, number, number, number] =
  [360, 360, 225, 360, 115, 360];

// Second pose library — sim joint angles (URDF degrees), same pipeline as V26:
//   1) wrap each angle to ±180,  2) apply sign·(x − offset) transform.
// Sent via move_joint.
function wrapTo180(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}
const POSE_LIBRARY_DEG: Record<string, [number,number,number,number,number,number]> = {
  HOME: [90.0, 0.0, 0.0, 90.0, -90.0, -89.9],

  APPROACH_CONVEYOR: [69.2, -19.3, 86.7, -15.0, -91.9, -109.3],
  SAFE_CONVEYOR: [66.0, -9.1, 57.5, 24.2, -91.8, -112.4],
  PICK_CONVEYOR: [68.5, -30.1, 91.9, -31.1, -91.4, -110.4],
  LIFT_CONVEYOR: [69.0, -21.5, 50.3, 18.7, -91.4, -109.9],

  SAFE_RIVET: [167.0, -1.8, 51.9, 37.6, -91.4, -109.9],

  APPROACH_PLACE_FIXTURE_1: [185.8, -35.3, 36.0, 19.0, -92.7, -175.1],
  PLACE_FIXTURE_1: [185.3, -35.3, 60.5, -5.3, -92.7, -175.6],
  LIFT_PLACE_FIXTURE_1: [185.5, -34.2, 47.5, 8.7, -92.7, -175.5],

  APPROACH_PLACE_FIXTURE_2: [185.8, -35.3, 36.0, 19.0, -92.7, -175.1],
  PLACE_FIXTURE_2: [185.3, -35.7, 62.1, -7.3, -92.7, -175.6],
  LIFT_FIXTURE_2: [185.6, -35.0, 37.3, 18.0, -92.7, -175.3],

  APPROACH_PICK_FIXTURE_1: [185.8, -35.3, 36.0, 19.0, -92.7, -175.1],
  PICK_FIXTURE_1: [185.3, -36.7, 65.0, -11.2, -92.7, -175.7],
  LIFT_PICK_FIXTURE_1: [185.4, -34.4, 55.1, 1.0, -92.7, -175.6],

  APPROACH_PICK_FIXTURE_2: [185.8, -35.3, 36.0, 19.0, -92.7, -175.1],
  PICK_FIXTURE_2: [185.3, -36.7, 65.0, -11.2, -92.7, -175.7],
  LIFT_PICK_FIXTURE_2: [185.4, -34.4, 55.1, 1.0, -92.7, -175.6],

  SAFE_CAMERA: [238.7, 25.9, 107.2, 9.9, -91.6, -122.8],
  APPROACH_CAMERA: [217.0, -38.3, 67.3, -17.6, -90.1, -145.3],
  PLACE_CAMERA: [216.9, -46.2, 74.8, -32.9, -90.1, -145.4],
  PICK_CAMERA: [216.9, -46.2, 74.8, -32.9, -90.1, -145.4],
  LIFT_PLACE_CAMERA: [217.0, -38.3, 67.3, -17.6, -90.1, -145.3],

  SAFE_BINS: [238.6, 25.7, 107.0, 9.8, -91.6, -122.9],

  APPROACH_REJECTED: [263.6, 5.6, 97.7, 1.8, -93.2, -97.9],
  FIRST_PLACE_REJECTED: [262.4, -14.8, 131.5, -56.7, -91.4, -99.0],
  LIFT_REJECTED: [263.6, 5.6, 97.7, 1.8, -93.2, -97.9],

  APPROACH_ACCEPTED: [87.4, -17.6, -108.9, 3.3, 90.6, -93.8],
  FIRST_PLACE_ACCEPTED: [88.8, 11.3, -139.3, 62.5, 89.9, -92.4],
  LIFT_PLACE_ACCEPTED: [88.7, -17.7, -102.0, -3.5, 90.0, -92.5],

  SAFE_RETURN: [177.9, 14.8, 79.0, 26.4, -90.3, -90.5],
};
// Apply only the V26 sign·(x − offset) transform — NO wrap to ±180.
// All raw values in this library are within ±360° so wrapping is not needed,
// and wrapping J1 values near 185° would cause a spurious ~360° rotation
// (e.g. SAFE_RIVET 167° → 257° but APPROACH_FIXTURE 185.8°wrap→-174.2° → -84°,
//  a 341° jump; without wrap: 185.8° → 275.8°, only 18.8° from SAFE_RIVET).
function lib2BaseCtrlDeg(name: string): number[] {
  const sim = POSE_LIBRARY_DEG[name] ?? POSE_LIBRARY_DEG.HOME;
  return sim.map((deg, i) => JOINT_SIGN[i] * (deg - JOINT_OFFSET_DEG[i]));
}

// Tuned overrides saved by the cartesian tuner (current robot joints).
const LIB2_OVERRIDE_KEY = 'schneider_lib2_overrides_v2';
function loadLib2Overrides(): Record<string, number[]> {
  try {
    const raw = localStorage.getItem(LIB2_OVERRIDE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }
}



// Inverse of the live display map (controller_deg → urdf via sign·ctrl+offset):
// given a simulation pose in URDF radians, recover the controller-convention
// joint degrees to command the real robot.  ctrl = sign·(urdf_deg − offset),
// valid because sign ∈ {+1,−1} so 1/sign = sign.

// Forward of the above: controller-convention joint degrees → URDF radians,
// for previewing a custom slider pose on the green ghost before sending it.
// urdf_deg = sign·ctrl + offset (since sign ∈ {+1,−1}, 1/sign = sign).
function controllerDegToUrdfRad(ctrlDeg: number[]): number[] {
  return ctrlDeg.map((deg, i) =>
    THREE.MathUtils.degToRad(JOINT_SIGN[i] * deg + JOINT_OFFSET_DEG[i]));
}

// Derive the gateway's https/http base from the ws/wss connection URL so the
// control POSTs hit the same origin (…/api/cobot/*).
function gatewayBase(connUrl: string): string {
  try {
    const u = new URL(connUrl);
    const proto = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    return `${proto}//${u.host}`;
  } catch {
    return connUrl.replace(/\/(ws|api)\/.*$/, '');
  }
}

// ── Datalogic P15 inspection result ─────────────────────────────────────────
interface InspectHole {
  label: string; name: string; found: boolean;
  actual_x?: number; actual_y?: number; off_center_px?: number;
  area_px?: number; darkness?: number;
}
interface InspectResult {
  ok: boolean;
  verdict: 'PASS' | 'FAIL';
  holes_found: number;
  holes_expected: number;
  holes: InspectHole[];
  cafi_detected: boolean;
  error?: string;
  image_url?: string;
}

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
  // Magnetic gripper: closed = magnet ON (holding). Reflects the last command
  // sent from the backend (the cabinet DOs aren't read back over Modbus).
  gripper?: { closed: boolean; do_index: number };
  // Pneumatic gripper (cabinet CN2, DO7/DO8): open valve A, close valve B,
  // off keeps the last position. Reflects the last commanded state.
  pneumatic_gripper?: { state: 'off' | 'open' | 'close'; open_do_index: number; close_do_index: number };
  // Photoelectric sensors (live read): true = object detected at that station.
  sensors?: { conveyor: boolean; vision: boolean };
  // Turntable fixture presence (live): true = CAFI loaded on that fixture.
  fixtures?: { fixtureA: boolean; fixtureB: boolean };
  // Conveyor belt motor (DO13): reflects the last commanded on/off state.
  conveyor_motor?: { on: boolean; do_index: number };
  // Linear table: GPIO-driven hardware on the RPi, independent of EcoStruxure
  // Remote Control.  Reads real limit switches; moves non-blocking to a limit.
  table?: {
    available: boolean;
    moving: boolean;
    limit1_touched: boolean;
    limit2_touched: boolean;
    position: 'limit1' | 'limit2' | 'middle';
    last_target: 'limit1' | 'limit2' | null;
  };
  // Backend-side 32-step cycle state machine.  Arrives in every WS frame when
  // the cycle has been started (or has ever run); absent in demo/idle snapshots.
  cycle?: {
    running: boolean;
    step: number;
    total: number;
    pct: number;
    label: string;
    speed: number;
    verdict: 'PASS' | 'FAIL' | null;
    rivet_secs: number;
    rivet_total: number;
    state: 'idle' | 'running' | 'stopped' | 'alarm' | 'done';
    dry_run: boolean;
    error: string | null;
    // Multi-CAFI batch fields (optional — absent in single-CAFI builds)
    cafi_index?: number;
    cafi_total?: number;
    cafi_results?: Array<'PASS' | 'FAIL'>;
  };
  // Live HMI signal block — 19 tags published every WS frame by the gateway
  hmi?: HmiBlock;
  // Pipeline state (concurrent multi-CAFI cycle) — present once pipeline started
  pipeline?: PipelineBlock;
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
  gripper: { closed: false, do_index: 6 },
  pneumatic_gripper: { state: 'off', open_do_index: 7, close_do_index: 8 },
  sensors: { conveyor: false, vision: false },
  fixtures: { fixtureA: false, fixtureB: false },
  conveyor_motor: { on: false, do_index: 13 },
  table: { available: true, moving: false, limit1_touched: true, limit2_touched: false, position: 'limit1', last_target: 'limit1' },
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
  targetRef, tcpWorldRef, robotOutRef, groupOutRef, tcpEulerOutRef,
}: {
  targetRef: React.MutableRefObject<[number, number, number, number, number, number]>;
  tcpWorldRef: React.MutableRefObject<[number, number, number]>;
  robotOutRef?: React.MutableRefObject<URDFRobot | null>;
  groupOutRef?: React.MutableRefObject<THREE.Group | null>;
  tcpEulerOutRef?: React.MutableRefObject<[number, number, number]>;
}) {
  const robot = useCobotUrdf();
  const groupRef = useRef<THREE.Group>(null);
  const liveRef = useRef<[number, number, number, number, number, number]>([...HOME_JOINTS]);

  useFrame((_, dt) => {
    if (!robot) return;
    const k = Math.min(1, dt * 6);
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
      if (tcpEulerOutRef) {
        const q = new THREE.Quaternion();
        tcp.getWorldQuaternion(q);
        const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
        tcpEulerOutRef.current = [e.x, e.y, e.z];
      }
    }
    if (robotOutRef) robotOutRef.current = robot;
    if (groupOutRef && groupRef.current) groupOutRef.current = groupRef.current;
  });

  if (!robot) return null;
  return (
    <group ref={groupRef} position={COBOT_BASE}>
      <primitive object={robot} />
    </group>
  );
}

// Translucent green "ghost" of the cobot at a target pose (URDF radians),
// overlaid on the live model to preview where a simulation pose will send it.
// Loads its own URDF instance so it doesn't fight the live robot's joints.
function GhostCobot({ jointsRad, visible }: { jointsRad: number[]; visible: boolean }) {
  const robot = useCobotUrdf();
  const targetRef = useRef(jointsRad);
  targetRef.current = jointsRad; // keep useFrame reading the latest target
  const liveRef = useRef<number[]>([...jointsRad]); // eased current joints
  // Shared green translucent material applied to every mesh.
  const ghostMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: '#22dd55', emissive: new THREE.Color('#0e5a23'),
    transparent: true, opacity: 0.32, depthWrite: false,
    metalness: 0.1, roughness: 0.6,
  }), []);
  // The URDF's STL meshes load asynchronously AFTER parse, so a one-shot
  // material swap misses them.  Re-apply every frame (no-op once a mesh
  // already carries the ghost material) so newly-loaded meshes get tinted.
  // Joints ease toward the target so changing pose (or the sequence player)
  // shows smooth motion instead of snapping.
  useFrame((_, dt) => {
    if (!robot) return;
    robot.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh && m.material !== ghostMat) {
        m.material = ghostMat;
        m.castShadow = false; m.receiveShadow = false; m.renderOrder = 3;
      }
    });
    const t = targetRef.current;
    const k = Math.min(1, dt * 5);
    for (let i = 0; i < 6 && i < t.length; i++) {
      liveRef.current[i] += (t[i] - liveRef.current[i]) * k;
      robot.setJointValue(`joint_${i + 1}`, liveRef.current[i]);
    }
  });
  if (!robot) return null;
  return (
    <group visible={visible} position={COBOT_BASE}>
      <primitive object={robot} />
    </group>
  );
}

function ZUp() {
  const { camera, scene } = useThree();
  useEffect(() => {
    camera.up.set(0, 0, 1);
    scene.up.set(0, 0, 1);
    camera.lookAt(MESA_CENTRE[0], MESA_CENTRE[1], 1.1);
    camera.updateProjectionMatrix();
  }, [camera, scene]);
  return null;
}

// Drives the turntable disc angle from the linear-table telemetry.  The table
// physically rotates the disc 180° between its two limit switches, taking ~4 s
// switch-to-switch — so limit1 → 0 rad, limit2 → π rad at π/4 rad·s⁻¹.  While
// moving:true the disc eases toward last_target; when settled it snaps to the
// resting position.  No real-time angle is published, so this is a faithful
// time-based reconstruction, not a readback.
const TABLE_ANGLE_LIMIT2 = Math.PI;       // 180° at limit2
const TABLE_ANGLE_SPEED  = Math.PI / 4;   // rad/s → 4 s for the full 180° sweep
function TurntableDriver({
  angleRef, telemetryRef,
}: {
  angleRef: React.MutableRefObject<number>;
  telemetryRef: React.MutableRefObject<CobotTelemetry>;
}) {
  useFrame((_, dt) => {
    const t = telemetryRef.current.table;
    if (!t) return;
    let target = angleRef.current;
    if (t.moving) {
      if (t.last_target === 'limit2') target = TABLE_ANGLE_LIMIT2;
      else if (t.last_target === 'limit1') target = 0;
    } else {
      if (t.position === 'limit2') target = TABLE_ANGLE_LIMIT2;
      else if (t.position === 'limit1') target = 0;
    }
    const cur = angleRef.current;
    const diff = target - cur;
    const step = TABLE_ANGLE_SPEED * dt;
    angleRef.current = Math.abs(diff) <= step ? target : cur + Math.sign(diff) * step;
  });
  return null;
}

// ── Telemetry panel helpers ─────────────────────────────────────────────────
const statRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between',
  fontSize: 11, fontFamily: 'monospace', color: '#abc', padding: '3px 0',
};
const numInput: React.CSSProperties = {
  fontFamily: 'monospace', fontSize: 11, color: '#dde4f0',
  background: '#0a1422', border: '1px solid #1d2c44', borderRadius: 4,
  padding: '4px 6px', outline: 'none',
};
function ctrlBtn(enabled: boolean, c1: string, c2: string): React.CSSProperties {
  return {
    fontFamily: SANS_FONT, fontSize: 11, fontWeight: 700, color: '#fff',
    cursor: enabled ? 'pointer' : 'not-allowed', border: 'none', borderRadius: 6,
    padding: '8px 6px',
    background: enabled ? `linear-gradient(180deg,${c1} 0%,${c2} 100%)` : '#2a3548',
    opacity: enabled ? 1 : 0.55,
  };
}

// Round to `decimals` and stringify without trailing/leading-zero noise
// (90 → "90", 90.5 → "90.5").
function fmtNum(n: number, decimals: number): string {
  if (!isFinite(n)) return '0';
  const p = 10 ** decimals;
  return String(Math.round(n * p) / p);
}
function clampNum(n: number, min?: number, max?: number): number {
  if (min !== undefined) n = Math.max(min, n);
  if (max !== undefined) n = Math.min(max, n);
  return n;
}

// Numeric text field that avoids the controlled-number-input quirks (leading
// zeros, lost cursor).  Shows the raw edit string while focused, selects all
// on focus so a fresh value replaces the old one, and normalises on blur.
function NumField({
  value, onChange, disabled, min, max, decimals = 2, width = 56,
}: {
  value: number; onChange: (n: number) => void; disabled?: boolean;
  min?: number; max?: number; decimals?: number; width?: number | string;
}) {
  const [text, setText] = useState(() => fmtNum(value, decimals));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(fmtNum(value, decimals)); }, [value, editing, decimals]);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      disabled={disabled}
      onFocus={(e) => { setEditing(true); e.currentTarget.select(); }}
      onChange={(e) => {
        // Keep only characters valid in a decimal number so stray input (e.g.
        // AltGr+E → "€") can never land in the field and poison the command.
        const t = e.target.value.replace(/[^0-9.\-]/g, '');
        setText(t);
        const n = parseFloat(t);
        if (Number.isFinite(n)) onChange(clampNum(n, min, max));
      }}
      onBlur={() => {
        setEditing(false);
        const n = parseFloat(text);
        const fixed = clampNum(Number.isFinite(n) ? n : 0, min, max);
        onChange(fixed);
        setText(fmtNum(fixed, decimals));
      }}
      style={{ ...numInput, width, textAlign: 'left' }}
    />
  );
}
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
  const [lastFrameTs, setLastFrameTs] = useState(0);
  const [applyToModel, setApplyToModel] = useState(false);
  const [connErr, setConnErr] = useState<string | null>(null);

  // ── Camera live-feed state ─────────────────────────────────────────────
  // Inject the spinner keyframe once (inline styles can't define @keyframes).
  useEffect(() => {
    const id = 'cam-spin-kf';
    if (document.getElementById(id)) return;
    const st = document.createElement('style');
    st.id = id;
    st.textContent = '@keyframes cam-spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(st);
  }, []);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);   // global camera lock
  const [cameraBusyLabel, setCameraBusyLabel] = useState('');  // what op is running
  const [cameraGifUrl, setCameraGifUrl] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [shutterUs, setShutterUs] = useState(200000);          // slider value
  const [appliedShutter, setAppliedShutter] = useState<number | null>(null); // last applied
  const [camView, setCamView] = useState<'none' | 'feed' | 'inspect'>('none');
  const [inspectImgUrl, setInspectImgUrl] = useState<string | null>(null);
  const [inspectResult, setInspectResult] = useState<InspectResult | null>(null);

  // ── Control state ──────────────────────────────────────────────────────
  const [cmdJoints, setCmdJoints] = useState<number[]>([...DEMO_TELEMETRY.joint_positions_deg]);
  const [jointSpeed, setJointSpeed] = useState(15);
  const [cart, setCart] = useState({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 });
  const [cartSpeed, setCartSpeed] = useState(20);
  const [cmdBusy, setCmdBusy] = useState(false);
  const [cmdStatus, setCmdStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const cmdInitRef = useRef(false); // seed command inputs from first live telemetry
  const [showGhost, setShowGhost] = useState(true);
  // Ghost source: 'pose' = the dropdown POSE_LIB selection; 'custom' = the live
  // jog sliders (cmdJoints).  Moving a slider switches to 'custom' so the green
  // ghost previews exactly where the robot will go before MOVER JOINTS is sent.
  const [ghostSource, setGhostSource] = useState<'lib2' | 'custom'>('lib2');
  const [selectedLib2, setSelectedLib2] = useState<string>('HOME');
  // Cartesian tuner + saved overrides for the library-2 poses.
  const [lib2Overrides, setLib2Overrides] = useState<Record<string, number[]>>(loadLib2Overrides);
  // Panel tabs for the side panel.
  const [panelTab, setPanelTab] = useState<'hmi' | 'control'>('hmi');
  // Demonstration cycle state.
  const CYCLE_TOTAL = 32;
  const RIVET_SECS  = 30;
  const INSPECT_WAIT_SECS = 5;
  const [cycleSpeed, setCycleSpeed] = useState(15); // % speed for demo, user-adjustable
  const [dryRun, setDryRun] = useState(true);
  const [showPendant, setShowPendant] = useState(false);
  const [showHmi, setShowHmi] = useState(false);
  const [hmiPos, setHmiPos] = useState({ x: 40, y: 40 });
  const [pendantCmdPending, setPendantCmdPending] = useState(false);
  const [pendantJointsSnapshot, setPendantJointsSnapshot] = useState<number[]>([...HOME_JOINTS]);
  const [cycleRunning, setCycleRunning] = useState(false);
  const [cycleStep, setCycleStep] = useState('— en espera');
  const [cycleStepIdx, setCycleStepIdx] = useState(0);
  const [cycleRivetSecs, setCycleRivetSecs] = useState(0);
  const [cycleVerdict, setCycleVerdict] = useState<'PASS' | 'FAIL' | null>(null);
  const [cycleError, setCycleError] = useState<string | null>(null);
  const cycleAbortRef = useRef(false);
  const [tunerStepMm, setTunerStepMm] = useState(5);
  const [tunerStepDeg, setTunerStepDeg] = useState(2);
  const [saveName, setSaveName] = useState('HOME');
  // Auto-stop the conveyor when its photoelectric sensor detects an object.
  const [autoStopConveyor, setAutoStopConveyor] = useState(true);
  const autoStopFiredRef = useRef(false);
  // Sequence player. Ghost mode = visualisation only; Real mode = drives the
  // physical cobot pose-by-pose, waiting for each arrival before advancing.

  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<number | null>(null);
  const manualCloseRef = useRef(false);   // distinguishes user disconnect from a drop
  const autoStartedRef = useRef(false);    // auto-connect only once per mount
  // 3D cobot reads these; default HOME, driven by telemetry only when applyToModel.
  const targetJointsRef = useRef<[number, number, number, number, number, number]>([...HOME_JOINTS]);
  const tcpWorldRef = useRef<[number, number, number]>([0, 0, 0]);
  // Turntable disc angle (static at 0 for now) + its loaded URDF handle.
  const turntableAngleRef = useRef(0);
  const turntableRobotRef = useRef<URDFRobot | null>(null);
  // Teach Pendant — refs shared between LiveCobot (FK source) and ManualJogger (jog sink).
  const pendantRobotRef  = useRef<URDFRobot | null>(null);
  const pendantGroupRef  = useRef<THREE.Group | null>(null);
  const pendantJointsRef = useRef<[number,number,number,number,number,number]>([...HOME_JOINTS]);
  const pendantTcpEulerRef    = useRef<[number,number,number]>([0,0,0]);
  const pendantManualMovingRef = useRef(false);
  const pendantJogCmdRef  = useRef<{kind:'joint'|'linear';axis:number;dir:number}|null>(null);
  const pendantJogVelocityRef = useRef(JOG_REAL_DEFAULT_FRAC);
  const pendantPoseDirtyRef   = useRef(false);
  const pendantAlignCmdRef    = useRef<'rx0'|null>(null);
  const pendantRealModeRef    = useRef(true);
  // Latest telemetry, readable synchronously inside the async sequence runner.
  const telemetryRef = useRef(telemetry);
  telemetryRef.current = telemetry;

  // Drive the model from telemetry: deg → rad, applying per-joint sign and
  // zero-offset (JOINT_SIGN / JOINT_OFFSET_DEG) to align with the real robot.
  useEffect(() => {
    if (applyToModel && telemetry.joint_positions_deg?.length === 6) {
      targetJointsRef.current = telemetry.joint_positions_deg.map((d, i) =>
        THREE.MathUtils.degToRad(JOINT_SIGN[i] * d + JOINT_OFFSET_DEG[i])) as
        [number, number, number, number, number, number];
    } else {
      targetJointsRef.current = [...HOME_JOINTS];
    }
  }, [applyToModel, telemetry]);

  // Keep pendant joints in sync with telemetry when not actively jogging.
  useEffect(() => {
    if (pendantJogCmdRef.current || pendantManualMovingRef.current) return;
    if (telemetry.joint_positions_deg?.length === 6) {
      pendantJointsRef.current = telemetry.joint_positions_deg.map((d, i) =>
        THREE.MathUtils.degToRad(JOINT_SIGN[i] * d + JOINT_OFFSET_DEG[i])) as [number,number,number,number,number,number];
    }
  }, [telemetry]);

  // Seed the command inputs from the first real (non-demo) telemetry so the
  // operator jogs from the robot's actual pose, not zeros.
  useEffect(() => {
    if (mode === 'live' && !telemetry._demo && !cmdInitRef.current
        && telemetry.joint_positions_deg?.length === 6) {
      cmdInitRef.current = true;
      syncCmdFromLive();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, telemetry]);

  const syncCmdFromLive = () => {
    setCmdJoints([...telemetry.joint_positions_deg]);
    setCart({
      x: telemetry.tcp_position.x_mm, y: telemetry.tcp_position.y_mm, z: telemetry.tcp_position.z_mm,
      rx: telemetry.tcp_position.rx_deg, ry: telemetry.tcp_position.ry_deg, rz: telemetry.tcp_position.rz_deg,
    });
  };

  // POST a control command to the gateway.  Surfaces errorCode "3" (Remote
  // Control not delegated) as a clear, actionable message and returns the
  // outcome so the sequence runner can decide whether to continue.
  const postControl = async (path: string, body?: object): Promise<{ ok: boolean; error: string }> => {
    setCmdBusy(true);
    setCmdStatus(null);
    try {
      const res = await fetch(`${gatewayBase(url)}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const denied = String(j.errorCode) === '3' || String(j.errorCode) === '1' || /permission|remote control/i.test(j.error || '');
      if (denied) {
        const msg = 'Permiso denegado — abre EcoStruxure Cobot Expert (PC 10.5.5.101) y ponlo en Remote Control.';
        setCmdStatus({ ok: false, msg }); return { ok: false, error: msg };
      } else if (j.ok === false) {
        const msg = j.error || 'Comando rechazado por el cobot.';
        setCmdStatus({ ok: false, msg }); return { ok: false, error: msg };
      } else {
        setCmdStatus({ ok: true, msg: 'Comando aceptado.' }); return { ok: true, error: '' };
      }
    } catch (e) {
      const msg = `Sin respuesta del gateway (${String(e)}).`;
      setCmdStatus({ ok: false, msg }); return { ok: false, error: msg };
    } finally {
      setCmdBusy(false);
    }
  };

  const moveJoint = () => {
    if (!cmdJoints.every(Number.isFinite)) { setCmdStatus({ ok: false, msg: 'Hay un joint con valor inválido — corrígelo antes de mover.' }); return; }
    postControl('/api/cobot/move/joint', { joints: cmdJoints, speed: jointSpeed, relative: false });
  };
  const moveCartesian = () => {
    const vals = [cart.x, cart.y, cart.z, cart.rx, cart.ry, cart.rz];
    if (!vals.every(Number.isFinite)) { setCmdStatus({ ok: false, msg: 'Hay un valor cartesiano inválido (revisa X/Y/Z/RX/RY/RZ).' }); return; }
    postControl('/api/cobot/move/cartesian', { x: cart.x, y: cart.y, z: cart.z, rx: cart.rx, ry: cart.ry, rz: cart.rz, speed: cartSpeed });
  };
  const cobotStop = () => postControl('/api/cobot/stop');
  const cobotPowerOn = () => postControl('/api/cobot/power_on');
  const cobotPowerOff = () => {
    if (!window.confirm('¿Apagar la potencia del cobot? El robot quedará sin par de motores.')) return;
    postControl('/api/cobot/power_off');
  };
  const cobotEnable = () => postControl('/api/cobot/enable');
  const cobotDisable = () => postControl('/api/cobot/disable');
  // Magnetic gripper: closed=true energises the magnet (grab), false releases.
  const setGripper = (closed: boolean) => postControl('/api/cobot/gripper', { closed });
  // Pneumatic gripper: 3-state (open valve A / close valve B / off both).
  const setPneumaticGripper = (action: 'open' | 'close' | 'off') =>
    postControl('/api/cobot/pneumatic_gripper', { action });
  // Conveyor belt motor (DO13): on/off.
  const setConveyorMotor = (on: boolean) => postControl('/api/cobot/conveyor', { on });

  // ── Camera (Datalogic P15) ──────────────────────────────────────────────
  // The backend serialises all camera ops with a lock, so the panel keeps a
  // single global busy flag (cameraLoading) and disables every camera button
  // while one is running.  Friendly "camera busy" handling throughout.

  // Live 5 s GIF.  ~6 s round trip; cache-busted; blob → object URL.
  const fetchCameraFeed = async () => {
    if (cameraLoading) return;
    setCameraLoading(true); setCameraBusyLabel('Capturando 5 s…'); setCameraError(null); setCamView('feed');
    try {
      const res = await fetch(`${gatewayBase(url)}/api/camera/live5?t=${Date.now()}`, {
        headers: { 'ngrok-skip-browser-warning': 'true' }, cache: 'no-store',
      });
      if (res.status === 503) { setCameraError('La cámara está ocupada, espera unos segundos.'); return; }
      if (!res.ok) { setCameraError(`Error ${res.status} al obtener el live feed.`); return; }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      setCameraGifUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return objUrl; });
    } catch (e) {
      setCameraError(`Sin respuesta del gateway (${String(e)}).`);
    } finally {
      setCameraLoading(false); setCameraBusyLabel('');
    }
  };

  // Run a CAFI inspection: POST /inspect → JSON verdict, then fetch the
  // annotated PNG.  "camera busy" arrives as ok:false; a missing CAFI arrives
  // as ok:true + cafi_detected:false + error.
  const runInspection = async () => {
    if (cameraLoading) return;
    setCameraLoading(true); setCameraBusyLabel('Inspeccionando…'); setCameraError(null); setCamView('inspect');
    try {
      const res = await fetch(`${gatewayBase(url)}/api/camera/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      });
      const j: InspectResult = await res.json().catch(() => ({} as InspectResult));
      if (!res.ok || j.ok === false) {
        const msg = /busy/i.test(j.error || '') ? 'La cámara está ocupada, espera unos segundos.'
          : (j.error || `Error ${res.status} en la inspección.`);
        setCameraError(msg); return;
      }
      setInspectResult(j);
      if (!j.cafi_detected) {
        // No CAFI in frame: the backend keeps the previous annotated image, so
        // don't show a stale photo — clear it and let the panel show a notice.
        setInspectImgUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
      } else {
        // Annotated image (cache-busted blob).
        const imgRes = await fetch(`${gatewayBase(url)}/api/camera/inspect/last_image?t=${Date.now()}`, {
          headers: { 'ngrok-skip-browser-warning': 'true' }, cache: 'no-store',
        });
        if (imgRes.ok) {
          const blob = await imgRes.blob();
          const objUrl = URL.createObjectURL(blob);
          setInspectImgUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return objUrl; });
        }
      }
    } catch (e) {
      setCameraError(`Sin respuesta del gateway (${String(e)}).`);
    } finally {
      setCameraLoading(false); setCameraBusyLabel('');
    }
  };

  // Apply the shutter slider value (µs) via CORBA on the backend.
  const applyShutter = async () => {
    if (cameraLoading) return;
    setCameraLoading(true); setCameraBusyLabel('Aplicando obturación…'); setCameraError(null);
    try {
      const res = await fetch(`${gatewayBase(url)}/api/camera/shutter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
        body: JSON.stringify({ microseconds: shutterUs }),
      });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok || j.ok === false) {
        setCameraError(/busy/i.test(j.error || '') ? 'La cámara está ocupada, espera unos segundos.'
          : (j.error || `Error ${res.status} al cambiar la obturación.`));
        return;
      }
      setAppliedShutter(typeof j.microseconds === 'number' ? j.microseconds : shutterUs);
    } catch (e) {
      setCameraError(`Sin respuesta del gateway (${String(e)}).`);
    } finally {
      setCameraLoading(false); setCameraBusyLabel('');
    }
  };
  const openCamera = () => setCameraOpen(true);

  // ── Linear table (GPIO hardware, independent of EcoStruxure) ────────────
  // Non-blocking: the API returns immediately, the table moves until it
  // touches the destination limit switch and stops itself.  No Remote Control
  // needed.  Dedicated handler so we surface table-specific responses
  // (already_there, invalid target) instead of the cobot Remote-Control text.
  const postTable = async (path: string, body?: object) => {
    setCmdStatus(null);
    try {
      const res = await fetch(`${gatewayBase(url)}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (j.ok === false) { setCmdStatus({ ok: false, msg: j.error || 'Comando de mesa rechazado.' }); return; }
      if (j.already_there) { setCmdStatus({ ok: true, msg: `La mesa ya está en ${j.target}.` }); return; }
      setCmdStatus({ ok: true, msg: 'Comando de mesa aceptado.' });
    } catch (e) {
      setCmdStatus({ ok: false, msg: `Sin respuesta del gateway (${String(e)}).` });
    }
  };
  const tableMove = (target: 'limit1' | 'limit2') => postTable('/api/table/move', { target });
  const tableStop = () => postTable('/api/table/stop', {});

  // RPi-side cycle endpoints — no Remote Control gate, no cmdBusy flag.
  const postCycle = async (path: string, body?: object) => {
    try {
      const res = await fetch(`${gatewayBase(url)}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok || j.ok === false) {
        setCmdStatus({ ok: false, msg: j.error || `Error ${res.status} en ciclo RPi.` });
      } else {
        setCmdStatus({ ok: true, msg: 'Ciclo RPi: comando aceptado.' });
      }
    } catch (e) {
      setCmdStatus({ ok: false, msg: `Sin respuesta del gateway (${String(e)}).` });
    }
  };
  const rpiCycleStart = async () => {
    await postCycle('/api/cycle/speed', { speed: cycleSpeed });
    postCycle('/api/cycle/start', { dry_run: dryRun });
  };
  const rpiCycleStop  = () => postCycle('/api/cycle/stop');
  const rpiCycleReset = () => postCycle('/api/cycle/reset');

  // Teach Pendant: move real robot to a URDF-rad target.
  const pendantStartJointMove = (targetRad: number[]) => {
    const ctrlDeg = targetRad.map((r, i) =>
      JOINT_SIGN[i] * (THREE.MathUtils.radToDeg(r) - JOINT_OFFSET_DEG[i]));
    setPendantCmdPending(true);
    postControl('/api/cobot/move/joint', { joints: ctrlDeg, speed: jointSpeed, relative: false })
      .then(() => setPendantCmdPending(false));
  };
  const pendantStopMove = () => { pendantJogCmdRef.current = null; };

  const onHmiDragDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const ox = hmiPos.x, oy = hmiPos.y, mx = e.clientX, my = e.clientY;
    const onMove = (ev: MouseEvent) => setHmiPos({ x: ox + ev.clientX - mx, y: oy + ev.clientY - my });
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Flush jog moves to API and keep ghost snapshot fresh while pendant is open.
  const pendantFlushRef = useRef<(() => void) | null>(null);
  pendantFlushRef.current = () => {
    if (pendantPoseDirtyRef.current && !pendantJogCmdRef.current) {
      pendantPoseDirtyRef.current = false;
      const ctrlDeg = pendantJointsRef.current.map((r, i) =>
        JOINT_SIGN[i] * (THREE.MathUtils.radToDeg(r) - JOINT_OFFSET_DEG[i]));
      postControl('/api/cobot/move/joint', { joints: ctrlDeg, speed: jointSpeed, relative: false });
    }
  };
  useEffect(() => {
    if (!showPendant) return;
    const iv = setInterval(() => {
      setPendantJointsSnapshot([...pendantJointsRef.current]);
      pendantFlushRef.current?.();
    }, 100);
    return () => clearInterval(iv);
  }, [showPendant]);


  // Effective controller joints for a library-2 pose: override wins over base.
  const lib2CtrlDeg = (name: string): number[] => lib2Overrides[name] ?? lib2BaseCtrlDeg(name);
  const hasOverride = (name: string): boolean => !!lib2Overrides[name];

  // Send the selected library-2 pose via move_joint.
  const sendLib2ToRobot = () =>
    postControl('/api/cobot/move/joint', { joints: lib2CtrlDeg(selectedLib2), speed: jointSpeed, relative: false });

  // ── Cartesian tuner ─────────────────────────────────────────────────────
  // Nudge the real TCP along one axis: read the live TCP pose, apply the step,
  // and send an absolute moveL.  Translation in mm, rotation in degrees.
  const nudgeTcp = (axis: 'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz', dir: 1 | -1) => {
    const t = telemetry.tcp_position;
    if (!t) return;
    const stepT = tunerStepMm * dir;
    const stepR = tunerStepDeg * dir;
    const next = {
      x: t.x_mm + (axis === 'x' ? stepT : 0),
      y: t.y_mm + (axis === 'y' ? stepT : 0),
      z: t.z_mm + (axis === 'z' ? stepT : 0),
      rx: t.rx_deg + (axis === 'rx' ? stepR : 0),
      ry: t.ry_deg + (axis === 'ry' ? stepR : 0),
      rz: t.rz_deg + (axis === 'rz' ? stepR : 0),
    };
    postControl('/api/cobot/move/cartesian', { ...next, speed: cartSpeed });
  };
  // Save the robot's CURRENT real joints as the override for a library-2 pose.
  const saveLib2Pose = (name: string) => {
    const jp = telemetry.joint_positions_deg;
    if (!jp || jp.length !== 6) { setCmdStatus({ ok: false, msg: 'Sin telemetría de joints para guardar.' }); return; }
    const next = { ...lib2Overrides, [name]: [...jp] };
    setLib2Overrides(next);
    try { localStorage.setItem(LIB2_OVERRIDE_KEY, JSON.stringify(next)); } catch { /* quota */ }
    setCmdStatus({ ok: true, msg: `Pose "${name}" guardada con los joints actuales.` });
  };
  const deleteLib2Override = (name: string) => {
    const next = { ...lib2Overrides }; delete next[name];
    setLib2Overrides(next);
    try { localStorage.setItem(LIB2_OVERRIDE_KEY, JSON.stringify(next)); } catch { /* quota */ }
    setCmdStatus({ ok: true, msg: `Override de "${name}" eliminado (vuelve al TCP original).` });
  };

  // ── Demonstration cycle ──────────────────────────────────────────────────
  const runDemoCycle = async () => {
    if (cycleRunning || mode !== 'live') return;
    cycleAbortRef.current = false;
    setCycleRunning(true); setCycleVerdict(null); setCycleError(null);
    setCycleStepIdx(0); setCycleRivetSecs(0); setCycleStep('Iniciando…');

    const gBase = gatewayBase(url);
    const chk = () => { if (cycleAbortRef.current) throw new Error('DETENIDO'); };
    const sleepChk = async (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { chk(); await new Promise(r => window.setTimeout(r, Math.min(120, end - Date.now()))); }
    };
    const waitFor = async (cond: () => boolean, timeoutMs: number, label: string) => {
      const end = Date.now() + timeoutMs;
      while (!cond()) { chk(); if (Date.now() > end) throw new Error(`Timeout: ${label}`); await new Promise(r => window.setTimeout(r, 200)); }
    };
    const cycleFetch = async (path: string, body?: object) => {
      chk();
      const res = await fetch(`${gBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' }, body: body ? JSON.stringify(body) : undefined });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      return j;
    };
    const st = (label: string, idx: number) => { chk(); setCycleStep(label); setCycleStepIdx(idx); };
    const moveR = async (pose: string, label: string, idx: number) => {
      st(label, idx); setSelectedLib2(pose); setGhostSource('lib2');
      await cycleFetch('/api/cobot/move/joint', { joints: lib2CtrlDeg(pose), speed: cycleSpeed, relative: false });
      await sleepChk(400);
      await waitFor(() => telemetryRef.current.status?.inpos === true, 30000, `inpos ${pose}`);
    };
    const grip = async (action: 'open' | 'close' | 'off') => { await cycleFetch('/api/cobot/pneumatic_gripper', { action }); await sleepChk(800); };
    const tblMove = async (target: 'limit1' | 'limit2') => { await cycleFetch('/api/table/move', { target }); };
    const waitTbl = async (pos: 'limit1' | 'limit2') => { await waitFor(() => telemetryRef.current.table?.position === pos, 20000, `mesa ${pos}`); };

    try {
      // 1. Turntable homing: nudge to limit2 then immediately back to limit1
      st('Alineando turntable…', 1);
      await tblMove('limit2'); await sleepChk(500); await tblMove('limit1'); await waitTbl('limit1');

      // 2-7. Pick CAFI from conveyor
      await moveR('HOME',             'HOME',              2);
      // Start conveyor belt and wait for the sensor to detect the CAFI.
      st('Encendiendo banda…', 3);
      await cycleFetch('/api/cobot/conveyor', { on: true });
      await waitFor(() => telemetryRef.current.sensors?.conveyor === true, 30000, 'CAFI en sensor');
      // Stop the belt (auto-stop may have already done it, but be explicit).
      await cycleFetch('/api/cobot/conveyor', { on: false });
      await sleepChk(300); // let the part settle
      await moveR('SAFE_CONVEYOR',    'Safe conveyor',     3);
      await moveR('APPROACH_CONVEYOR','Approach conveyor', 4);
      await moveR('PICK_CONVEYOR',    'Pick conveyor',     5);
      await grip('close');
      await moveR('LIFT_CONVEYOR',    'Lift conveyor',     6);

      // 8-11. Place on fixture A (table at limit1 → fixture A accessible)
      await moveR('SAFE_RIVET',               'Tránsito → fixture', 7);
      await moveR('APPROACH_PLACE_FIXTURE_1', 'Approach fixture A',  8);
      await moveR('PLACE_FIXTURE_1',          'Place fixture A',     9);
      await grip('open');
      await moveR('LIFT_PLACE_FIXTURE_1',     'Lift fixture A',     10);
      await moveR('SAFE_RIVET',               'Esperando turntable…',11);

      // 12. Rotate to limit2 for riveting → wait 30s → return
      st('Girando a posición remache…', 12);
      await tblMove('limit2'); await waitTbl('limit2');
      for (let s = 1; s <= RIVET_SECS; s++) { chk(); setCycleRivetSecs(s); setCycleStep(`Remachando… ${s}/${RIVET_SECS}s`); await sleepChk(1000); }
      st('Retornando turntable…', 13);
      await tblMove('limit1'); await waitTbl('limit1');

      // 14-16. Pick riveted CAFI from fixture A
      await moveR('APPROACH_PICK_FIXTURE_1', 'Approach pick fixture A', 14);
      await moveR('PICK_FIXTURE_1',          'Pick fixture A',           15);
      await grip('close');
      await moveR('LIFT_PICK_FIXTURE_1',     'Lift fixture A',           16);

      // 17-22. Carry to vision plate
      await moveR('SAFE_RIVET',         'Tránsito → cámara',    17);
      await moveR('SAFE_CAMERA',        'Safe camera',           18);
      await moveR('APPROACH_CAMERA',    'Approach cámara',       19);
      await moveR('PLACE_CAMERA',       'Place placa visión',    20);
      await grip('open');
      await moveR('LIFT_PLACE_CAMERA',  'Lift placa visión',     21);
      await moveR('SAFE_CAMERA',        'Esperando inspección…', 22);

      // 23. Wait 5s then inspect
      for (let s = 1; s <= INSPECT_WAIT_SECS; s++) { chk(); setCycleStep(`Esperando inspección… ${s}/${INSPECT_WAIT_SECS}s`); await sleepChk(1000); }
      st('Capturando imagen…', 23);
      const inspRes = await fetch(`${gBase}/api/camera/inspect`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' } });
      const inspJson: InspectResult = await inspRes.json().catch(() => ({} as InspectResult));
      const verdict = inspJson.ok ? (inspJson.verdict ?? 'FAIL') : 'FAIL';
      setCycleVerdict(verdict);

      // 24-27. Pick from plate and go to bins
      await moveR('APPROACH_CAMERA',   'Approach cámara (pick)', 24);
      await moveR('PICK_CAMERA',       'Pick placa visión',       25);
      await grip('close');
      await moveR('LIFT_PLACE_CAMERA', 'Lift placa visión',       26);
      await moveR('SAFE_BINS',         'Safe bins',               27);

      // 28-30. Route by verdict
      if (verdict === 'PASS') {
        await moveR('APPROACH_ACCEPTED',     'Approach bin aceptado', 28);
        await moveR('FIRST_PLACE_ACCEPTED',  'Place bin aceptado',    29);
        await grip('open');
        await moveR('LIFT_PLACE_ACCEPTED',   'Lift bin aceptado',     30);
      } else {
        await moveR('APPROACH_REJECTED',     'Approach bin rechazado', 28);
        await moveR('FIRST_PLACE_REJECTED',  'Place bin rechazado',    29);
        await grip('open');
        await moveR('LIFT_REJECTED',         'Lift bin rechazado',     30);
      }

      // 31-32. Return home
      await moveR('SAFE_RETURN', 'Safe return', 31);
      await moveR('HOME',        'HOME',         32);
      st('✓ Ciclo completo', 32);

    } catch (e) {
      if (cycleAbortRef.current) { setCycleStep('— Detenido por operador'); }
      else { setCycleError(String(e).replace('Error: ', '')); }
    } finally { setCycleRunning(false); }
  };

  const stopCycle = () => {
    cycleAbortRef.current = true;
    fetch(`${gatewayBase(url)}/api/cobot/stop`, { method: 'POST', headers: { 'ngrok-skip-browser-warning': 'true' } }).catch(() => {});
    fetch(`${gatewayBase(url)}/api/table/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' }, body: '{}' }).catch(() => {});
  };
  const resetCycle = () => {
    cycleAbortRef.current = true;
    setCycleRunning(false); setCycleStep('— en espera');
    setCycleStepIdx(0); setCycleRivetSecs(0); setCycleVerdict(null); setCycleError(null);
  };

  // STOP: abort any running sequence AND command the robot to halt.
  const handleStop = () => { cobotStop(); };

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
          try { setTelemetry(JSON.parse(e.data)); setLastFrameTs(Date.now()); } catch { /* ignore malformed frame */ }
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

  // Track camera object URLs so unmount can revoke them without re-running the
  // cleanup every time a URL changes.
  const cameraGifUrlRef = useRef<string | null>(null);
  cameraGifUrlRef.current = cameraGifUrl;
  const inspectImgUrlRef = useRef<string | null>(null);
  inspectImgUrlRef.current = inspectImgUrl;
  useEffect(() => () => { // cleanup on unmount
    manualCloseRef.current = true;
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    if (pollRef.current) window.clearInterval(pollRef.current);
    if (cameraGifUrlRef.current) URL.revokeObjectURL(cameraGifUrlRef.current);
    if (inspectImgUrlRef.current) URL.revokeObjectURL(inspectImgUrlRef.current);
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
  // Control commands only make sense against a reachable gateway.
  const controlEnabled = mode === 'live';
  // Gripper magnet state (last commanded; see stream caveat). Drives the toggle.
  const gripperClosed = telemetry.gripper?.closed ?? false;
  // Pneumatic gripper state (last commanded), drives the 3-button selector.
  const pneuState = telemetry.pneumatic_gripper?.state ?? 'off';
  // Photoelectric sensors (live) + conveyor motor (last commanded).
  const sensorConveyor = telemetry.sensors?.conveyor ?? false;
  const sensorVision = telemetry.sensors?.vision ?? false;
  const conveyorOn = telemetry.conveyor_motor?.on ?? false;
  const fixtureA = telemetry.fixtures?.fixtureA ?? false;
  const fixtureB = telemetry.fixtures?.fixtureB ?? false;

  // Auto-stop: when the conveyor sensor detects an object while the belt is
  // running, turn the motor off once.  Re-arms when the sensor clears.
  useEffect(() => {
    if (!autoStopConveyor || mode !== 'live') return;
    if (sensorConveyor && conveyorOn && !autoStopFiredRef.current) {
      autoStopFiredRef.current = true;
      setConveyorMotor(false);
    }
    if (!sensorConveyor) autoStopFiredRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sensorConveyor, conveyorOn, autoStopConveyor, mode]);
  // Layout offsets (same as Celda 3D tab) — align conveyor, bins, turntable.
  const layout = useLayoutOffsets(true);
  // RPi-side cycle state (comes in every WS frame when cycle has ever started).
  const rpiCycle = telemetry.cycle ?? null;
  const rpiRunning = rpiCycle?.running ?? false;
  const rpiState   = rpiCycle?.state ?? 'idle';
  const rpiStateColor =
    rpiState === 'running' ? '#22dd55' :
    rpiState === 'done'    ? '#3b8bff' :
    rpiState === 'alarm'   ? '#ef4444' :
    rpiState === 'stopped' ? '#fbbf24' : '#5a6c84';

  // Ghost target: custom slider pose, V26 dropdown, or library-2.
  // For lib2: use the full wrap→transform pipeline (same as robot command) but
  // add 2π to any joint whose RAW sim angle is above 180°.  wrapTo180 flips
  // those values negative (185.8°→-174.2°), which after the transform produces
  // a URDF angle of -174.2° — a 341° visual jump from SAFE_RIVET's 167°.
  // Adding 2π restores continuity: -174.2°+360°=185.8°, clamped by the URDF
  // renderer to its 180° limit — only 13° from 167°, no jarring spin.
  const pendantInitialPoses = useMemo<TeachPose[]>(() =>
    Object.entries(POSE_LIBRARY_DEG).map(([name, urdfDeg]) => ({
      name,
      joints: urdfDeg.map((d) => THREE.MathUtils.degToRad(d)) as TeachPose['joints'],
    })), []);

  const ghostJointsRad = rpiRunning && telemetry.joint_positions_deg?.length === 6
    ? telemetry.joint_positions_deg.map((d, i) =>
        THREE.MathUtils.degToRad(JOINT_SIGN[i] * d + JOINT_OFFSET_DEG[i]))
    : showPendant
      ? pendantJointsSnapshot
      : ghostSource === 'custom'
        ? controllerDegToUrdfRad(cmdJoints)
        : ghostSource === 'lib2'
          ? (() => {
              const raw = POSE_LIBRARY_DEG[selectedLib2] ?? POSE_LIBRARY_DEG.HOME;
              const rads = controllerDegToUrdfRad(lib2CtrlDeg(selectedLib2));
              // Only correct joints that are just above 180° (≤200°): these wrap to
              // near -180° creating a false 341° jump from poses like SAFE_RIVET at
              // 167°. Poses further above 180° (CAMERA 238°, REJECTED 263°, etc.)
              // looked correct with the plain wrap—they sit consistently on the
              // negative side and should not be shifted.
              return rads.map((rad, i) => (i !== 5 && raw[i] > 180 && raw[i] <= 200) ? rad + 2 * Math.PI : rad);
            })()
          : POSE_LIBRARY_DEG.HOME;
  const ghostLabel = ghostSource === 'custom'
    ? 'PERSONALIZADO'
    : ghostSource === 'lib2'
      ? selectedLib2.replace(/_/g, ' ')
      : selectedLib2.replace(/_/g, ' ');
  // Linear table — independent GPIO hardware, controllable whenever the gateway
  // is reachable (no Remote Control gate).
  const table = telemetry.table;
  const tableAvailable = mode === 'live' && (table?.available ?? false);
  const tableMoving = table?.moving ?? false;
  const tablePos = table?.position ?? 'limit1';

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

      {/* Body: 3D + telemetry side panel */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
        {/* 3D cobot */}
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <Canvas
            shadows
            camera={{ position: [3.4, -2.0, 2.2], fov: 42, near: 0.05, far: 50, up: [0, 0, 1] }}
            style={{ background: '#07111e' }}
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
          >
            <ZUp />
            <ambientLight intensity={0.55} />
            <directionalLight position={[3, 3, 5]} intensity={1.2} castShadow
              shadow-mapSize-width={2048} shadow-mapSize-height={2048}
              shadow-camera-near={0.1} shadow-camera-far={20}
              shadow-camera-left={-3} shadow-camera-right={3}
              shadow-camera-top={3} shadow-camera-bottom={-3} />
            <directionalLight position={[-2, -2, 3]} intensity={0.30} color="#a0c0ff" />
            <OrbitControls
              target={[MESA_CENTRE[0], MESA_CENTRE[1], 1.0]}
              minPolarAngle={0.12} maxPolarAngle={Math.PI / 2.05}
              minDistance={1.0} maxDistance={9}
              enableDamping dampingFactor={0.07} />
            <Grid args={[6, 6]} position={[MESA_CENTRE[0], MESA_CENTRE[1], 0.001]}
              rotation={[-Math.PI / 2, 0, 0]}
              cellSize={0.25} cellThickness={0.4} cellColor="#0f1e30"
              sectionSize={1} sectionThickness={0.8} sectionColor="#162840"
              fadeDistance={8} infiniteGrid={false} />
            {/* Full cell layout — same primitives/heights/offsets as Celda 3D tab */}
            <CellPrimitives
              conveyorOffset={layout.conveyorOffset}
              visionOffset={layout.visionOffset}
              binAcceptOffset={layout.binAcceptOffset}
              binRejectOffset={layout.binRejectOffset}
              mesaOffset={layout.turntableOffset}
              convBase={BASE_CONVEYOR}
              turntableBase={BASE_TURNTABLE}
              visionBase={BASE_VISION}
              binsBase={BASE_BINS}
            />
            {/* Animate the disc angle from the linear-table telemetry. */}
            <TurntableDriver angleRef={turntableAngleRef} telemetryRef={telemetryRef} />
            <Suspense fallback={null}>
              <LiveCobot targetRef={targetJointsRef} tcpWorldRef={tcpWorldRef}
                robotOutRef={pendantRobotRef} groupOutRef={pendantGroupRef} tcpEulerOutRef={pendantTcpEulerRef} />
              {showPendant && (
                <ManualJogger
                  jogCmdRef={pendantJogCmdRef}
                  velocityRef={pendantJogVelocityRef}
                  jointsRef={pendantJointsRef}
                  robotRef={pendantRobotRef}
                  groupRef={pendantGroupRef}
                  manualMovingRef={pendantManualMovingRef}
                  obstacles={[]}
                  poseDirtyRef={pendantPoseDirtyRef}
                  alignCmdRef={pendantAlignCmdRef}
                  realModeRef={pendantRealModeRef}
                />
              )}
              <GhostCobot jointsRad={ghostJointsRad} visible={showGhost} />
              {/* Rotary turntable (URDF) with same offset + riser as Celda 3D */}
              <Turntable angleRef={turntableAngleRef} robotRef={turntableRobotRef}
                offset={layout.turntableOffset} zLift={BASE_TURNTABLE} />
            </Suspense>
            <Html position={[COBOT_BASE[0], COBOT_BASE[1], 1.85]} center>
              <div style={{
                fontSize: 9, color: '#60a5fa', background: 'rgba(6,16,28,0.82)',
                border: '1px solid #60a5fa44', padding: '2px 7px', borderRadius: 4,
                whiteSpace: 'nowrap', fontFamily: 'monospace', pointerEvents: 'none',
              }}>Lexium Cobot {applyToModel ? '· live joints' : '· HOME'}</div>
            </Html>
            <Html position={[0.750 + layout.visionOffset[0], 0.804 + layout.visionOffset[1], 2.0]} center>
              <div style={{
                fontSize: 9, color: '#e879f9', background: 'rgba(6,16,28,0.82)',
                border: '1px solid #e879f944', padding: '2px 7px', borderRadius: 4,
                whiteSpace: 'nowrap', fontFamily: 'monospace', pointerEvents: 'none',
              }}>Cámara Datalogic</div>
            </Html>
          </Canvas>

          {/* Magnet status badge */}
          <div style={{
            position: 'absolute', top: 12, left: 12, display: 'flex', alignItems: 'center', gap: 7,
            fontFamily: SANS_FONT, fontSize: 12, fontWeight: 700,
            padding: '7px 12px', borderRadius: 8,
            color: gripperClosed ? '#06101c' : '#9bb0c8',
            background: gripperClosed ? 'linear-gradient(180deg,#ffd24d 0%,#f0a800 100%)' : 'rgba(20,30,48,0.85)',
            border: `1px solid ${gripperClosed ? '#ffd24d' : '#1d2c44'}`,
            boxShadow: gripperClosed ? '0 0 16px rgba(255,200,60,0.55)' : 'none',
          }}>
            <span style={{ fontSize: 14 }}>🧲</span>
            {gripperClosed ? 'IMÁN ON · agarrando' : 'imán off · suelto'}
          </div>

          {/* model-source toggle */}
          <button onClick={() => setApplyToModel((v) => !v)} style={{
            position: 'absolute', left: 12, bottom: 12, fontFamily: SANS_FONT,
            fontSize: 11, fontWeight: 600, color: '#fff', cursor: 'pointer',
            border: '1px solid #1d2c44', borderRadius: 6, padding: '7px 12px',
            background: applyToModel ? 'linear-gradient(180deg,#3b8bff 0%,#2563eb 100%)' : 'rgba(20,30,48,0.85)',
          }}>
            {applyToModel ? '◉ 3D sigue joints en vivo' : '◯ 3D fijo en HOME'}
          </button>

          {/* ghost-preview toggle */}
          <button onClick={() => setShowGhost((v) => !v)} style={{
            position: 'absolute', left: 12, bottom: 50, fontFamily: SANS_FONT,
            fontSize: 11, fontWeight: 600, color: '#fff', cursor: 'pointer',
            border: '1px solid #1d2c44', borderRadius: 6, padding: '7px 12px',
            background: showGhost ? 'linear-gradient(180deg,#22dd55 0%,#15803d 100%)' : 'rgba(20,30,48,0.85)',
          }}>
            {showGhost ? '◉ Fantasma: ' : '◯ Fantasma: '}{ghostLabel}
          </button>

          {/* Teach Pendant toggle */}
          <button onClick={() => setShowPendant((v) => !v)} style={{
            position: 'absolute', left: 12, bottom: 88, fontFamily: SANS_FONT,
            fontSize: 11, fontWeight: 600, color: '#fff', cursor: 'pointer',
            border: '1px solid #1d2c44', borderRadius: 6, padding: '7px 12px',
            background: showPendant ? 'linear-gradient(180deg,#8b5cf6 0%,#6d28d9 100%)' : 'rgba(20,30,48,0.85)',
          }}>
            {showPendant ? '◉ TEACH PENDANT' : '◯ Teach Pendant'}
          </button>

          {/* TeachPendant overlay — renders as a floating HTML panel */}
          {showPendant && (
            <TeachPendant
              jointsRef={pendantJointsRef}
              gripperWorldRef={tcpWorldRef}
              tcpEulerRef={pendantTcpEulerRef}
              manualMovingRef={pendantManualMovingRef}
              startJointMove={pendantStartJointMove}
              stopMove={pendantStopMove}
              jogCmdRef={pendantJogCmdRef}
              jogVelocityRef={pendantJogVelocityRef}
              onClose={() => setShowPendant(false)}
              initialPoses={pendantInitialPoses}
              realMode={mode === 'live'}
              commandPending={pendantCmdPending}
              previewOnly={mode !== 'live'}
            />
          )}
        </div>

        {/* ══ Floating HMI Operator Panel ══ */}
        {showHmi && (
          <div style={{
            position: 'absolute', left: hmiPos.x, top: hmiPos.y, zIndex: 200,
            borderRadius: 10, boxShadow: '0 8px 40px rgba(0,0,0,0.75)',
            border: '1px solid #1E3A5F', overflow: 'hidden', userSelect: 'none',
          }}>
            <div
              onMouseDown={onHmiDragDown}
              style={{
                background: 'linear-gradient(180deg,#0c1828,#070f1a)',
                padding: '5px 10px', cursor: 'grab',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderBottom: '1px solid #1E3A5F',
              }}
            >
              <span style={{ fontSize: 10, color: '#6FA8FF', letterSpacing: 2, fontWeight: 700 }}>HMI OPERADOR</span>
              <button onClick={() => setShowHmi(false)} style={{
                background: 'none', border: 'none', color: '#5a6c84', cursor: 'pointer',
                fontSize: 18, lineHeight: 1, padding: '0 3px', fontFamily: 'inherit',
              }}>×</button>
            </div>
            <HmiSvgPanel
              hmi={telemetry.hmi}
              pipeline={telemetry.pipeline}
              lastFrameTs={lastFrameTs}
              apiBase={gatewayBase(url)}
              controlEnabled={controlEnabled}
            />
          </div>
        )}

        {/* Telemetry side panel */}
        <div style={{
          width: 320, flexShrink: 0,
          overflowY: 'auto', padding: 14,
          display: 'flex', flexDirection: 'column', gap: 12,
          borderLeft: '1px solid #1d2c44',
          background: 'linear-gradient(180deg,#0c1828 0%,#0a1422 100%)',
        }}>
          {/* Panel tabs */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, flexShrink: 0 }}>
            {(['hmi', 'control'] as const).map((t) => {
              const isActive = t === 'hmi' ? showHmi : true;
              return (
                <button key={t} onClick={() => { if (t === 'hmi') setShowHmi(v => !v); }} style={{
                  fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600, padding: '8px 4px',
                  border: 'none', cursor: 'pointer', letterSpacing: 0.5,
                  background: isActive ? 'linear-gradient(180deg,#1d2c44,#152236)' : 'transparent',
                  color: isActive ? '#f1f5f9' : '#5a6c84',
                  borderBottom: isActive ? '2px solid #22c55e' : '2px solid transparent',
                }}>{t === 'hmi' ? 'HMI' : 'Control'}</button>
              );
            })}
          </div>

          {/* ══ CONTROL TAB ══ */}
          <>

          {/* === Control panel === */}
          <Section title="Control del robot">
            {!controlEnabled && (
              <div style={{
                fontSize: 10, color: '#fbbf24', background: 'rgba(80,60,20,0.3)',
                border: '1px solid #fbbf2433', borderRadius: 4, padding: '6px 8px', marginBottom: 8,
              }}>
                Conéctate al gateway (EN VIVO) para enviar comandos.
              </div>
            )}

            {/* STOP — always reachable while live; also aborts any sequence */}
            <button onClick={handleStop} disabled={!controlEnabled} style={{
              width: '100%', fontFamily: SANS_FONT, fontSize: 14, fontWeight: 800, color: '#fff',
              letterSpacing: 1, cursor: controlEnabled ? 'pointer' : 'not-allowed',
              border: 'none', borderRadius: 6, padding: '12px', marginBottom: 8,
              background: controlEnabled ? 'linear-gradient(180deg,#ef4444 0%,#b91c1c 100%)' : '#3a2530',
              boxShadow: controlEnabled ? '0 0 14px rgba(239,68,68,0.45)' : 'none',
            }}>■ STOP</button>

            {/* Power ON / Power OFF */}
            {(() => {
              const powered = telemetry.status?.power_on ?? false;
              return (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <div style={{ fontSize: 9, color: '#5a6c84', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700 }}>
                      Potencia motores
                    </div>
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: powered ? '#22dd55' : '#475569',
                      boxShadow: powered ? '0 0 6px #22dd55' : 'none',
                    }} />
                    <span style={{ fontSize: 9, color: powered ? '#22dd55' : '#5a6c84', fontFamily: 'monospace', fontWeight: 700 }}>
                      {powered ? 'ON' : 'OFF'}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                    <button onClick={cobotPowerOn} disabled={!controlEnabled || cmdBusy || powered}
                      style={ctrlBtn(!controlEnabled || cmdBusy || powered ? false : true, '#22c55e', '#15803d')}>
                      ⚡ Power ON
                    </button>
                    <button onClick={cobotPowerOff} disabled={!controlEnabled || cmdBusy || !powered}
                      style={ctrlBtn(!controlEnabled || cmdBusy || !powered ? false : true, '#dc2626', '#991b1b')}>
                      ⏻ Power OFF
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* Enable / Disable */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 8 }}>
              <button onClick={cobotEnable} disabled={!controlEnabled || cmdBusy} style={ctrlBtn(controlEnabled, '#22cc55', '#15803d')}>ENABLE</button>
              <button onClick={cobotDisable} disabled={!controlEnabled || cmdBusy} style={ctrlBtn(controlEnabled, '#f47835', '#d96416')}>DISABLE</button>
            </div>

            {/* Magnetic gripper toggle */}
            <button onClick={() => setGripper(!gripperClosed)} disabled={!controlEnabled || cmdBusy} style={{
              width: '100%', fontFamily: SANS_FONT, fontSize: 12, fontWeight: 700,
              cursor: controlEnabled ? 'pointer' : 'not-allowed', border: 'none', borderRadius: 6,
              padding: '10px', marginBottom: 8, opacity: controlEnabled ? 1 : 0.55,
              color: gripperClosed ? '#06101c' : '#fff',
              background: !controlEnabled ? '#2a3548'
                : gripperClosed ? 'linear-gradient(180deg,#ffd24d 0%,#f0a800 100%)'
                : 'linear-gradient(180deg,#475569 0%,#334155 100%)',
            }}>
              🧲 {gripperClosed ? 'IMÁN ON — clic para SOLTAR' : 'IMÁN OFF — clic para AGARRAR'}
            </button>

            {/* Pneumatic gripper — 3-state selector (open / close / off) */}
            <div style={{ fontSize: 9, color: '#5a6c84', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, margin: '2px 0 4px' }}>
              Gripper Neumático
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, marginBottom: 8 }}>
              {([
                { action: 'open',  label: '⊟ Abrir',  c1: '#22cc55', c2: '#15803d' },
                { action: 'close', label: '⊡ Cerrar', c1: '#3b8bff', c2: '#2563eb' },
                { action: 'off',   label: '○ Apagar', c1: '#f47835', c2: '#d96416' },
              ] as const).map(({ action, label, c1, c2 }) => {
                const active = pneuState === action;
                return (
                  <button key={action}
                    onClick={() => setPneumaticGripper(action)}
                    disabled={!controlEnabled || cmdBusy}
                    style={{
                      fontFamily: SANS_FONT, fontSize: 11, fontWeight: 700, color: '#fff',
                      cursor: controlEnabled ? 'pointer' : 'not-allowed',
                      border: active ? '2px solid #fff' : 'none', borderRadius: 6, padding: '8px 4px',
                      opacity: controlEnabled ? 1 : 0.55,
                      boxShadow: active ? `0 0 12px ${c1}88` : 'none',
                      background: !controlEnabled ? '#2a3548'
                        : active ? `linear-gradient(180deg,${c1} 0%,${c2} 100%)`
                        : 'linear-gradient(180deg,#475569 0%,#334155 100%)',
                    }}>
                    {label}
                  </button>
                );
              })}
            </div>

            {/* Camera live feed launcher */}
            <button onClick={openCamera} disabled={!controlEnabled} style={{
              width: '100%', fontFamily: SANS_FONT, fontSize: 12, fontWeight: 700, color: '#fff',
              cursor: controlEnabled ? 'pointer' : 'not-allowed', border: 'none', borderRadius: 6,
              padding: '10px', marginBottom: 8, opacity: controlEnabled ? 1 : 0.55,
              background: controlEnabled ? 'linear-gradient(180deg,#8b5cf6 0%,#6d28d9 100%)' : '#2a3548',
            }}>
              📷 Panel de Cámara
            </button>

            {/* Joint jog sliders — editing any joint previews the pose on the
                green ghost (tagged PERSONALIZADO) before MOVER JOINTS is sent. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '6px 0 4px' }}>
              <span style={{ fontSize: 9, color: '#5a6c84', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700 }}>
                Joints (°, convención robot)
              </span>
              {ghostSource === 'custom' && (
                <span style={{ fontSize: 9, color: '#22dd55', fontWeight: 700, letterSpacing: 1 }}>● PERSONALIZADO</span>
              )}
            </div>
            {cmdJoints.map((v, i) => {
              const editJoint = (nv: number) => {
                const n = [...cmdJoints]; n[i] = nv; setCmdJoints(n);
                setGhostSource('custom'); setShowGhost(true);
              };
              return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#abc', width: 22 }}>J{i + 1}</span>
                <input type="range" min={-JOINT_LIMITS_DEG[i]} max={JOINT_LIMITS_DEG[i]} step={0.5}
                  value={v} disabled={!controlEnabled}
                  onChange={(e) => editJoint(parseFloat(e.target.value))}
                  style={{ flex: 1, accentColor: '#3b8bff' }} />
                <NumField value={v} disabled={!controlEnabled}
                  min={-JOINT_LIMITS_DEG[i]} max={JOINT_LIMITS_DEG[i]} decimals={1} width={56}
                  onChange={editJoint} />
              </div>
              );
            })}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <span style={{ fontSize: 10, color: '#abc' }}>vel %</span>
              <input type="range" min={1} max={100} step={1} value={jointSpeed} disabled={!controlEnabled}
                onChange={(e) => setJointSpeed(parseFloat(e.target.value))} style={{ flex: 1, accentColor: '#22cc55' }} />
              <NumField value={jointSpeed} disabled={!controlEnabled} min={1} max={100} decimals={0} width={44}
                onChange={setJointSpeed} />
            </div>
            <button onClick={moveJoint} disabled={!controlEnabled || cmdBusy} style={{ ...ctrlBtn(controlEnabled, '#3b8bff', '#2563eb'), width: '100%', marginTop: 6 }}>
              ▸ MOVER JOINTS
            </button>

            {/* Cartesian move */}
            <div style={{ fontSize: 9, color: '#5a6c84', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, margin: '10px 0 4px' }}>
              Cartesiano (mm / °)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
              {(['x', 'y', 'z', 'rx', 'ry', 'rz'] as const).map((k) => (
                <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 9, color: '#5a6c84', textTransform: 'uppercase' }}>{k}</span>
                  <NumField value={cart[k]} disabled={!controlEnabled} decimals={2} width="100%"
                    onChange={(nv) => setCart({ ...cart, [k]: nv })} />
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <span style={{ fontSize: 10, color: '#abc' }}>vel mm/s</span>
              <input type="range" min={1} max={500} step={1} value={cartSpeed} disabled={!controlEnabled}
                onChange={(e) => setCartSpeed(parseFloat(e.target.value))} style={{ flex: 1, accentColor: '#22cc55' }} />
              <NumField value={cartSpeed} disabled={!controlEnabled} min={1} max={500} decimals={0} width={44}
                onChange={setCartSpeed} />
            </div>
            <button onClick={moveCartesian} disabled={!controlEnabled || cmdBusy} style={{ ...ctrlBtn(controlEnabled, '#3b8bff', '#2563eb'), width: '100%', marginTop: 6 }}>
              ▸ MOVER LINEAL
            </button>

            <button onClick={syncCmdFromLive} disabled={!controlEnabled} style={{
              width: '100%', marginTop: 6, fontFamily: SANS_FONT, fontSize: 10, fontWeight: 600,
              color: '#9bb0c8', cursor: controlEnabled ? 'pointer' : 'not-allowed',
              border: '1px solid #1d2c44', borderRadius: 6, padding: '6px', background: 'rgba(20,30,48,0.6)',
            }}>↺ Sincronizar con pose actual</button>

            {cmdStatus && (
              <div style={{
                marginTop: 8, padding: '7px 9px', borderRadius: 4, fontSize: 10, lineHeight: 1.4,
                fontFamily: 'monospace',
                color: cmdStatus.ok ? '#22dd55' : '#ff8a98',
                background: cmdStatus.ok ? 'rgba(20,60,30,0.4)' : 'rgba(80,20,20,0.4)',
                border: `1px solid ${cmdStatus.ok ? '#22dd5544' : '#ff556644'}`,
              }}>
                {cmdStatus.ok ? '✓ ' : '⚠ '}{cmdStatus.msg}
              </div>
            )}
          </Section>

          {/* === Second pose library (teammate, controller-convention) === */}
          <Section title="Poses (librería 2)">
            <select value={selectedLib2}
              onChange={(e) => { setSelectedLib2(e.target.value); setSaveName(e.target.value); setGhostSource('lib2'); }}
              style={{ ...numInput, width: '100%', textAlign: 'left', cursor: 'pointer' }}>
              {Object.keys(POSE_LIBRARY_DEG).map((name) => (
                <option key={name} value={name}>{hasOverride(name) ? '✎ ' : ''}{name.replace(/_/g, ' ')}</option>
              ))}
            </select>

            {/* Joint preview (wrapped + transformed) */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '8px 0 4px' }}>
              <span style={{ fontSize: 9, color: '#5a6c84', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700 }}>
                Joints a enviar (°, robot)
              </span>
              {hasOverride(selectedLib2) && (
                <span style={{ fontSize: 9, color: '#22dd55', fontWeight: 700, letterSpacing: 1 }}>✎ AJUSTADA</span>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 3, fontSize: 10, fontFamily: 'monospace' }}>
              {lib2CtrlDeg(selectedLib2).map((d, i) => {
                return (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', background: '#0a1422', border: '1px solid #1d2c44', borderRadius: 4, padding: '3px 5px' }}>
                    <span style={{ color: '#5a6c84' }}>J{i + 1}</span>
                    <span style={{ color: '#dde4f0' }}>{d.toFixed(1)}</span>
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 8 }}>
              <button onClick={() => { setCmdJoints(lib2CtrlDeg(selectedLib2)); setGhostSource('custom'); setShowGhost(true); }}
                disabled={!controlEnabled}
                style={ctrlBtn(controlEnabled, '#475569', '#334155')}>↧ Cargar en sliders</button>
              <button onClick={sendLib2ToRobot} disabled={!controlEnabled || cmdBusy}
                style={ctrlBtn(controlEnabled, '#8b5cf6', '#6d28d9')}>▸ Enviar al robot</button>
            </div>

            {/* ── Cartesian tuner ── */}
            <div style={{ borderTop: '1px solid #1d2c44', marginTop: 10, paddingTop: 8 }}>
              <div style={{ fontSize: 9, color: '#5a6c84', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, marginBottom: 6 }}>
                Tuner cartesiano (TCP real)
              </div>

              {/* Live TCP readout */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 3, fontSize: 9, fontFamily: 'monospace', marginBottom: 8 }}>
                {([
                  ['X', telemetry.tcp_position.x_mm, 'mm'], ['Y', telemetry.tcp_position.y_mm, 'mm'], ['Z', telemetry.tcp_position.z_mm, 'mm'],
                  ['RX', telemetry.tcp_position.rx_deg, '°'], ['RY', telemetry.tcp_position.ry_deg, '°'], ['RZ', telemetry.tcp_position.rz_deg, '°'],
                ] as const).map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', background: '#0a1422', border: '1px solid #1d2c44', borderRadius: 4, padding: '3px 5px' }}>
                    <span style={{ color: '#5a6c84' }}>{k}</span>
                    <span style={{ color: '#9bf' }}>{v.toFixed(1)}</span>
                  </div>
                ))}
              </div>

              {/* Step sizes */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <span style={{ fontSize: 10, color: '#abc' }}>paso</span>
                <NumField value={tunerStepMm} disabled={!controlEnabled} min={0.5} max={100} decimals={1} width={50}
                  onChange={setTunerStepMm} />
                <span style={{ fontSize: 10, color: '#5a6c84' }}>mm</span>
                <NumField value={tunerStepDeg} disabled={!controlEnabled} min={0.5} max={30} decimals={1} width={50}
                  onChange={setTunerStepDeg} />
                <span style={{ fontSize: 10, color: '#5a6c84' }}>°</span>
              </div>

              {/* Nudge buttons per axis */}
              {([
                { axis: 'x',  label: 'X', unit: 'mm' }, { axis: 'y', label: 'Y', unit: 'mm' }, { axis: 'z', label: 'Z', unit: 'mm' },
                { axis: 'rx', label: 'RX', unit: '°' }, { axis: 'ry', label: 'RY', unit: '°' }, { axis: 'rz', label: 'RZ', unit: '°' },
              ] as const).map(({ axis, label }) => (
                <div key={axis} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#abc', width: 26 }}>{label}</span>
                  <button onClick={() => nudgeTcp(axis, -1)} disabled={!controlEnabled || cmdBusy}
                    style={{ ...ctrlBtn(controlEnabled, '#475569', '#334155'), flex: 1, padding: '7px 4px', fontSize: 13 }}>−</button>
                  <button onClick={() => nudgeTcp(axis, +1)} disabled={!controlEnabled || cmdBusy}
                    style={{ ...ctrlBtn(controlEnabled, '#3b8bff', '#2563eb'), flex: 1, padding: '7px 4px', fontSize: 13 }}>+</button>
                </div>
              ))}

              {/* Save as pose */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8 }}>
                <select value={saveName} onChange={(e) => setSaveName(e.target.value)}
                  style={{ ...numInput, flex: 1, textAlign: 'left', cursor: 'pointer' }}>
                  {Object.keys(POSE_LIBRARY_DEG).map((name) => (
                    <option key={name} value={name}>{name.replace(/_/g, ' ')}</option>
                  ))}
                </select>
                <button onClick={() => saveLib2Pose(saveName)} disabled={!controlEnabled}
                  style={{ ...ctrlBtn(controlEnabled, '#22cc55', '#15803d'), padding: '8px 10px', whiteSpace: 'nowrap' }}>
                  💾 Guardar
                </button>
              </div>
              {hasOverride(selectedLib2) && (
                <button onClick={() => deleteLib2Override(selectedLib2)}
                  style={{ width: '100%', marginTop: 4, fontFamily: SANS_FONT, fontSize: 10, fontWeight: 600,
                    color: '#ff8a98', cursor: 'pointer', border: '1px solid #ff556644', borderRadius: 6,
                    padding: '6px', background: 'rgba(80,20,20,0.3)' }}>
                  ↺ Restaurar "{selectedLib2.replace(/_/g, ' ')}" original
                </button>
              )}
            </div>

            <div style={{ fontSize: 9, color: '#5a6c84', marginTop: 8, lineHeight: 1.4 }}>
              Poses de la simulación (wrap ±180 → transform V26). El tuner mueve
              por eje cartesiano (vel {cartSpeed} mm/s) y "Guardar" fija los joints
              actuales como la pose elegida. STOP aborta.
            </div>
          </Section>

          {/* === Linear table control === */}
          <Section title="Mesa lineal">
            {!tableAvailable && (
              <div style={{
                fontSize: 10, color: '#fbbf24', background: 'rgba(80,60,20,0.3)',
                border: '1px solid #fbbf2433', borderRadius: 4, padding: '6px 8px', marginBottom: 8,
              }}>
                {mode === 'live' ? 'Mesa no disponible en el gateway.' : 'Conéctate al gateway (EN VIVO) para controlar la mesa.'}
              </div>
            )}

            {/* Position bar with animated carriage + limit-switch lamps */}
            {(() => {
              const frac = tableMoving ? 0.5 : tablePos === 'limit1' ? 0 : tablePos === 'limit2' ? 1 : 0.5;
              const lamp = (touched: boolean) => ({
                width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
                background: touched ? '#22dd55' : '#2a3548',
                boxShadow: touched ? '0 0 10px #22dd55' : 'none',
                border: `1px solid ${touched ? '#22dd55' : '#1d2c44'}`,
                transition: 'all 0.2s',
              });
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 10px' }}>
                  <div style={lamp(table?.limit1_touched ?? false)} title="Límite 1" />
                  <div style={{ flex: 1, position: 'relative', height: 10, background: '#0a1422', border: '1px solid #1d2c44', borderRadius: 5 }}>
                    {/* carriage */}
                    <div style={{
                      position: 'absolute', top: '50%', left: `${frac * 100}%`,
                      transform: 'translate(-50%,-50%)',
                      width: 18, height: 18, borderRadius: 4,
                      background: tableMoving
                        ? 'linear-gradient(180deg,#fbbf24,#d97706)'
                        : 'linear-gradient(180deg,#3b8bff,#2563eb)',
                      boxShadow: tableMoving ? '0 0 10px rgba(251,191,36,0.6)' : '0 0 8px rgba(59,139,255,0.5)',
                      transition: 'left 2.5s ease-in-out',
                    }} />
                  </div>
                  <div style={lamp(table?.limit2_touched ?? false)} title="Límite 2" />
                </div>
              );
            })()}

            {/* Move buttons + STOP */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
              <button
                onClick={() => tableMove('limit1')}
                disabled={!tableAvailable || tableMoving || tablePos === 'limit1'}
                style={{
                  ...ctrlBtn(tableAvailable && !tableMoving && tablePos !== 'limit1', '#3b8bff', '#2563eb'),
                  padding: '12px 6px', fontSize: 12,
                }}>
                ← LÍMITE 1
              </button>
              <button
                onClick={() => tableMove('limit2')}
                disabled={!tableAvailable || tableMoving || tablePos === 'limit2'}
                style={{
                  ...ctrlBtn(tableAvailable && !tableMoving && tablePos !== 'limit2', '#3b8bff', '#2563eb'),
                  padding: '12px 6px', fontSize: 12,
                }}>
                LÍMITE 2 →
              </button>
            </div>
            <button
              onClick={tableStop}
              disabled={!tableAvailable}
              style={{
                width: '100%', marginTop: 4, fontFamily: SANS_FONT, fontSize: 12, fontWeight: 800,
                color: '#fff', letterSpacing: 1, cursor: tableAvailable ? 'pointer' : 'not-allowed',
                border: 'none', borderRadius: 6, padding: '9px',
                background: tableAvailable ? 'linear-gradient(180deg,#ef4444 0%,#b91c1c 100%)' : '#3a2530',
              }}>
              ■ STOP MESA
            </button>

            <div style={{ ...statRow, marginTop: 8 }}>
              <span>posición</span>
              <span style={{ color: tableMoving ? '#fbbf24' : '#22dd55', fontWeight: 700 }}>
                {tableMoving ? '⟳ moviendo…' : tablePos === 'limit1' ? '◄ Límite 1' : tablePos === 'limit2' ? 'Límite 2 ►' : '— centro'}
              </span>
            </div>
          </Section>

          {/* === Sensors + conveyor belt === */}
          <Section title="Sensores y banda">
            {/* Live photoelectric sensor LEDs (read-only from the WS stream) */}
            {([
              { label: 'Sensor Conveyor',  on: sensorConveyor },
              { label: 'Sensor Visión',    on: sensorVision },
              { label: 'Fixture A (CAFI)', on: fixtureA },
              { label: 'Fixture B (CAFI)', on: fixtureB },
            ] as const).map(({ label, on }) => (
              <div key={label} style={{ ...statRow, alignItems: 'center' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
                    background: on ? '#22dd55' : '#2a3548',
                    boxShadow: on ? '0 0 10px #22dd55' : 'none',
                    border: `1px solid ${on ? '#22dd55' : '#1d2c44'}`,
                    transition: 'all 0.12s',
                  }} />
                  {label}
                </span>
                <span style={{ color: on ? '#22dd55' : '#788090', fontWeight: 700 }}>
                  {on ? 'DETECTA' : '— libre'}
                </span>
              </div>
            ))}

            {/* Conveyor motor toggle (same pattern as the grippers) */}
            <button onClick={() => setConveyorMotor(!conveyorOn)} disabled={!controlEnabled || cmdBusy} style={{
              width: '100%', marginTop: 8, fontFamily: SANS_FONT, fontSize: 12, fontWeight: 700,
              cursor: controlEnabled ? 'pointer' : 'not-allowed', border: 'none', borderRadius: 6,
              padding: '10px', opacity: controlEnabled ? 1 : 0.55,
              color: conveyorOn ? '#06101c' : '#fff',
              background: !controlEnabled ? '#2a3548'
                : conveyorOn ? 'linear-gradient(180deg,#22dd55 0%,#15803d 100%)'
                : 'linear-gradient(180deg,#475569 0%,#334155 100%)',
            }}>
              ⥁ {conveyorOn ? 'MOTOR ON — clic para APAGAR' : 'MOTOR OFF — clic para ENCENDER'}
            </button>

            {/* Auto-stop on sensor detection */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 10, color: '#abc', cursor: 'pointer' }}>
              <input type="checkbox" checked={autoStopConveyor} onChange={(e) => setAutoStopConveyor(e.target.checked)} style={{ accentColor: '#22cc55' }} />
              Auto-detener al detectar objeto en el sensor
            </label>
          </Section>

          <Section title="Estado del robot">
            <Flag label="Power ON" on={s.power_on} />
            <Flag label="Robot enabled" on={s.robot_enabled} />
            <Flag label="In position" on={s.inpos} />
            <Flag label="Protective stop" on={s.protective_stop} goodWhenOn={false} />
            <Flag label="Emergency stop" on={s.emergency_stop} goodWhenOn={false} />
            <Flag label="Soft limit" on={s.on_soft_limit} goodWhenOn={false} />
            <div style={statRow}><span>Motion mode</span><span style={{ color: '#9bf' }}>{s.motion_mode_name}</span></div>
            <div style={statRow}><span>Error code</span><span style={{ color: '#fbbf24' }}>{s.motion_errcode}</span></div>
            <div style={statRow}>
              <span>Gripper (imán)</span>
              <span style={{ color: gripperClosed ? '#ffd24d' : '#788090', fontWeight: 700 }}>
                {gripperClosed ? 'ON · agarrando' : 'OFF · suelto'}
              </span>
            </div>
            <div style={statRow}>
              <span>Gripper neumático</span>
              <span style={{
                color: pneuState === 'open' ? '#22dd55' : pneuState === 'close' ? '#3b8bff' : '#788090',
                fontWeight: 700,
              }}>
                {pneuState === 'open' ? 'ABIERTO' : pneuState === 'close' ? 'CERRADO' : 'OFF · mantiene'}
              </span>
            </div>
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
          </>  {/* end control tab */}
        </div>
      </div>

      {/* === Camera live-feed modal === */}
      {cameraOpen && (
        <div
          onClick={() => setCameraOpen(false)}
          style={{
            position: 'absolute', inset: 0, zIndex: 50,
            background: 'rgba(4,10,18,0.86)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(680px, 96vw)', maxHeight: '94vh', overflowY: 'auto',
              background: 'linear-gradient(180deg,#0c1828 0%,#0a1422 100%)',
              border: '1px solid #1d2c44', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            }}>
            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 18px', borderBottom: '1px solid #1a2c44',
              background: 'linear-gradient(90deg,#0c1a2c,#071420)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#8b5cf6', boxShadow: '0 0 8px #8b5cf6' }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9' }}>Panel de Cámara · Datalogic P15</span>
              </div>
              <button onClick={() => setCameraOpen(false)} style={{
                fontFamily: SANS_FONT, fontSize: 13, fontWeight: 700, color: '#9bb0c8',
                background: 'transparent', border: 'none', cursor: 'pointer', padding: 4,
              }}>✕</button>
            </div>

            {/* Body */}
            <div style={{ padding: 18 }}>
              {/* ── Shutter control ── */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <span style={{ fontSize: 9, color: '#5a6c84', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700 }}>
                  Obturación (µs)
                </span>
                <span style={{ fontSize: 10, fontFamily: 'monospace', color: appliedShutter != null ? '#22dd55' : '#5a6c84' }}>
                  {appliedShutter != null ? `aplicado: ${appliedShutter.toLocaleString()}` : 'sin aplicar'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <input type="range" min={8000} max={300000} step={1000} value={shutterUs} disabled={cameraLoading}
                  onChange={(e) => setShutterUs(parseInt(e.target.value))}
                  style={{ flex: 1, accentColor: '#8b5cf6' }} />
                <NumField value={shutterUs} disabled={cameraLoading} min={8000} max={300000} decimals={0} width={66}
                  onChange={(v) => setShutterUs(Math.round(v))} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, marginBottom: 8 }}>
                {([
                  { us: 8000,   label: 'Oscuro 8k' },
                  { us: 100000, label: 'Medio 100k' },
                  { us: 200000, label: 'Brillante 200k' },
                ] as const).map(({ us, label }) => (
                  <button key={us} onClick={() => setShutterUs(us)} disabled={cameraLoading} style={{
                    fontFamily: SANS_FONT, fontSize: 10, fontWeight: 600, color: '#fff',
                    cursor: cameraLoading ? 'wait' : 'pointer',
                    border: shutterUs === us ? '2px solid #fff' : '1px solid #1d2c44', borderRadius: 6, padding: '6px 4px',
                    background: shutterUs === us ? 'linear-gradient(180deg,#8b5cf6 0%,#6d28d9 100%)' : 'rgba(20,30,48,0.7)',
                  }}>{label}</button>
                ))}
              </div>
              <button onClick={applyShutter} disabled={cameraLoading} style={{
                width: '100%', marginBottom: 14, fontFamily: SANS_FONT, fontSize: 12, fontWeight: 700, color: '#fff',
                cursor: cameraLoading ? 'wait' : 'pointer', border: 'none', borderRadius: 6, padding: '9px',
                background: cameraLoading ? 'linear-gradient(180deg,#3a4f6a,#2a3548)' : 'linear-gradient(180deg,#6d28d9 0%,#4c1d95 100%)',
              }}>
                ⚙ Aplicar obturación
              </button>

              {/* ── Action buttons ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 14 }}>
                <button onClick={fetchCameraFeed} disabled={cameraLoading} style={{
                  fontFamily: SANS_FONT, fontSize: 12, fontWeight: 700, color: '#fff',
                  cursor: cameraLoading ? 'wait' : 'pointer', border: 'none', borderRadius: 8, padding: '11px 6px',
                  background: cameraLoading ? 'linear-gradient(180deg,#3a4f6a,#2a3548)' : 'linear-gradient(180deg,#8b5cf6 0%,#6d28d9 100%)',
                }}>📷 Live Feed (5s)</button>
                <button onClick={runInspection} disabled={cameraLoading} style={{
                  fontFamily: SANS_FONT, fontSize: 12, fontWeight: 700, color: '#fff',
                  cursor: cameraLoading ? 'wait' : 'pointer', border: 'none', borderRadius: 8, padding: '11px 6px',
                  background: cameraLoading ? 'linear-gradient(180deg,#3a4f6a,#2a3548)' : 'linear-gradient(180deg,#3b8bff 0%,#2563eb 100%)',
                }}>🔍 Inspección</button>
              </div>

              {/* ── Verdict banner (inspection only) ── */}
              {camView === 'inspect' && inspectResult && !cameraLoading && !cameraError && (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                  padding: '12px', borderRadius: 8, marginBottom: 12, fontSize: 18, fontWeight: 800,
                  color: inspectResult.verdict === 'PASS' ? '#06101c' : '#fff',
                  background: inspectResult.verdict === 'PASS'
                    ? 'linear-gradient(180deg,#22dd55,#15803d)'
                    : 'linear-gradient(180deg,#ef4444,#b91c1c)',
                }}>
                  {inspectResult.verdict === 'PASS' ? '🟢' : '🔴'} {inspectResult.verdict} {inspectResult.holes_found}/{inspectResult.holes_expected}
                  {!inspectResult.cafi_detected && (
                    <span style={{ fontSize: 12, fontWeight: 600 }}>· CAFI no detectado</span>
                  )}
                </div>
              )}

              {/* ── Viewport ── */}
              <div style={{
                position: 'relative', width: '100%', aspectRatio: camView === 'inspect' ? '1280 / 1024' : '640 / 512',
                background: '#05080f', border: '1px solid #1a2c44', borderRadius: 8,
                overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {cameraLoading ? (
                  <div style={{ textAlign: 'center', color: '#8b5cf6' }}>
                    <div style={{
                      width: 44, height: 44, margin: '0 auto 12px',
                      border: '4px solid #1d2c44', borderTopColor: '#8b5cf6', borderRadius: '50%',
                      animation: 'cam-spin 0.9s linear infinite',
                    }} />
                    <div style={{ fontSize: 12, color: '#9bb0c8' }}>{cameraBusyLabel || 'Procesando…'} (~6 s)</div>
                  </div>
                ) : cameraError ? (
                  <div style={{ textAlign: 'center', padding: 24 }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
                    <div style={{ fontSize: 13, color: '#ff8a98', lineHeight: 1.5, maxWidth: 360 }}>{cameraError}</div>
                  </div>
                ) : camView === 'inspect' && inspectResult && !inspectResult.cafi_detected ? (
                  <div style={{ textAlign: 'center', padding: 24 }}>
                    <div style={{ fontSize: 30, marginBottom: 10 }}>🔍</div>
                    <div style={{ fontSize: 13, color: '#9bb0c8', lineHeight: 1.5, maxWidth: 320 }}>
                      No se detectó ningún CAFI en el fixture.<br/>Coloca la pieza y vuelve a inspeccionar.
                    </div>
                  </div>
                ) : camView === 'inspect' && inspectImgUrl ? (
                  <img src={inspectImgUrl} alt="Inspección anotada CAFI"
                    style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
                ) : camView === 'feed' && cameraGifUrl ? (
                  <img src={cameraGifUrl} alt="Live feed cámara Datalogic"
                    style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
                ) : (
                  <div style={{ fontSize: 12, color: '#5a6c84', textAlign: 'center', padding: 24 }}>
                    Usa <b style={{ color: '#8b5cf6' }}>Live Feed</b> o <b style={{ color: '#3b8bff' }}>Inspección</b> para empezar.
                  </div>
                )}
              </div>

              {/* ── Hole list (inspection only) ── */}
              {camView === 'inspect' && inspectResult && inspectResult.holes.length > 0 && !cameraLoading && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 9, color: '#5a6c84', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, marginBottom: 6 }}>
                    Huecos del CAFI
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                    {inspectResult.holes.map((h) => (
                      <div key={h.label} style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', borderRadius: 6,
                        background: 'rgba(20,30,48,0.6)', border: `1px solid ${h.found ? '#22dd5544' : '#ff556644'}`,
                      }}>
                        <span style={{ fontSize: 14, color: h.found ? '#22dd55' : '#ff5566', fontWeight: 800 }}>
                          {h.found ? '✓' : '✗'}
                        </span>
                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#dde4f0' }}>{h.label}</span>
                          <span style={{ fontSize: 9, color: '#788090', whiteSpace: 'nowrap' }}>{h.name}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ fontSize: 9, color: '#5a6c84', marginTop: 12, textAlign: 'center', lineHeight: 1.4 }}>
                Datalogic P15 · 1280×1024 grayscale · una operación a la vez (~3–6 s c/u).
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

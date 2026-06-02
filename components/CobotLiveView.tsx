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
import { POSE_LIB_V26, COBOT_BASE, TURNTABLE_BASE, MESA_CENTRE, Turntable, MesaTable } from './CellViewer3D';

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
// Used for the live display, the inverse pose-send, and (via raw POSE_LIB_V26)
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

// Faithful pick→rivet→vision→accept-bin cycle (accept branch), mirroring the
// simulation's SEQUENCE incl. the double vision pass and HOME traversals.
// `grip` fires the magnet AFTER arriving at that pose: grab = magnet ON,
// release = magnet OFF — same points the sim opens/closes the gripper.
type TrajStep = { pose: string; grip?: 'grab' | 'release' };
const TRAJECTORY: TrajStep[] = [
  { pose: 'POSE_HOME', grip: 'release' },          // start clean (not holding)
  { pose: 'POSE_APPROACH_CONVEYOR' },
  { pose: 'POSE_PICK_CONVEYOR', grip: 'grab' },     // pick raw part
  { pose: 'POSE_LIFT_CONVEYOR' },
  { pose: 'POSE_APPROACH_LOAD_FIXTURE' },
  { pose: 'POSE_PLACE_LOAD_FIXTURE' },
  { pose: 'POSE_RELEASE_LOAD_FIXTURE', grip: 'release' }, // drop on rivet fixture
  { pose: 'POSE_RETREAT_LOAD_FIXTURE' },
  { pose: 'POSE_APPROACH_PICK_RIVETED' },
  { pose: 'POSE_PICK_RIVETED', grip: 'grab' },      // pick riveted part
  { pose: 'POSE_LIFT_RIVETED' },
  { pose: 'POSE_APPROACH_VISION' },
  { pose: 'POSE_PLACE_VISION' },
  { pose: 'POSE_RELEASE_VISION', grip: 'release' }, // drop on vision plate
  { pose: 'POSE_RETREAT_VISION' },
  { pose: 'POSE_HOME' },                            // wait for inspection
  { pose: 'POSE_APPROACH_VISION' },
  { pose: 'POSE_PLACE_VISION', grip: 'grab' },      // pick back from vision
  { pose: 'POSE_RETREAT_VISION' },
  { pose: 'POSE_HOME' },                            // traverse via HOME
  { pose: 'POSE_APPROACH_ACCEPT_BIN' },
  { pose: 'POSE_DROP_ACCEPT_BIN', grip: 'release' }, // drop in accept bin
  { pose: 'POSE_APPROACH_ACCEPT_BIN' },
  { pose: 'POSE_HOME' },
];

// Inverse of the live display map (controller_deg → urdf via sign·ctrl+offset):
// given a simulation pose in URDF radians, recover the controller-convention
// joint degrees to command the real robot.  ctrl = sign·(urdf_deg − offset),
// valid because sign ∈ {+1,−1} so 1/sign = sign.
function urdfPoseToControllerDeg(poseRad: number[]): number[] {
  return poseRad.map((rad, i) => {
    const urdfDeg = THREE.MathUtils.radToDeg(rad);
    return JOINT_SIGN[i] * (urdfDeg - JOINT_OFFSET_DEG[i]);
  });
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
  const [applyToModel, setApplyToModel] = useState(false);
  const [connErr, setConnErr] = useState<string | null>(null);

  // ── Control state ──────────────────────────────────────────────────────
  const [cmdJoints, setCmdJoints] = useState<number[]>([...DEMO_TELEMETRY.joint_positions_deg]);
  const [jointSpeed, setJointSpeed] = useState(15);
  const [cart, setCart] = useState({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 });
  const [cartSpeed, setCartSpeed] = useState(20);
  const [cmdBusy, setCmdBusy] = useState(false);
  const [cmdStatus, setCmdStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const cmdInitRef = useRef(false); // seed command inputs from first live telemetry
  const [selectedPose, setSelectedPose] = useState<string>('POSE_HOME');
  const [showGhost, setShowGhost] = useState(true);
  // Sequence player. Ghost mode = visualisation only; Real mode = drives the
  // physical cobot pose-by-pose, waiting for each arrival before advancing.
  const [seqPlaying, setSeqPlaying] = useState(false);
  const [seqIsReal, setSeqIsReal] = useState(false);
  const [seqStep, setSeqStep] = useState(0);
  const [seqStepMs, setSeqStepMs] = useState(1800);
  const [seqLoop, setSeqLoop] = useState(true);
  const seqTimerRef = useRef<number | null>(null);
  const seqAbortRef = useRef(false);
  const seqLoopRef = useRef(seqLoop);
  seqLoopRef.current = seqLoop;

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
  const cobotEnable = () => postControl('/api/cobot/enable');
  const cobotDisable = () => postControl('/api/cobot/disable');
  // Magnetic gripper: closed=true energises the magnet (grab), false releases.
  const setGripper = (closed: boolean) => postControl('/api/cobot/gripper', { closed });

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

  // Simulation pose (URDF rad) → controller-convention joint degrees.
  const selectedPoseCtrlDeg = (): number[] =>
    urdfPoseToControllerDeg(POSE_LIB_V26[selectedPose] ?? POSE_LIB_V26.POSE_HOME);
  // Load the converted pose into the jog sliders so the operator can review
  // the exact joint values before sending.
  const loadPoseToSliders = () => setCmdJoints(selectedPoseCtrlDeg());
  // Send the converted pose straight to the real robot.
  const sendPoseToRobot = () =>
    postControl('/api/cobot/move/joint', { joints: selectedPoseCtrlDeg(), speed: jointSpeed, relative: false });

  // Stop whichever player is running (ghost timer and/or the real-robot loop).
  const stopSequence = () => {
    seqAbortRef.current = true;
    if (seqTimerRef.current) { window.clearInterval(seqTimerRef.current); seqTimerRef.current = null; }
    setSeqPlaying(false);
    setSeqIsReal(false);
  };

  // Ghost-only player: step selectedPose through the cycle on a timer; the
  // ghost eases between poses so it looks like the cobot running the routine.
  const playSequence = () => {
    stopSequence();
    seqAbortRef.current = false;
    setShowGhost(true);
    setSeqIsReal(false);
    let i = 0;
    setSelectedPose(TRAJECTORY[0].pose);
    setSeqStep(0);
    setSeqPlaying(true);
    seqTimerRef.current = window.setInterval(() => {
      i += 1;
      if (i >= TRAJECTORY.length) {
        if (seqLoopRef.current) { i = 0; } else { stopSequence(); return; }
      }
      setSelectedPose(TRAJECTORY[i].pose);
      setSeqStep(i);
    }, seqStepMs);
  };

  // Smallest angular difference in degrees (handles ±180/±360 wrap).
  const angDiffDeg = (a: number, b: number) => {
    let d = (a - b) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return Math.abs(d);
  };
  const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
  // Poll telemetry until every joint is within tol of the target (controller
  // deg), or until timeout / abort.  Resolves true on arrival.
  const waitForArrival = (targetCtrl: number[], tolDeg: number, timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      const start = Date.now();
      const id = window.setInterval(() => {
        if (seqAbortRef.current) { window.clearInterval(id); resolve(false); return; }
        const jp = telemetryRef.current.joint_positions_deg;
        if (jp && jp.length === 6) {
          let max = 0;
          for (let i = 0; i < 6; i++) max = Math.max(max, angDiffDeg(jp[i], targetCtrl[i]));
          if (max <= tolDeg) { window.clearInterval(id); resolve(true); return; }
        }
        if (Date.now() - start > timeoutMs) { window.clearInterval(id); resolve(false); return; }
      }, 120);
    });

  // Real-robot sequence: command each pose, wait for the cobot to physically
  // arrive (ghost holds the target meanwhile), then advance.  Moves the
  // PHYSICAL robot through the whole cycle.
  const playRealSequence = async () => {
    if (!controlEnabled) return;
    if (!window.confirm('Esto moverá el ROBOT REAL por todo el ciclo de poses (vel ' + jointSpeed + '%). El STOP lo aborta. ¿Continuar?')) return;
    stopSequence();
    seqAbortRef.current = false;
    setShowGhost(true);
    setApplyToModel(true);
    setSeqIsReal(true);
    setSeqPlaying(true);
    try {
      let i = 0;
      while (!seqAbortRef.current) {
        const step = TRAJECTORY[i];
        setSelectedPose(step.pose);
        setSeqStep(i);
        const targetCtrl = urdfPoseToControllerDeg(POSE_LIB_V26[step.pose]);
        const res = await postControl('/api/cobot/move/joint', { joints: targetCtrl, speed: jointSpeed, relative: false });
        if (!res.ok || seqAbortRef.current) break;
        const arrived = await waitForArrival(targetCtrl, 2.0, 25000);
        if (seqAbortRef.current) break;
        if (!arrived) { setCmdStatus({ ok: false, msg: `Timeout esperando llegada a ${step.pose.replace('POSE_', '')}.` }); break; }
        // Gripper action at this pose (same points as the simulation).
        if (step.grip) {
          const gr = await postControl('/api/cobot/gripper', { closed: step.grip === 'grab' });
          if (!gr.ok || seqAbortRef.current) break;
          await sleep(700); // let the magnet energise/release
        }
        await sleep(400);
        i += 1;
        if (i >= TRAJECTORY.length) { if (seqLoopRef.current) i = 0; else break; }
      }
    } finally {
      setSeqPlaying(false);
      setSeqIsReal(false);
    }
  };

  // STOP: abort any running sequence AND command the robot to halt.
  const handleStop = () => { stopSequence(); cobotStop(); };

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
    if (seqTimerRef.current) window.clearInterval(seqTimerRef.current);
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

      {/* Body: 3D + telemetry */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* 3D cobot */}
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <Canvas
            shadows
            camera={{ position: [MESA_CENTRE[0] + 1.6, MESA_CENTRE[1] - 1.7, 1.9], fov: 42, near: 0.05, far: 50, up: [0, 0, 1] }}
            style={{ background: '#07111e' }}
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
          >
            <ZUp />
            <ambientLight intensity={0.6} />
            <directionalLight position={[3, 3, 5]} intensity={1.2} castShadow
              shadow-mapSize-width={2048} shadow-mapSize-height={2048} />
            <directionalLight position={[-2, -2, 3]} intensity={0.3} color="#a0c0ff" />
            <OrbitControls target={[MESA_CENTRE[0], MESA_CENTRE[1], 1.1]} enableDamping dampingFactor={0.08}
              minDistance={1.0} maxDistance={8} maxPolarAngle={Math.PI / 2.02} />
            <Grid args={[6, 6]} position={[MESA_CENTRE[0], MESA_CENTRE[1], 0.001]} rotation={[-Math.PI / 2, 0, 0]}
              cellSize={0.25} cellThickness={0.4} cellColor="#0f1e30"
              sectionSize={1} sectionThickness={0.8} sectionColor="#162840"
              fadeDistance={9} infiniteGrid={false} />
            {/* Station mesa (worktop + legs) so the cobot and turntable sit on
                the real cell furniture, in their true relative positions. */}
            <MesaTable cx={MESA_CENTRE[0]} cy={MESA_CENTRE[1]} sx={1.620} sy={0.920}
              topZ={1.000} thickness={0.040} legSect={0.060} legInset={0.060} />
            <Suspense fallback={null}>
              <LiveCobot targetRef={targetJointsRef} tcpWorldRef={tcpWorldRef} />
              <GhostCobot jointsRad={POSE_LIB_V26[selectedPose] ?? POSE_LIB_V26.POSE_HOME} visible={showGhost} />
              {/* Rotary turntable (URDF) in its real relative position. Static
                  disc for now (angle 0) — telemetry-driven rotation TBD. */}
              <Turntable angleRef={turntableAngleRef} robotRef={turntableRobotRef} />
            </Suspense>
            <Html position={[COBOT_BASE[0], COBOT_BASE[1], 1.85]} center>
              <div style={{
                fontSize: 9, color: '#60a5fa', background: 'rgba(6,16,28,0.82)',
                border: '1px solid #60a5fa44', padding: '2px 7px', borderRadius: 4,
                whiteSpace: 'nowrap', fontFamily: 'monospace', pointerEvents: 'none',
              }}>Lexium Cobot {applyToModel ? '· live joints' : '· HOME'}</div>
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
            {showGhost ? '◉ Fantasma: ' : '◯ Fantasma: '}{selectedPose.replace('POSE_', '').replace(/_/g, ' ')}
          </button>
        </div>

        {/* Telemetry side panel */}
        <div style={{
          width: 320, flexShrink: 0, overflowY: 'auto', padding: 14,
          display: 'flex', flexDirection: 'column', gap: 12,
          borderLeft: '1px solid #1d2c44',
          background: 'linear-gradient(180deg,#0c1828 0%,#0a1422 100%)',
        }}>
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

            {/* Joint jog sliders */}
            <div style={{ fontSize: 9, color: '#5a6c84', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, margin: '6px 0 4px' }}>
              Joints (°, convención robot)
            </div>
            {cmdJoints.map((v, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#abc', width: 22 }}>J{i + 1}</span>
                <input type="range" min={-JOINT_LIMITS_DEG[i]} max={JOINT_LIMITS_DEG[i]} step={0.5}
                  value={v} disabled={!controlEnabled}
                  onChange={(e) => { const n = [...cmdJoints]; n[i] = parseFloat(e.target.value); setCmdJoints(n); }}
                  style={{ flex: 1, accentColor: '#3b8bff' }} />
                <NumField value={v} disabled={!controlEnabled}
                  min={-JOINT_LIMITS_DEG[i]} max={JOINT_LIMITS_DEG[i]} decimals={1} width={56}
                  onChange={(nv) => { const n = [...cmdJoints]; n[i] = nv; setCmdJoints(n); }} />
              </div>
            ))}
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

          {/* === Probar poses de la simulación en el robot real === */}
          <Section title="Pose de simulación → real">
            <select value={selectedPose} onChange={(e) => setSelectedPose(e.target.value)}
              style={{ ...numInput, width: '100%', textAlign: 'left', cursor: 'pointer' }}>
              {Object.keys(POSE_LIB_V26).map((name) => (
                <option key={name} value={name}>{name.replace('POSE_', '').replace(/_/g, ' ')}</option>
              ))}
            </select>

            {/* Preview of the converted controller-convention joint targets */}
            <div style={{ fontSize: 9, color: '#5a6c84', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, margin: '8px 0 4px' }}>
              Joints a enviar (°, robot)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 3, fontSize: 10, fontFamily: 'monospace' }}>
              {selectedPoseCtrlDeg().map((d, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', background: '#0a1422', border: '1px solid #1d2c44', borderRadius: 4, padding: '3px 5px' }}>
                  <span style={{ color: '#5a6c84' }}>J{i + 1}</span>
                  <span style={{ color: '#dde4f0' }}>{d.toFixed(1)}</span>
                </div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 8 }}>
              <button onClick={loadPoseToSliders} disabled={!controlEnabled}
                style={ctrlBtn(controlEnabled, '#475569', '#334155')}>↧ Cargar en sliders</button>
              <button onClick={sendPoseToRobot} disabled={!controlEnabled || cmdBusy}
                style={ctrlBtn(controlEnabled, '#3b8bff', '#2563eb')}>▸ Enviar al robot</button>
            </div>
            <div style={{ fontSize: 9, color: '#5a6c84', marginTop: 6, lineHeight: 1.4 }}>
              "Cargar" llena los sliders para revisar antes de mover; "Enviar"
              manda la pose directo (vel {jointSpeed}%). Usa STOP si algo sale mal.
            </div>

            {/* Sequence player: ghost-only or driving the real robot */}
            <div style={{ borderTop: '1px solid #1d2c44', marginTop: 10, paddingTop: 8 }}>
              <div style={{ fontSize: 9, color: '#5a6c84', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, marginBottom: 6 }}>
                Recorrer secuencia
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                {/* Ghost-only */}
                <button onClick={seqPlaying && !seqIsReal ? stopSequence : playSequence}
                  disabled={seqPlaying && seqIsReal}
                  style={{
                    fontFamily: SANS_FONT, fontSize: 11, fontWeight: 700, color: '#fff',
                    cursor: (seqPlaying && seqIsReal) ? 'not-allowed' : 'pointer',
                    border: 'none', borderRadius: 6, padding: '9px 6px',
                    opacity: (seqPlaying && seqIsReal) ? 0.5 : 1,
                    background: (seqPlaying && !seqIsReal)
                      ? 'linear-gradient(180deg,#f47835 0%,#d96416 100%)'
                      : 'linear-gradient(180deg,#22dd55 0%,#15803d 100%)',
                  }}>
                  {seqPlaying && !seqIsReal ? '⏸ Detener' : '▶ Fantasma'}
                </button>
                {/* Real robot */}
                <button onClick={seqPlaying && seqIsReal ? stopSequence : playRealSequence}
                  disabled={!controlEnabled || (seqPlaying && !seqIsReal)}
                  style={{
                    fontFamily: SANS_FONT, fontSize: 11, fontWeight: 700, color: '#fff',
                    cursor: (!controlEnabled || (seqPlaying && !seqIsReal)) ? 'not-allowed' : 'pointer',
                    border: 'none', borderRadius: 6, padding: '9px 6px',
                    opacity: (!controlEnabled || (seqPlaying && !seqIsReal)) ? 0.5 : 1,
                    background: (seqPlaying && seqIsReal)
                      ? 'linear-gradient(180deg,#f47835 0%,#d96416 100%)'
                      : 'linear-gradient(180deg,#3b8bff 0%,#2563eb 100%)',
                  }}>
                  {seqPlaying && seqIsReal ? '⏸ Detener robot' : '▶ Robot real'}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <span style={{ fontSize: 10, color: '#abc' }}>s/paso</span>
                <input type="range" min={500} max={4000} step={100} value={seqStepMs}
                  onChange={(e) => setSeqStepMs(parseFloat(e.target.value))} disabled={seqIsReal}
                  style={{ flex: 1, accentColor: '#22cc55' }} />
                <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#dde4f0', width: 36, textAlign: 'right' }}>
                  {(seqStepMs / 1000).toFixed(1)}
                </span>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 10, color: '#abc', cursor: 'pointer' }}>
                <input type="checkbox" checked={seqLoop} onChange={(e) => setSeqLoop(e.target.checked)} style={{ accentColor: '#22cc55' }} />
                Repetir en bucle
              </label>
              {seqPlaying && (
                <div style={{ ...statRow, marginTop: 4 }}>
                  <span>{seqIsReal ? 'robot →' : 'paso'}</span>
                  <span style={{ color: seqIsReal ? '#3b8bff' : '#22dd55' }}>
                    {seqStep + 1}/{TRAJECTORY.length} · {selectedPose.replace('POSE_', '').replace(/_/g, ' ')}
                    {TRAJECTORY[seqStep]?.grip === 'grab' ? ' 🧲↓' : TRAJECTORY[seqStep]?.grip === 'release' ? ' ○↑' : ''}
                  </span>
                </div>
              )}
              <div style={{ fontSize: 9, color: '#5a6c84', marginTop: 6, lineHeight: 1.4 }}>
                <b style={{ color: '#7a8c9e' }}>Fantasma</b>: solo anima el preview verde.{' '}
                <b style={{ color: '#7a8c9e' }}>Robot real</b>: ejecuta el ciclo completo (pick→remache→visión→bin)
                a vel {jointSpeed}%, agarrando/soltando el imán en cada pose como en la simulación,
                esperando la llegada en cada paso. STOP aborta.
              </div>
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

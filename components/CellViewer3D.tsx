// V53 cell visualizer — clean rewrite using urdf-loader.
// Scene is in ROS Z-up convention (camera.up = [0,0,1]) so URDF coordinates
// map 1:1 to Three.js, eliminating the axis-conversion bugs of the old
// hand-rolled CobotChain.  All meshes/poses come from V53.

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, Html } from '@react-three/drei';
import * as THREE from 'three';
import { STLLoader } from 'three-stdlib';
import URDFLoader from 'urdf-loader';
import type { URDFRobot } from 'urdf-loader';

// ── V53 poses (from resolved_poses.py) ───────────────────────────────────────
const POSE_LIB: Record<string, [number, number, number, number, number, number]> = {
  POSE_HOME:                  [+0.000000, +0.000000, +0.000000, +1.570796, -1.570796, +0.000000],
  POSE_APPROACH_CONVEYOR:     [-1.683778, +1.496127, -1.595100, +1.614122, -1.620474, -1.683917],
  POSE_PICK_CONVEYOR:         [-1.683776, +2.000212, -1.975846, +1.490785, -1.620475, -1.683915],
  POSE_LIFT_CONVEYOR:         [-1.683780, +1.373415, -1.461953, +1.603686, -1.620473, -1.683920],
  POSE_APPROACH_LOAD_FIXTURE: [-0.638645, +1.595716, -0.778483, +0.169788, -0.884422, -0.974093],
  POSE_PLACE_LOAD_FIXTURE:    [-0.640256, +1.764635, -0.745173, +0.213166, -0.877848, -1.002992],
  POSE_RELEASE_LOAD_FIXTURE:  [-0.645366, +1.748148, -0.769518, +0.218750, -0.856014, -1.018961],
  POSE_RETREAT_LOAD_FIXTURE:  [-0.651802, +1.614594, -0.793524, +0.166479, -0.827237, -0.998181],
  POSE_APPROACH_PICK_RIVETED: [-0.655158, +1.617126, -0.793827, +0.167285, -0.812080, -1.004551],
  POSE_PICK_RIVETED:          [-0.656090, +1.788124, -0.762968, +0.213773, -0.807076, -1.038163],
  POSE_LIFT_RIVETED:          [-0.662384, +1.572930, -0.775116, +0.127519, -0.778237, -0.986133],
  POSE_APPROACH_VISION:       [+0.110620, +1.135199, -0.051987, +0.485431, -1.565044, +0.110364],
  POSE_PLACE_VISION:          [+0.113212, +1.676995, -0.659511, +0.552978, -1.565147, +0.113070],
  POSE_RELEASE_VISION:        [+0.113215, +1.582386, -0.589477, +0.577552, -1.565147, +0.113073],
  POSE_RETREAT_VISION:        [+0.110638, +1.121296, -0.023234, +0.470581, -1.565045, +0.110383],
  POSE_APPROACH_ACCEPT_BIN:   [+2.209657, +1.753535, -1.620040, +1.357474, -1.530664, +2.210256],
  POSE_DROP_ACCEPT_BIN:       [+2.209750, +0.480417, +1.809828, -0.799259, -1.530674, +2.210355],
  POSE_APPROACH_REJECT_BIN:   [+1.225784, -0.442571, +2.178226, -0.197937, -1.523750, +1.225390],
  POSE_DROP_REJECT_BIN:       [+1.225773, -0.031858, +2.523346, -0.953769, -1.523749, +1.225378],
};
type PoseName = keyof typeof POSE_LIB;

// Per-pose gripper state.  Mirrors the V53 pick/place trajectories:
//   PICK_* / APPROACH_PICK / HOME / RELEASE_* / RETREAT_* / DROP_* → OPEN
//   LIFT_* / PLACE_* / APPROACH_LOAD / APPROACH_VISION / APPROACH_BIN → CLOSED
// (the cobot is carrying the CAFI on all "closed" poses).
const GRIPPER_OPEN_AT_POSE: Record<PoseName, boolean> = {
  POSE_HOME:                  true,
  POSE_APPROACH_CONVEYOR:     true,
  POSE_PICK_CONVEYOR:         true,   // just landed, about to close on the piece
  POSE_LIFT_CONVEYOR:         false,  // carrying up
  POSE_APPROACH_LOAD_FIXTURE: false,  // carrying to load fixture
  POSE_PLACE_LOAD_FIXTURE:    false,  // just landed on fixture, about to release
  POSE_RELEASE_LOAD_FIXTURE:  true,   // released
  POSE_RETREAT_LOAD_FIXTURE:  true,
  POSE_APPROACH_PICK_RIVETED: true,
  POSE_PICK_RIVETED:          true,   // just landed, about to grab riveted piece
  POSE_LIFT_RIVETED:          false,  // carrying riveted piece
  POSE_APPROACH_VISION:       false,  // carrying to vision
  POSE_PLACE_VISION:          false,
  POSE_RELEASE_VISION:        true,
  POSE_RETREAT_VISION:        true,
  POSE_APPROACH_ACCEPT_BIN:   false,  // carrying after re-pick from vision
  POSE_DROP_ACCEPT_BIN:       true,
  POSE_APPROACH_REJECT_BIN:   false,
  POSE_DROP_REJECT_BIN:       true,
};

const GRIPPER_OPEN_M  = 0.028;  // URDF upper limit
const GRIPPER_CLOSED_M = 0.000;

// Cobot joint limits, in radians (from the V53 URDF).
const JOINT_LIMITS: ReadonlyArray<[number, number]> = [
  [-3.14159, +3.14159],  // j1 (Y axis, base rotation)
  [-2.61799, +2.61799],  // j2 (shoulder)
  [-2.61799, +2.61799],  // j3 (elbow)
  [-3.14159, +3.14159],  // j4 (wrist1)
  [-2.09440, +2.09440],  // j5 (wrist2)
  [-3.14159, +3.14159],  // j6 (tool flange)
];

// Saved positions schema — what the user "teaches" by jogging the cobot.
interface SavedPosition {
  name: string;
  joints: [number, number, number, number, number, number];
  disc: number;            // turntable angle (rad)
  gripper: number;         // appendage prismatic value (m)
  tcp: [number, number, number]; // TCP world XYZ (snapshot)
  collisions: string[];    // collision-box names hit at this pose
  timestamp: string;       // ISO when saved
}

const SAVED_POSITIONS_KEY = 'schneider_v53_saved_positions';
function loadSavedFromStorage(): SavedPosition[] {
  try {
    const raw = localStorage.getItem(SAVED_POSITIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch { return []; }
}
function persistSaved(positions: SavedPosition[]): void {
  try { localStorage.setItem(SAVED_POSITIONS_KEY, JSON.stringify(positions)); }
  catch { /* quota / privacy mode */ }
}

// ── CAFI workpiece ───────────────────────────────────────────────────────────
type CafiState =
  | 'parked'          // hidden (off-scene)
  | 'conveyor'        // on the belt, at the pick window
  | 'in_gripper'      // follows cobot's cafi_lateral_target_frame (rotates with wrist)
  | 'on_fixture_1'    // attached to turntable fixture 1 (rotates with disc)
  | 'on_fixture_2'    // attached to turntable fixture 2
  | 'at_vision'       // sitting on the vision cradle
  | 'in_accept_bin'
  | 'in_reject_bin';

// Static-state CAFI world centres (used when the part is NOT attached to a
// kinematic frame).  Identity orientation, mesh uses CENTERED offset.
type StaticCafiState = 'conveyor' | 'at_vision' | 'in_accept_bin' | 'in_reject_bin';
const CAFI_AT: Record<StaticCafiState, [number, number, number]> = {
  conveyor:      [1.235, 1.365, 1.070 + 0.0125],   // belt top + half-CAFI thickness
  at_vision:     [0.750, 0.804, 1.025],            // top of vision plate + half-CAFI
  in_accept_bin: [1.650, 0.720, 1.020],            // bin floor + half-CAFI
  in_reject_bin: [1.330, 0.700, 1.020],
};

// V53 lateral-grasp offset (matches the cafi_part_1_link visual in the
// turntable URDF).  Used when the CAFI is attached to a *_cafi_lateral_target
// frame, so its grasp contact aligns with the frame and the body extends
// correctly.  Centered offset is used when the CAFI sits flat on a surface.
const CAFI_OFFSET_ATTACHED: [number, number, number] = [-0.212983, 0.056354, -0.022608];
const CAFI_OFFSET_CENTERED: [number, number, number] = [-0.06145, +0.04365, -0.01255];

// ── Animation sequence (full V53 pick → rivet → vision → accept-bin cycle) ──
type SequenceStep =
  | { kind: 'pose';    pose: PoseName; duration: number; label?: string }
  | { kind: 'gripper'; open: boolean;  dwell: number;    label?: string }
  | { kind: 'cafi';    state: CafiState;                  label?: string }
  | { kind: 'disc';    target: number; duration: number;  label?: string }
  | { kind: 'wait';    dwell: number;                     label?: string };

const SEQUENCE: SequenceStep[] = [
  // === init ===
  { kind: 'pose',    pose: 'POSE_HOME', duration: 0.1 },
  { kind: 'cafi',    state: 'conveyor', label: 'CAFI delivered to conveyor' },
  // === pick from conveyor ===
  { kind: 'pose',    pose: 'POSE_APPROACH_CONVEYOR', duration: 2.0 },
  { kind: 'pose',    pose: 'POSE_PICK_CONVEYOR',     duration: 1.5 },
  { kind: 'gripper', open: false, dwell: 0.8,        label: 'Closing gripper' },
  { kind: 'cafi',    state: 'in_gripper' },
  { kind: 'pose',    pose: 'POSE_LIFT_CONVEYOR',     duration: 1.5 },
  // === place at load fixture ===
  { kind: 'pose',    pose: 'POSE_APPROACH_LOAD_FIXTURE', duration: 2.5 },
  { kind: 'pose',    pose: 'POSE_PLACE_LOAD_FIXTURE',    duration: 1.5 },
  { kind: 'pose',    pose: 'POSE_RELEASE_LOAD_FIXTURE',  duration: 0.8 },
  { kind: 'gripper', open: true, dwell: 0.8,         label: 'Opening gripper' },
  { kind: 'cafi',    state: 'on_fixture_1'},
  { kind: 'pose',    pose: 'POSE_RETREAT_LOAD_FIXTURE',  duration: 1.5 },
  // === disc indexes 180°, rivets, indexes back ===
  { kind: 'disc',    target: Math.PI, duration: 2.5, label: 'Indexing disc' },
  { kind: 'wait',    dwell: 2.0,                     label: 'Riveting…' },
  { kind: 'disc',    target: 0.0,    duration: 2.5,  label: 'Indexing back' },
  // === pick riveted from same world spot ===
  { kind: 'pose',    pose: 'POSE_APPROACH_PICK_RIVETED', duration: 2.0 },
  { kind: 'pose',    pose: 'POSE_PICK_RIVETED',          duration: 1.5 },
  { kind: 'gripper', open: false, dwell: 0.8 },
  { kind: 'cafi',    state: 'in_gripper' },
  { kind: 'pose',    pose: 'POSE_LIFT_RIVETED',          duration: 1.5 },
  // === place at vision ===
  { kind: 'pose',    pose: 'POSE_APPROACH_VISION', duration: 2.5 },
  { kind: 'pose',    pose: 'POSE_PLACE_VISION',    duration: 1.5 },
  { kind: 'pose',    pose: 'POSE_RELEASE_VISION',  duration: 0.8 },
  { kind: 'gripper', open: true, dwell: 0.8 },
  { kind: 'cafi',    state: 'at_vision' },
  { kind: 'pose',    pose: 'POSE_RETREAT_VISION',  duration: 1.5 },
  // === vision inspects (verdict: PASS) ===
  { kind: 'wait',    dwell: 2.0, label: 'Vision inspecting (PASS)' },
  // === pick from vision ===
  { kind: 'pose',    pose: 'POSE_APPROACH_VISION', duration: 1.5 },
  { kind: 'pose',    pose: 'POSE_PLACE_VISION',    duration: 1.5 },
  { kind: 'gripper', open: false, dwell: 0.8 },
  { kind: 'cafi',    state: 'in_gripper' },
  { kind: 'pose',    pose: 'POSE_RETREAT_VISION',  duration: 1.5 },
  // === drop in accept bin ===
  { kind: 'pose',    pose: 'POSE_APPROACH_ACCEPT_BIN', duration: 2.5 },
  { kind: 'pose',    pose: 'POSE_DROP_ACCEPT_BIN',     duration: 1.5 },
  { kind: 'gripper', open: true, dwell: 0.8 },
  { kind: 'cafi',    state: 'in_accept_bin' },
  { kind: 'pose',    pose: 'POSE_APPROACH_ACCEPT_BIN', duration: 1.5 },
  // === return home ===
  { kind: 'pose',    pose: 'POSE_HOME', duration: 2.5 },
];

// V53 world anchors (from schneider_cell.urdf.xacro, all in metres, Z up).
const COBOT_BASE     : [number, number, number] = [1.152, 1.049, 1.000];
const TURNTABLE_BASE : [number, number, number] = [0.692, 1.259, 1.000];
const MESA_CENTRE    : [number, number, number] = [1.252205, 1.049061, 1.000];

// ── Collision avoidance: AABB world boxes around every obstacle the cobot
// must NOT enter.  Each entry is a centre + size in metres (Z-up).  Used
// today only for visualisation (toggleable in HMI); the next pass will use
// these as constraints in the motion planner / pose validator.
interface CollisionBox {
  x: number; y: number; z: number;       // centre, world coords
  sx: number; sy: number; sz: number;    // dimensions
  name: string;
  color?: string;
}

const COLLISION_BOXES: CollisionBox[] = [
  // Conveyor body + belt top (a single AABB encompassing both)
  { x: 1.370, y: 1.365, z: 1.040, sx: 0.375, sy: 0.150, sz: 0.080, name: 'Conveyor',         color: '#fbbf24' },
  // Suministro CAFI feeder plate
  { x: 1.620, y: 1.365, z: 1.0075, sx: 0.150, sy: 0.220, sz: 0.015, name: 'Suministro CAFI', color: '#fbbf24' },
  // Quality bins (hollow boxes — treat the full outer envelope as a no-go)
  { x: 1.650, y: 0.720, z: 1.075, sx: 0.227, sy: 0.172, sz: 0.150, name: 'Bin Aceptado',     color: '#22dd55' },
  { x: 1.330, y: 0.700, z: 1.075, sx: 0.227, sy: 0.182, sz: 0.150, name: 'Bin Rechazado',    color: '#ff5566' },
  // Vision fixture plate
  { x: 0.750, y: 0.804, z: 1.008, sx: 0.159, sy: 0.118, sz: 0.015, name: 'Vision fixture',   color: '#a78bfa' },
  // Cognex camera body + suspension column (treat as a single tall AABB)
  { x: 0.750, y: 0.804, z: 1.520, sx: 0.060, sy: 0.045, sz: 0.045, name: 'Cognex body',      color: '#e879f9' },
  { x: 0.750, y: 0.804, z: 1.795, sx: 0.024, sy: 0.024, sz: 0.550, name: 'Cognex column',    color: '#e879f9' },
  // Riveting canopy + 2 back posts
  { x: 0.692, y: 1.284, z: 1.330, sx: 0.450, sy: 0.300, sz: 0.040, name: 'Riveting canopy',  color: '#fb923c' },
  { x: 0.467, y: 1.434, z: 1.155, sx: 0.030, sy: 0.030, sz: 0.310, name: 'Riveting post NW', color: '#fb923c' },
  { x: 0.917, y: 1.434, z: 1.155, sx: 0.030, sy: 0.030, sz: 0.310, name: 'Riveting post NE', color: '#fb923c' },
  // Turntable disc + rivet fixtures.  Top is flush with the fixture body
  // (disc top z≈1.078 per URDF, fixture top ≈+50 mm → 1.128).  The CAFI
  // workpieces sit above and are intentionally LEFT OUT — the cobot does
  // pick them up.  XY shrunk to ~disc diameter (≈0.265 m).
  { x: 0.692, y: 1.259, z: 1.064, sx: 0.270, sy: 0.270, sz: 0.128, name: 'Turntable + fixtures', color: '#a78bfa' },
  // Cabin corner posts (4)
  { x: 0.30, y: 0.30, z: 1.010, sx: 0.050, sy: 0.050, sz: 2.020, name: 'Cabin post SW',     color: '#c8c8cc' },
  { x: 2.20, y: 0.30, z: 1.010, sx: 0.050, sy: 0.050, sz: 2.020, name: 'Cabin post SE',     color: '#c8c8cc' },
  { x: 0.30, y: 1.80, z: 1.010, sx: 0.050, sy: 0.050, sz: 2.020, name: 'Cabin post NW',     color: '#c8c8cc' },
  { x: 2.20, y: 1.80, z: 1.010, sx: 0.050, sy: 0.050, sz: 2.020, name: 'Cabin post NE',     color: '#c8c8cc' },
  // SICK photoelectric sensors (body + bracket envelope)
  { x: 1.235, y: 1.310, z: 1.100, sx: 0.045, sy: 0.080, sz: 0.045, name: 'Sensor conveyor', color: '#33dffe' },
  { x: 0.626, y: 0.804, z: 1.040, sx: 0.080, sy: 0.045, sz: 0.045, name: 'Sensor vision',   color: '#33dffe' },
  // NEMA17 conveyor motor
  { x: 1.550, y: 1.365, z: 1.036, sx: 0.045, sy: 0.045, sz: 0.060, name: 'NEMA17 motor',    color: '#fbbf24' },
];

// ── Hook: load a URDF asynchronously and expose the robot object ─────────────
function useUrdf(url: string): URDFRobot | null {
  const [robot, setRobot] = useState<URDFRobot | null>(null);
  useEffect(() => {
    // URDFLoader.load() defaults workingPath to the URDF's directory if
    // this.workingPath is falsy ('' is falsy too).  That breaks our
    // absolute mesh URIs (they get prefixed with /urdf/ and 404).
    // Bypass by fetching the XML ourselves and calling parse() — parse()
    // uses this.workingPath directly (which we keep as '').
    const loader = new URDFLoader();
    loader.workingPath = '';
    loader.parseCollision = false;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`URDF fetch failed: ${url} (${res.status})`);
        return res.text();
      })
      .then((text) => {
        const r = loader.parse(text);
        r.traverse((c) => {
          c.castShadow = true;
          c.receiveShadow = true;
        });
        setRobot(r);
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error('URDF load failed:', url, e);
      });
  }, [url]);
  return robot;
}

// ── Cobot (loaded URDF, joint-driven) ────────────────────────────────────────
interface CobotProps {
  jointsRef: React.MutableRefObject<[number, number, number, number, number, number]>;
  gripperRef: React.MutableRefObject<number>; // target prismatic value in metres
  gripperLiveRef: React.MutableRefObject<number>; // current animated value
  gripperWorldRef: React.MutableRefObject<[number, number, number]>;
  collisionsRef: React.MutableRefObject<string[]>;
  robotRef: React.MutableRefObject<URDFRobot | null>;
}

const GRIPPER_SPEED = 0.04; // m/s (URDF velocity limit is 0.08)

function Cobot({ jointsRef, gripperRef, gripperLiveRef, gripperWorldRef, collisionsRef, robotRef }: CobotProps) {
  const robot = useUrdf('/urdf/lexium_cobot.urdf');
  const groupRef = useRef<THREE.Group>(null);
  const obstacles = useMemo(() => collisionAABBs(), []);

  // Expose loaded robot to parent so other components (CafiMesh) can query frames.
  useEffect(() => {
    if (robot) {
      robotRef.current = robot;
      // eslint-disable-next-line no-console
      console.log('[Cobot URDF] frames:', Object.keys(robot.frames).sort());
    }
  }, [robot, robotRef]);

  // Bulk-check every pose once the URDF is loaded — logs which poses collide
  // with which boxes (and at which links).  Restores HOME after the sweep.
  useEffect(() => {
    if (!robot || !groupRef.current) return;
    const report: Record<string, string[]> = {};
    for (const [poseName, j] of Object.entries(POSE_LIB)) {
      robot.setJointValue('joint_1', j[0]);
      robot.setJointValue('joint_2', j[1]);
      robot.setJointValue('joint_3', j[2]);
      robot.setJointValue('joint_4', j[3]);
      robot.setJointValue('joint_5', j[4]);
      robot.setJointValue('joint_6', j[5]);
      groupRef.current!.updateMatrixWorld(true);
      const hits = checkCobotCollisions(robot, obstacles);
      if (hits.length > 0) report[poseName] = hits;
    }
    // Restore HOME
    const home = POSE_LIB.POSE_HOME;
    for (let i = 0; i < 6; i++) robot.setJointValue(`joint_${i + 1}`, home[i]);
    groupRef.current!.updateMatrixWorld(true);

    const colliding = Object.keys(report).length;
    // eslint-disable-next-line no-console
    console.log(`%c[Collision sweep] ${colliding}/${Object.keys(POSE_LIB).length} poses collide`,
      colliding ? 'color:#ff5566;font-weight:700' : 'color:#22dd55;font-weight:700');
    for (const [pose, boxes] of Object.entries(report)) {
      // eslint-disable-next-line no-console
      console.log(`  ${pose} → ${boxes.join(', ')}`);
    }
  }, [robot, obstacles]);

  useFrame((_, dt) => {
    if (!robot) return;
    const j = jointsRef.current;
    robot.setJointValue('joint_1', j[0]);
    robot.setJointValue('joint_2', j[1]);
    robot.setJointValue('joint_3', j[2]);
    robot.setJointValue('joint_4', j[3]);
    robot.setJointValue('joint_5', j[4]);
    robot.setJointValue('joint_6', j[5]);

    // Smoothly track the target gripper aperture.
    const target = gripperRef.current;
    const live = gripperLiveRef.current;
    const step = GRIPPER_SPEED * dt;
    let next = live;
    if (Math.abs(target - live) <= step) next = target;
    else next = live + Math.sign(target - live) * step;
    gripperLiveRef.current = next;
    robot.setJointValue('appendage_prismatic_joint', next);

    // Force matrix update so the world AABB check sees the new pose.
    if (groupRef.current) groupRef.current.updateMatrixWorld(true);

    const tcp = robot.frames['tcp_link'];
    if (tcp) {
      const v = new THREE.Vector3();
      tcp.getWorldPosition(v);
      gripperWorldRef.current = [v.x, v.y, v.z];
    }

    collisionsRef.current = checkCobotCollisions(robot, obstacles);
  });

  if (!robot) return null;
  return (
    <group ref={groupRef} position={COBOT_BASE}>
      <primitive object={robot} />
    </group>
  );
}

// ── CAFI workpiece (real V53 cafi.STL) ───────────────────────────────────────
// When attached (in_gripper / on_fixture_*) the group's world pose is copied
// straight from the corresponding URDF frame, so the CAFI tracks rotation as
// well as translation (e.g. follows the disc spinning, or the wrist orienting
// while the cobot is carrying it).  When static the group is positioned at a
// hardcoded world centre with identity rotation.  The mesh-local offset is
// swapped between V53 lateral-grasp values (attached) and centred values
// (static) so the CAFI lands in the right spot in both cases.
function CafiMesh({
  stateRef, cobotRobotRef, turntableRobotRef, graspYawRef,
}: {
  stateRef: React.MutableRefObject<CafiState>;
  cobotRobotRef: React.MutableRefObject<URDFRobot | null>;
  turntableRobotRef: React.MutableRefObject<URDFRobot | null>;
  graspYawRef: React.MutableRefObject<number>;
}) {
  // Both V53 cafi STLs have the same bbox but DIFFERENT vertex layouts.
  // Each was authored for a specific use:
  //   - turntable/cafi.stl: oriented to match the V53 fixture/grasp offset
  //     (-0.213, +0.056, -0.023) — use it when the CAFI is attached to a
  //     URDF frame (in_gripper, on_fixture_*).
  //   - cell/cafi.stl: oriented so the CENTERED mesh offset
  //     (-0.0615, +0.0437, -0.0126) lays the part flat about the group
  //     origin — use it for static states (conveyor, vision, bins).
  const [geomAttached, geomStatic] = useLoader(STLLoader, [
    '/meshes/v53/turntable/cafi.stl',
    '/meshes/v53/cell/cafi.STL',
  ]);
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const tmpPos = useMemo(() => new THREE.Vector3(), []);
  const tmpQuat = useMemo(() => new THREE.Quaternion(), []);
  const yawQuat = useMemo(() => new THREE.Quaternion(), []);
  const yawAxis = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const lastStateLogged = useRef<CafiState | null>(null);

  useFrame(() => {
    const g = groupRef.current;
    const m = meshRef.current;
    if (!g || !m) return;
    const state = stateRef.current;
    if (state === 'parked') { g.visible = false; return; }
    g.visible = true;

    let frame: THREE.Object3D | undefined | null;
    let rootRobot: URDFRobot | null = null;
    let frameName = '';
    if (state === 'in_gripper') {
      rootRobot = cobotRobotRef.current;
      frameName = 'cafi_lateral_target_frame';
    } else if (state === 'on_fixture_1') {
      rootRobot = turntableRobotRef.current;
      frameName = 'cafi_part_1_link';
    } else if (state === 'on_fixture_2') {
      rootRobot = turntableRobotRef.current;
      frameName = 'cafi_part_2_link';
    }
    if (rootRobot && frameName) {
      // Try the frames map first; fall back to a tree walk if the parser
      // didn't expose the link in `frames` for some reason.
      frame = rootRobot.frames[frameName] ?? rootRobot.getObjectByName(frameName);
    }

    if (frame) {
      // Belt-and-braces: force the whole chain's matrices fresh before
      // querying — covers any case where matrixAutoUpdate hasn't kicked
      // in yet this frame.
      if (rootRobot) rootRobot.updateMatrixWorld(true);
      frame.getWorldPosition(tmpPos);
      frame.getWorldQuaternion(tmpQuat);
      g.position.copy(tmpPos);
      // For in_gripper, compose the gripper frame's world rotation with an
      // extra Ry yaw applied in the group's LOCAL frame.  Since the group
      // sits exactly at the gripper centre, this yaw rotates everything
      // inside it (mesh + offset) around the gripper centre concentrically.
      if (state === 'in_gripper') {
        yawQuat.setFromAxisAngle(yawAxis, graspYawRef.current);
        g.quaternion.copy(tmpQuat).multiply(yawQuat);
      } else {
        g.quaternion.copy(tmpQuat);
      }
      m.position.set(...CAFI_OFFSET_ATTACHED);
      if (m.geometry !== geomAttached) m.geometry = geomAttached;
      m.rotation.set(Math.PI / 2, 0, 0);
    } else {
      const xyz = CAFI_AT[state as StaticCafiState];
      if (xyz) {
        g.position.set(xyz[0], xyz[1], xyz[2]);
        g.quaternion.identity();
        m.position.set(...CAFI_OFFSET_CENTERED);
        if (m.geometry !== geomStatic) m.geometry = geomStatic;
        m.rotation.set(Math.PI / 2, 0, 0);
      }
    }

    // One-shot diagnostic on every state transition: print pose of the
    // frame we attached to AND the pose of the corresponding V53 reference
    // mesh (if any) so we can compare offsets and orientations directly.
    if (state !== lastStateLogged.current) {
      lastStateLogged.current = state;
      const refMeshName =
        state === 'on_fixture_1' ? 'cafi_part_1_link' :
        state === 'on_fixture_2' ? 'cafi_part_2_link' : null;
      const refMesh = refMeshName && turntableRobotRef.current
        ? turntableRobotRef.current.getObjectByName(refMeshName)
        : null;
      const refPos = new THREE.Vector3();
      const refQuat = new THREE.Quaternion();
      if (refMesh) {
        // walk to the visual child (the actual mesh sits inside URDFVisual)
        refMesh.traverse((c) => {
          if ((c as THREE.Mesh).isMesh && refPos.length() === 0) {
            c.getWorldPosition(refPos);
            c.getWorldQuaternion(refQuat);
          }
        });
      }
      const oranWorldPos = new THREE.Vector3();
      const oranWorldQuat = new THREE.Quaternion();
      m.getWorldPosition(oranWorldPos);
      m.getWorldQuaternion(oranWorldQuat);
      // eslint-disable-next-line no-console
      console.log(
        `%c[CafiMesh] state → ${state}`,
        'color:#d97340;font-weight:700',
        {
          frameFound: !!frame,
          frameWorldPos: frame ? `(${tmpPos.x.toFixed(3)}, ${tmpPos.y.toFixed(3)}, ${tmpPos.z.toFixed(3)})` : null,
          orangeMeshWorldPos: `(${oranWorldPos.x.toFixed(3)}, ${oranWorldPos.y.toFixed(3)}, ${oranWorldPos.z.toFixed(3)})`,
          orangeMeshQuat: `(${oranWorldQuat.x.toFixed(3)}, ${oranWorldQuat.y.toFixed(3)}, ${oranWorldQuat.z.toFixed(3)}, ${oranWorldQuat.w.toFixed(3)})`,
          blueRefMeshWorldPos: refMesh ? `(${refPos.x.toFixed(3)}, ${refPos.y.toFixed(3)}, ${refPos.z.toFixed(3)})` : null,
          blueRefMeshQuat: refMesh ? `(${refQuat.x.toFixed(3)}, ${refQuat.y.toFixed(3)}, ${refQuat.z.toFixed(3)}, ${refQuat.w.toFixed(3)})` : null,
        },
      );
    }
  });

  return (
    <group ref={groupRef}>
      {/* Rx(+π/2) lays the 25.1 mm thickness along world Z.  position is
          rewritten each frame by useFrame (attached vs centred). */}
      <mesh
        ref={meshRef}
        geometry={geomStatic}
        scale={[0.001, 0.001, 0.001]}
        position={CAFI_OFFSET_CENTERED}
        rotation={[Math.PI / 2, 0, 0]}
        castShadow
      >
        <meshStandardMaterial color="#d97340" metalness={0.25} roughness={0.55} />
      </mesh>
    </group>
  );
}

// ── Sequence player ──────────────────────────────────────────────────────────
// Drives jointsRef + discAngleRef + gripperRef + cafiStateRef from SEQUENCE
// using cosine-eased interpolation between consecutive poses.
interface PlayerState {
  playing: boolean;
  step: number;     // current index into SEQUENCE
  t: number;        // elapsed time within current step (seconds)
  startJoints: [number, number, number, number, number, number];
  startDisc: number;
}

function SequencePlayer({
  playerRef,
  jointsRef,
  discAngleRef,
  gripperRef,
  cafiStateRef,
}: {
  playerRef: React.MutableRefObject<PlayerState>;
  jointsRef: React.MutableRefObject<[number, number, number, number, number, number]>;
  discAngleRef: React.MutableRefObject<number>;
  gripperRef: React.MutableRefObject<number>;
  cafiStateRef: React.MutableRefObject<CafiState>;
}) {
  useFrame((_, dt) => {
    const p = playerRef.current;
    if (!p.playing) return;
    const step = SEQUENCE[p.step];
    if (!step) { p.playing = false; return; }

    // First entry into a step? Snapshot the start state.
    if (p.t === 0) {
      p.startJoints = [...jointsRef.current] as PlayerState['startJoints'];
      p.startDisc = discAngleRef.current;
      // For instantaneous "set" steps (cafi state), apply immediately.
      if (step.kind === 'cafi') cafiStateRef.current = step.state;
      if (step.kind === 'gripper') gripperRef.current = step.open ? GRIPPER_OPEN_M : GRIPPER_CLOSED_M;
    }

    p.t += dt;

    let done = false;
    if (step.kind === 'pose') {
      const dur = Math.max(0.0001, step.duration);
      const u = Math.min(1, p.t / dur);
      const eased = 0.5 * (1 - Math.cos(Math.PI * u));
      const target = POSE_LIB[step.pose];
      for (let i = 0; i < 6; i++) {
        jointsRef.current[i] =
          p.startJoints[i] + (target[i] - p.startJoints[i]) * eased;
      }
      if (u >= 1) done = true;
    } else if (step.kind === 'disc') {
      const dur = Math.max(0.0001, step.duration);
      const u = Math.min(1, p.t / dur);
      const eased = 0.5 * (1 - Math.cos(Math.PI * u));
      discAngleRef.current = p.startDisc + (step.target - p.startDisc) * eased;
      if (u >= 1) done = true;
    } else if (step.kind === 'gripper') {
      if (p.t >= step.dwell) done = true;
    } else if (step.kind === 'cafi') {
      done = true; // instantaneous
    } else if (step.kind === 'wait') {
      if (p.t >= step.dwell) done = true;
    }

    if (done) {
      p.step += 1;
      p.t = 0;
      if (p.step >= SEQUENCE.length) p.playing = false;
    }
  });
  return null;
}

// ── Turntable (loaded URDF, disc-driven) ─────────────────────────────────────
function Turntable({
  angleRef, robotRef,
}: {
  angleRef: React.MutableRefObject<number>;
  robotRef: React.MutableRefObject<URDFRobot | null>;
}) {
  const robot = useUrdf('/urdf/turntable_rivet_cell.urdf');
  const groupRef = useRef<THREE.Group>(null);
  useEffect(() => {
    if (robot) {
      robotRef.current = robot;
      // eslint-disable-next-line no-console
      console.log('[Turntable URDF] frames:', Object.keys(robot.frames).sort());
    }
  }, [robot, robotRef]);
  useFrame(() => {
    if (!robot) return;
    robot.setJointValue('table_rotation_joint', angleRef.current);
    // Without forcing matrixWorld, downstream consumers (CafiMesh querying
    // the fixture frames) read the previous frame's pose and the CAFI
    // appears to lag/snap instead of following the rotating disc.
    if (groupRef.current) groupRef.current.updateMatrixWorld(true);
  });
  if (!robot) return null;
  return (
    <group ref={groupRef} position={TURNTABLE_BASE}>
      <primitive object={robot} />
    </group>
  );
}

// ── Primitive cell pieces (mesa, cabin, conveyor, bins, etc.) ────────────────
function CellPrimitives() {
  return (
    <>
      {/* Floor slab */}
      <mesh position={[MESA_CENTRE[0], MESA_CENTRE[1], -0.0025]} receiveShadow>
        <boxGeometry args={[2.504, 2.098, 0.005]} />
        <meshStandardMaterial color="#1a2740" roughness={0.9} />
      </mesh>

      {/* Mesa: slab + 4 legs (V53 plant_table 1.62 x 0.92 x 1.00) */}
      <MesaTable cx={MESA_CENTRE[0]} cy={MESA_CENTRE[1]} sx={1.620} sy={0.920} topZ={1.000} thickness={0.040} legSect={0.060} legInset={0.060} />

      {/* Conveyor (V53: 375 x 150 mm @ (1.370, 1.365), belt top z=1.070) */}
      <mesh position={[1.370, 1.365, 1.070 - 0.0325]} castShadow receiveShadow>
        <boxGeometry args={[0.375, 0.150, 0.065]} />
        <meshStandardMaterial color="#4a4a52" metalness={0.4} roughness={0.5} />
      </mesh>
      {/* Belt top surface */}
      <mesh position={[1.370, 1.365, 1.070]} receiveShadow>
        <boxGeometry args={[0.355, 0.110, 0.003]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.85} />
      </mesh>

      {/* Suministro CAFI feeder at east end of belt */}
      <mesh position={[1.620, 1.365, 1.0075]} castShadow>
        <boxGeometry args={[0.150, 0.220, 0.015]} />
        <meshStandardMaterial color="#888894" metalness={0.5} roughness={0.4} />
      </mesh>

      {/* Bins (hollow boxes, no top) — aceptado and rechazado */}
      <HollowBin x={1.650} y={0.720} sx={0.226837} sy={0.172} h={0.150} color="#22dd55" />
      <HollowBin x={1.330} y={0.700} sx={0.226837} sy={0.182} h={0.150} color="#ff5566" />

      {/* Vision fixture — real V53 STL (Fixture_para_camara_final). */}
      <VisionFixture x={0.750} y={0.804} z={1.000} />

      {/* Cell-level photoelectric sensors (V53 sick_grte18s_p2312) */}
      {/* sensor_conveyor_end: faces N across belt at the west pick */}
      <SickPhotoelectric faceX={1.235} faceY={1.290} faceZ={1.100}
        beamYaw={Math.PI / 2} mesaZ={1.000} beamLen={0.150} />
      {/* sensor_vision_piece_present: west of cradle, beam yaw=0 (east) */}
      <SickPhotoelectric faceX={0.586} faceY={0.804} faceZ={1.040}
        beamYaw={0} mesaZ={1.000} beamLen={0.130} />

      {/* Conveyor drive motor: NEMA17 STL under east end of belt */}
      <Nema17Motor x={1.550} y={1.365} z={1.036} axisYaw={Math.PI / 2} />

      {/* Cognex 2800 camera hanging from cabin top at (0.750, 0.804, 1.520) */}
      <CognexCamera x={0.750} y={0.804} z={1.520} cabinTopZ={2.070} />

      {/* Riveting station (V53: cabin 0.450x0.300x0.350, NW+NE posts only,
          canopy lips, stack-light tower, tool tray).  Anchored at
          riveting_zone = (0.692, 1.259, 1.000) per schneider_cell.xacro;
          cabin offset internal is (0, +0.025) within the zone. */}
      <RivetingStation
        anchorX={0.692} anchorY={1.259} anchorZ={1.000}
        zoneSizeY={0.350}
        cabinSizeX={0.450} cabinSizeY={0.300} cabinHeight={0.350}
      />

      {/* Control station — full V53 bench with monitors, PLC, HMI, e-stop, etc. */}
      <ControlStation x={0.684} y={0.462} yaw={0}
        width={0.483} depth={0.254} height={1.200} />

      {/* Operator chair (seat + back + 4 legs) */}
      <OperatorChair x={0.684} y={0.150} sx={0.400} sy={0.300} seatTopZ={0.500} backH={0.400} legR={0.018} />

      {/* Aluminum cabin — 4 posts, top + bottom perimeter, cobot ceiling
          cross-beams (matches aluminum_cabin.xacro V36). */}
      <AluminumCabin xMin={0.30} xMax={2.20} yMin={0.30} yMax={1.80}
        topZ={2.070} postSection={0.050}
        cobotMountX={0.950} cobotMountY={0.972} />
    </>
  );
}

// ── V53 STL-based scene parts ────────────────────────────────────────────────

// Vision fixture: real V53 STL plate.  The xacro applies Rx(+π/2) so the
// mesh's Y axis (15 mm thickness) becomes link Z, then centres the bbox via
// xyz (-0.079329, 0.058950, 0).  We replicate both in three.js (Z-up scene).
function VisionFixture({ x, y, z }: { x: number; y: number; z: number }) {
  const geom = useLoader(STLLoader, '/meshes/v53/cell/Fixture_para_camara_final.STL');
  return (
    <group position={[x, y, z]}>
      <mesh
        geometry={geom}
        scale={[0.001, 0.001, 0.001]}
        position={[-0.079329, 0.058950, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        castShadow receiveShadow
      >
        <meshStandardMaterial color="#7e6bd4" metalness={0.35} roughness={0.55} />
      </mesh>
    </group>
  );
}

// SICK GRTE18S-P2312 photoelectric sensor assembly (V53 xacro:sick_photoelectric).
// Convention: sensor LINK's local +X = beam direction; optical face at link origin.
// Body STL has Rz(+π/2) so mesh -Y (beam) maps to link +X.  The parent transform
// rotates the whole link by Rz(beam_yaw) around the world Z axis.
// Sub-parts: clamp, arm, vertical post down to mesa, foot plate.
function SickPhotoelectric({
  faceX, faceY, faceZ, beamYaw, mesaZ, beamLen,
}: {
  faceX: number; faceY: number; faceZ: number;
  beamYaw: number; mesaZ: number; beamLen: number;
}) {
  const geom = useLoader(STLLoader, '/meshes/v53/cell/sick_grte18s_p2312.STL');
  const postLen = faceZ - mesaZ;
  return (
    <group position={[faceX, faceY, faceZ]} rotation={[0, 0, beamYaw]}>
      {/* Body */}
      <mesh
        geometry={geom}
        scale={[0.001, 0.001, 0.001]}
        rotation={[0, 0, Math.PI / 2]}
        castShadow
      >
        <meshStandardMaterial color="#101212" metalness={0.5} roughness={0.45} />
      </mesh>
      {/* Aim beam — translucent cylinder along link +X.
          Three.js cylinder is local Y by default; Rz(-π/2) maps Y → +X. */}
      <mesh position={[beamLen / 2, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.0015, 0.0015, beamLen, 12]} />
        <meshStandardMaterial color="#33dffe" transparent opacity={0.55} />
      </mesh>
      {/* Clamp */}
      <mesh position={[-0.020, 0, 0]} castShadow>
        <boxGeometry args={[0.026, 0.034, 0.034]} />
        <meshStandardMaterial color="#7a808a" metalness={0.7} roughness={0.4} />
      </mesh>
      {/* Arm */}
      <mesh position={[-0.050, 0, 0]} castShadow>
        <boxGeometry args={[0.062, 0.016, 0.016]} />
        <meshStandardMaterial color="#7a808a" metalness={0.7} roughness={0.4} />
      </mesh>
      {/* Vertical post — Three.js cylinder is local Y; Rx(+π/2) maps Y → +Z. */}
      <mesh position={[-0.078, 0, -postLen / 2]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.011, 0.011, postLen, 12]} />
        <meshStandardMaterial color="#7a808a" metalness={0.7} roughness={0.4} />
      </mesh>
      {/* Foot */}
      <mesh position={[-0.078, 0, -postLen + 0.004]} castShadow>
        <boxGeometry args={[0.060, 0.060, 0.008]} />
        <meshStandardMaterial color="#7a808a" metalness={0.7} roughness={0.4} />
      </mesh>
    </group>
  );
}

// NEMA17 stepper motor mesh.  Mesh axis along its own Z (typical NEMA17 STL
// is a 42x42 mm body extruded along Z).  axisYaw rotates the motor around
// the world Z so the shaft pokes in the desired direction.
function Nema17Motor({ x, y, z, axisYaw }: { x: number; y: number; z: number; axisYaw: number }) {
  const geom = useLoader(STLLoader, '/meshes/v53/cell/nema17.STL');
  return (
    <group position={[x, y, z]} rotation={[0, 0, axisYaw]}>
      <mesh geometry={geom} scale={[0.001, 0.001, 0.001]} castShadow>
        <meshStandardMaterial color="#1a1a1c" metalness={0.55} roughness={0.4} />
      </mesh>
    </group>
  );
}

function MesaTable({ cx, cy, sx, sy, topZ, thickness, legSect, legInset }: {
  cx: number; cy: number; sx: number; sy: number; topZ: number; thickness: number; legSect: number; legInset: number;
}) {
  const legH = topZ - thickness;
  const legZ = legH / 2;
  const lx = sx / 2 - legSect / 2 - legInset;
  const ly = sy / 2 - legSect / 2 - legInset;
  const stretcherSect = 0.040;
  const stretcherZ = topZ - thickness - (legH - 0.20); // 0.20 m above the floor
  const stretchXLen = sx - 2 * legInset;
  const stretchYLen = sy - 2 * legInset;
  const lipT = 0.012, lipH = 0.010;
  return (
    <>
      {/* Worktop */}
      <mesh position={[cx, cy, topZ - thickness / 2]} castShadow receiveShadow>
        <boxGeometry args={[sx, sy, thickness]} />
        <meshStandardMaterial color="#aeb4c0" metalness={0.45} roughness={0.5} />
      </mesh>
      {/* Top-surface lip N and S */}
      <mesh position={[cx, cy + sy / 2 - lipT / 2, topZ + lipH / 2]} castShadow>
        <boxGeometry args={[sx, lipT, lipH]} />
        <meshStandardMaterial color="#7a808a" metalness={0.55} roughness={0.45} />
      </mesh>
      <mesh position={[cx, cy - sy / 2 + lipT / 2, topZ + lipH / 2]} castShadow>
        <boxGeometry args={[sx, lipT, lipH]} />
        <meshStandardMaterial color="#7a808a" metalness={0.55} roughness={0.45} />
      </mesh>
      {/* 4 corner legs (box section) */}
      {[[+lx, +ly], [+lx, -ly], [-lx, +ly], [-lx, -ly]].map(([dx, dy], i) => (
        <mesh key={i} position={[cx + dx, cy + dy, legZ]} castShadow>
          <boxGeometry args={[legSect, legSect, legH]} />
          <meshStandardMaterial color="#4a4f58" metalness={0.6} roughness={0.5} />
        </mesh>
      ))}
      {/* 2 long-side stretchers (N and S) near the floor */}
      <mesh position={[cx, cy + sy / 2 - legInset, stretcherZ]} castShadow>
        <boxGeometry args={[stretchXLen, stretcherSect, stretcherSect]} />
        <meshStandardMaterial color="#7a808a" metalness={0.55} roughness={0.45} />
      </mesh>
      <mesh position={[cx, cy - sy / 2 + legInset, stretcherZ]} castShadow>
        <boxGeometry args={[stretchXLen, stretcherSect, stretcherSect]} />
        <meshStandardMaterial color="#7a808a" metalness={0.55} roughness={0.45} />
      </mesh>
      {/* Cross stretcher (along Y, at centre) */}
      <mesh position={[cx, cy, stretcherZ]} castShadow>
        <boxGeometry args={[stretcherSect, stretchYLen, stretcherSect]} />
        <meshStandardMaterial color="#7a808a" metalness={0.55} roughness={0.45} />
      </mesh>
    </>
  );
}

function HollowBin({ x, y, sx, sy, h, color }: { x: number; y: number; sx: number; sy: number; h: number; color: string }) {
  const wt = 0.005;
  const bottomZ = 1.000 + wt / 2;
  const wallZ = 1.000 + wt + (h - wt) / 2;
  return (
    <group>
      <mesh position={[x, y, bottomZ]} receiveShadow>
        <boxGeometry args={[sx, sy, wt]} />
        <meshStandardMaterial color={color} metalness={0.2} roughness={0.7} />
      </mesh>
      {/* N wall */}
      <mesh position={[x, y + sy / 2 - wt / 2, wallZ]} castShadow>
        <boxGeometry args={[sx, wt, h - wt]} />
        <meshStandardMaterial color={color} metalness={0.2} roughness={0.7} />
      </mesh>
      {/* S wall */}
      <mesh position={[x, y - sy / 2 + wt / 2, wallZ]} castShadow>
        <boxGeometry args={[sx, wt, h - wt]} />
        <meshStandardMaterial color={color} metalness={0.2} roughness={0.7} />
      </mesh>
      {/* E wall */}
      <mesh position={[x + sx / 2 - wt / 2, y, wallZ]} castShadow>
        <boxGeometry args={[wt, sy - 2 * wt, h - wt]} />
        <meshStandardMaterial color={color} metalness={0.2} roughness={0.7} />
      </mesh>
      {/* W wall */}
      <mesh position={[x - sx / 2 + wt / 2, y, wallZ]} castShadow>
        <boxGeometry args={[wt, sy - 2 * wt, h - wt]} />
        <meshStandardMaterial color={color} metalness={0.2} roughness={0.7} />
      </mesh>
    </group>
  );
}

function CognexCamera({ x, y, z, cabinTopZ }: { x: number; y: number; z: number; cabinTopZ: number }) {
  const colH = cabinTopZ - z;
  return (
    <>
      {/* Vertical suspension column from cabin top down to body.
          Three.js cylinder is local Y by default; Rx(+π/2) puts it along Z. */}
      <mesh position={[x, y, z + colH / 2]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.012, 0.012, colH, 16]} />
        <meshStandardMaterial color="#888" metalness={0.7} roughness={0.4} />
      </mesh>
      {/* Body, rotated +pi/2 around Y so its local +X (lens axis) points down */}
      <group position={[x, y, z]} rotation={[0, Math.PI / 2, 0]}>
        <mesh castShadow>
          <boxGeometry args={[0.060, 0.045, 0.045]} />
          <meshStandardMaterial color="#e879f9" metalness={0.4} roughness={0.5} />
        </mesh>
        {/* Lens cylinder along local +X */}
        <mesh position={[0.030, 0, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[0.014, 0.014, 0.028, 20]} />
          <meshStandardMaterial color="#222" metalness={0.6} roughness={0.4} />
        </mesh>
      </group>
    </>
  );
}

// Riveting station — V8/V39 riveting_station.xacro.  Cabin posts on the
// north side only (V39 removed south posts so cobot can enter from south),
// top canopy plate with N/S lips, 3-lamp stack light (red/amber/green) on
// a vertical post, and a tool tray bolted to the back wall.
function RivetingStation({
  anchorX, anchorY, anchorZ, zoneSizeY,
  cabinSizeX, cabinSizeY, cabinHeight,
}: {
  anchorX: number; anchorY: number; anchorZ: number;
  zoneSizeY: number;
  cabinSizeX: number; cabinSizeY: number; cabinHeight: number;
}) {
  // Local layout — mirrors the xacro
  const canopyT = 0.040;
  const canopyTopZ = cabinHeight;
  const canopyBotZ = cabinHeight - canopyT;
  const canopyCtrZ = cabinHeight - canopyT / 2;
  const cabinXOff = 0;
  const cabinYOff = (zoneSizeY - cabinSizeY) / 2;
  const postSection = 0.030;
  const postLength = canopyBotZ;
  const postCtrZ = postLength / 2;
  const lipT = 0.010, lipH = 0.012;
  // Stack light position (back-left corner of canopy top, on the cabin)
  const stackX = cabinXOff - cabinSizeX / 2 + 0.060;
  const stackY = cabinYOff;
  const stackBaseZ = canopyTopZ + lipH + 0.005;
  // Tool tray on the back (north) wall, south-facing
  const backThickness = 0.020;
  const trayX = cabinXOff + cabinSizeX / 2 - 0.180;
  const trayY = cabinYOff + cabinSizeY / 2 - backThickness - 0.075;
  const trayZ = 0.180;

  return (
    <group position={[anchorX, anchorY, anchorZ]}>
      {/* Cabin posts — NE and NW (back only) */}
      <mesh position={[cabinXOff + cabinSizeX / 2, cabinYOff + cabinSizeY / 2, postCtrZ]} castShadow>
        <boxGeometry args={[postSection, postSection, postLength]} />
        <meshStandardMaterial color="#888c94" metalness={0.55} roughness={0.5} />
      </mesh>
      <mesh position={[cabinXOff - cabinSizeX / 2, cabinYOff + cabinSizeY / 2, postCtrZ]} castShadow>
        <boxGeometry args={[postSection, postSection, postLength]} />
        <meshStandardMaterial color="#888c94" metalness={0.55} roughness={0.5} />
      </mesh>

      {/* Top canopy plate */}
      <mesh position={[cabinXOff, cabinYOff, canopyCtrZ]} castShadow receiveShadow>
        <boxGeometry args={[cabinSizeX, cabinSizeY, canopyT]} />
        <meshStandardMaterial color="#6a707a" metalness={0.5} roughness={0.55} />
      </mesh>

      {/* Canopy lips (N + S edges, slim raised border) */}
      <mesh position={[cabinXOff, cabinYOff + cabinSizeY / 2 - lipT / 2, canopyTopZ + lipH / 2]} castShadow>
        <boxGeometry args={[cabinSizeX, lipT, lipH]} />
        <meshStandardMaterial color="#888c94" metalness={0.55} roughness={0.5} />
      </mesh>
      <mesh position={[cabinXOff, cabinYOff - cabinSizeY / 2 + lipT / 2, canopyTopZ + lipH / 2]} castShadow>
        <boxGeometry args={[cabinSizeX, lipT, lipH]} />
        <meshStandardMaterial color="#888c94" metalness={0.55} roughness={0.5} />
      </mesh>

      {/* Stack light tower: vertical post + 3 lamps (red top, amber middle, green bottom) */}
      <mesh position={[stackX, stackY, stackBaseZ + 0.075]}
        rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.012, 0.012, 0.150, 16]} />
        <meshStandardMaterial color="#5a606a" metalness={0.55} roughness={0.5} />
      </mesh>
      <mesh position={[stackX, stackY, stackBaseZ + 0.150]} castShadow>
        <sphereGeometry args={[0.020, 20, 20]} />
        <meshStandardMaterial color="#ff3030" emissive="#ff3030" emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[stackX, stackY, stackBaseZ + 0.105]} castShadow>
        <sphereGeometry args={[0.020, 20, 20]} />
        <meshStandardMaterial color="#ffaa20" emissive="#ffaa20" emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[stackX, stackY, stackBaseZ + 0.060]} castShadow>
        <sphereGeometry args={[0.020, 20, 20]} />
        <meshStandardMaterial color="#22dd55" emissive="#22dd55" emissiveIntensity={0.4} />
      </mesh>

      {/* Tool tray (main plate + 2 lateral rims) — bolted to the back wall, south-facing */}
      <mesh position={[trayX, trayY, trayZ]} castShadow>
        <boxGeometry args={[0.280, 0.130, 0.040]} />
        <meshStandardMaterial color="#4a4f58" metalness={0.5} roughness={0.55} />
      </mesh>
      <mesh position={[trayX, trayY + 0.060, trayZ + 0.025]} castShadow>
        <boxGeometry args={[0.280, 0.008, 0.050]} />
        <meshStandardMaterial color="#4a4f58" metalness={0.5} roughness={0.55} />
      </mesh>
      <mesh position={[trayX, trayY - 0.060, trayZ + 0.025]} castShadow>
        <boxGeometry args={[0.280, 0.008, 0.050]} />
        <meshStandardMaterial color="#4a4f58" metalness={0.5} roughness={0.55} />
      </mesh>
    </group>
  );
}

// Industrial control bench — V14 control_station.xacro.  yaw=0: back panel
// faces +Y (north), operator stands at -Y (south).  desk_top_z=0.800 (fixed
// in V14 regardless of `height` param; height controls back panel height).
function ControlStation({ x, y, yaw, width, depth, height }: {
  x: number; y: number; yaw: number; width: number; depth: number; height: number;
}) {
  const deskTopZ = 0.800;
  const deskTopT = 0.030;
  const legR = 0.020;
  const shelfT = 0.018;
  const shelfLowZ = 0.050;
  const backT = 0.025;
  const backH = height - deskTopZ;
  const backCy = depth / 2 - backT / 2;
  const backSouthY = backCy - backT / 2;

  // Lexium controller (under desk)
  const ctlW = 0.410, ctlD = 0.235, ctlH = 0.307;
  const ctlZBase = shelfLowZ + shelfT;
  // Modicon M262 PLC
  const plcW = 0.125, plcH = 0.100, plcD = 0.090;
  const plcZ = deskTopZ + backH * 0.65;
  const plcFaceY = backSouthY - plcD / 2;
  // Harmony ST6 HMI
  const hmiW = 0.208, hmiH = 0.153, hmiD = 0.045;
  const hmiZ = deskTopZ + backH * 0.50;
  const hmiFaceY = backSouthY - hmiD / 2;
  // Mini-PC + monitor
  const pcW = 0.220, pcD = 0.160, pcH = 0.055;
  const pcX = -width / 4;
  const pcY = depth / 2 - backT - pcD / 2 - 0.010;
  const pcZ = deskTopZ + pcH / 2;
  const monW = 0.330, monH = 0.210, monD = 0.030;
  const monX = -width / 4 + 0.020;
  const monY = pcY - pcD / 2 - monD / 2 - 0.010;
  const monZBase = deskTopZ + 0.020;

  // Materials
  const frameMat  = <meshStandardMaterial color="#7a808a" metalness={0.6} roughness={0.45} />;
  const shelfMat  = <meshStandardMaterial color="#aeb4c0" metalness={0.35} roughness={0.55} />;
  const panelMat  = <meshStandardMaterial color="#4a4f58" metalness={0.4} roughness={0.6} />;
  const ctlMat    = <meshStandardMaterial color="#88909c" metalness={0.5} roughness={0.5} />;
  const plcMat    = <meshStandardMaterial color="#cf8b2a" metalness={0.4} roughness={0.6} />;
  const hmiBezel  = <meshStandardMaterial color="#1a1a1c" metalness={0.6} roughness={0.4} />;
  const screenMat = <meshStandardMaterial color="#103a78" emissive="#1f5eb8" emissiveIntensity={0.5} roughness={0.3} />;
  const pcMat     = <meshStandardMaterial color="#22272f" metalness={0.5} roughness={0.55} />;
  const estopRed  = <meshStandardMaterial color="#dd2030" metalness={0.3} roughness={0.5} />;
  const estopYel  = <meshStandardMaterial color="#ffcc20" metalness={0.3} roughness={0.5} />;
  const lampAmber = <meshStandardMaterial color="#ffae28" emissive="#ffae28" emissiveIntensity={0.4} />;

  return (
    <group position={[x, y, 0]} rotation={[0, 0, yaw]}>
      {/* 4 cylindrical legs (along Z, Rx(+π/2) to convert from Three.js Y-cylinder) */}
      {[[+1, -1], [-1, -1], [+1, +1], [-1, +1]].map(([dx, dy], i) => (
        <mesh key={i}
          position={[dx * (width / 2 - legR), dy * (depth / 2 - legR), deskTopZ / 2]}
          rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[legR, legR, deskTopZ, 14]} />
          {frameMat}
        </mesh>
      ))}

      {/* Worktop */}
      <mesh position={[0, 0, deskTopZ - deskTopT / 2]} castShadow receiveShadow>
        <boxGeometry args={[width, depth, deskTopT]} />
        {shelfMat}
      </mesh>

      {/* Lower shelf (under desk, for the Lexium controller) */}
      <mesh position={[0, 0, shelfLowZ + shelfT / 2]} castShadow>
        <boxGeometry args={[width - 2 * legR, depth - 2 * legR, shelfT]} />
        {shelfMat}
      </mesh>

      {/* Back upright panel */}
      <mesh position={[0, backCy, deskTopZ + backH / 2]} castShadow>
        <boxGeometry args={[width, backT, backH]} />
        {panelMat}
      </mesh>

      {/* Top valance / amber lamp bar */}
      <mesh position={[0, backCy - 0.030 - backT / 2, height - 0.0175]} castShadow>
        <boxGeometry args={[width, 0.060, 0.035]} />
        {lampAmber}
      </mesh>

      {/* Lexium controller (under desk) */}
      <mesh position={[0, 0, ctlZBase + ctlH / 2]} castShadow>
        <boxGeometry args={[ctlW, ctlD, ctlH]} />
        {ctlMat}
      </mesh>

      {/* Modicon M262 PLC on back panel (left half), orange */}
      <mesh position={[-width / 4, plcFaceY, plcZ]} castShadow>
        <boxGeometry args={[plcW, plcD, plcH]} />
        {plcMat}
      </mesh>

      {/* Harmony ST6 HMI on back panel (right half) */}
      <mesh position={[width / 4, hmiFaceY, hmiZ]} castShadow>
        <boxGeometry args={[hmiW, hmiD, hmiH]} />
        {hmiBezel}
      </mesh>
      <mesh position={[width / 4, hmiFaceY - hmiD / 2 - 0.001, hmiZ]}>
        <boxGeometry args={[hmiW * 0.92, 0.002, hmiH * 0.78]} />
        {screenMat}
      </mesh>

      {/* Mini-PC on worktop (left-back) */}
      <mesh position={[pcX, pcY, pcZ]} castShadow>
        <boxGeometry args={[pcW, pcD, pcH]} />
        {pcMat}
      </mesh>

      {/* Monitor on worktop (left-front) */}
      <mesh position={[monX, monY, monZBase + monH / 2]} castShadow>
        <boxGeometry args={[monW, monD, monH]} />
        {pcMat}
      </mesh>
      <mesh position={[monX, monY - monD / 2 - 0.0015, monZBase + monH / 2]}>
        <boxGeometry args={[monW * 0.92, 0.003, monH * 0.86]} />
        {screenMat}
      </mesh>
      {/* Monitor stand (short cylinder) */}
      <mesh position={[monX, monY, deskTopZ + 0.010]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.012, 0.012, 0.020, 16]} />
        {frameMat}
      </mesh>

      {/* E-stop on worktop (right-front): red mushroom on yellow base */}
      <mesh position={[width / 2 - 0.055, -depth / 2 + 0.060, deskTopZ + 0.005]}
        rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.024, 0.024, 0.010, 20]} />
        {estopYel}
      </mesh>
      <mesh position={[width / 2 - 0.055, -depth / 2 + 0.060, deskTopZ + 0.020 + 0.010]}
        rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.020, 0.020, 0.040, 20]} />
        {estopRed}
      </mesh>

      {/* Selector switch (right-mid) */}
      <mesh position={[width / 2 - 0.055, -depth / 2 + 0.140, deskTopZ + 0.005]}
        rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.014, 0.014, 0.010, 16]} />
        <meshStandardMaterial color="#1a1a1c" metalness={0.5} roughness={0.5} />
      </mesh>
      <mesh position={[width / 2 - 0.055, -depth / 2 + 0.140, deskTopZ + 0.012]} castShadow>
        <boxGeometry args={[0.024, 0.005, 0.006]} />
        <meshStandardMaterial color="#888" metalness={0.7} roughness={0.4} />
      </mesh>
    </group>
  );
}

function OperatorChair({ x, y, sx, sy, seatTopZ, backH, legR }: {
  x: number; y: number; sx: number; sy: number; seatTopZ: number; backH: number; legR: number;
}) {
  const seatT = 0.040;
  const backT = 0.040;
  const legH = seatTopZ - seatT;
  return (
    <group>
      <mesh position={[x, y, seatTopZ - seatT / 2]} castShadow>
        <boxGeometry args={[sx, sy, seatT]} />
        <meshStandardMaterial color="#2a3548" metalness={0.2} roughness={0.7} />
      </mesh>
      <mesh position={[x, y - sy / 2 + backT / 2, seatTopZ + backH / 2]} castShadow>
        <boxGeometry args={[sx, backT, backH]} />
        <meshStandardMaterial color="#2a3548" metalness={0.2} roughness={0.7} />
      </mesh>
      {[[+1, +1], [+1, -1], [-1, +1], [-1, -1]].map(([dx, dy], i) => (
        <mesh key={i}
          position={[x + dx * (sx / 2 - 0.030), y + dy * (sy / 2 - 0.030), legH / 2]}
          rotation={[Math.PI / 2, 0, 0]}
          castShadow>
          <cylinderGeometry args={[legR, legR, legH, 14]} />
          <meshStandardMaterial color="#3a3f48" metalness={0.5} />
        </mesh>
      ))}
    </group>
  );
}

// Aluminum cabin frame — V36 aluminum_cabin.xacro (50x50 mm profile):
//   - 4 vertical posts floor → top profile underside
//   - Top perimeter frame (4 bars on N/S/W/E) sitting ON the posts
//   - Bottom perimeter (2 bars on N/S, low)
//   - 3 cobot ceiling cross-beams (2 X-bars at cobot_y ± 0.150, 1 Y-bar at cobot_x)
//   - Cobot mount flange (cylinder + accent disc) at the cobot mount XY
function AluminumCabin({ xMin, xMax, yMin, yMax, topZ, postSection, cobotMountX, cobotMountY }: {
  xMin: number; xMax: number; yMin: number; yMax: number;
  topZ: number; postSection: number;
  cobotMountX: number; cobotMountY: number;
}) {
  const xLen = xMax - xMin;
  const yLen = yMax - yMin;
  const xMid = (xMin + xMax) / 2;
  const yMid = (yMin + yMax) / 2;
  const postLen = topZ - postSection;
  const postCenterZ = postLen / 2;
  const topProfileCenterZ = topZ - postSection / 2;
  const profileUndersideZ = topZ - postSection;

  const aluMat = (
    <meshStandardMaterial color="#c8c8cc" metalness={0.65} roughness={0.4} />
  );

  return (
    <group>
      {/* 4 vertical posts */}
      {([[xMin, yMin], [xMax, yMin], [xMin, yMax], [xMax, yMax]] as [number, number][]).map(([x, y], i) => (
        <mesh key={`post${i}`} position={[x, y, postCenterZ]} castShadow>
          <boxGeometry args={[postSection, postSection, postLen]} />
          {aluMat}
        </mesh>
      ))}
      {/* Top perimeter frame (S, N along X; W, E along Y) */}
      <mesh position={[xMid, yMin, topProfileCenterZ]} castShadow>
        <boxGeometry args={[xLen, postSection, postSection]} />{aluMat}
      </mesh>
      <mesh position={[xMid, yMax, topProfileCenterZ]} castShadow>
        <boxGeometry args={[xLen, postSection, postSection]} />{aluMat}
      </mesh>
      <mesh position={[xMin, yMid, topProfileCenterZ]} castShadow>
        <boxGeometry args={[postSection, yLen, postSection]} />{aluMat}
      </mesh>
      <mesh position={[xMax, yMid, topProfileCenterZ]} castShadow>
        <boxGeometry args={[postSection, yLen, postSection]} />{aluMat}
      </mesh>
      {/* Bottom perimeter (2 long bars on S and N, low) */}
      <mesh position={[xMid, yMin, postSection / 2]} castShadow>
        <boxGeometry args={[xLen, postSection, postSection]} />{aluMat}
      </mesh>
      <mesh position={[xMid, yMax, postSection / 2]} castShadow>
        <boxGeometry args={[xLen, postSection, postSection]} />{aluMat}
      </mesh>
      {/* Cobot ceiling cross-beams: 2 X-bars at cobot_y ± 0.150 + 1 Y-bar (0.35 m) at cobot_x */}
      <mesh position={[xMid, cobotMountY - 0.150, topProfileCenterZ]} castShadow>
        <boxGeometry args={[xLen, postSection, postSection]} />{aluMat}
      </mesh>
      <mesh position={[xMid, cobotMountY + 0.150, topProfileCenterZ]} castShadow>
        <boxGeometry args={[xLen, postSection, postSection]} />{aluMat}
      </mesh>
      <mesh position={[cobotMountX, cobotMountY, topProfileCenterZ]} castShadow>
        <boxGeometry args={[postSection, 0.350, postSection]} />{aluMat}
      </mesh>
      {/* Cobot mount flange under the top profile (decorative — cobot is floor-mounted) */}
      <mesh position={[cobotMountX, cobotMountY, profileUndersideZ - 0.002]}
        rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.060, 0.060, 0.004, 24]} />
        <meshStandardMaterial color="#3a3f48" metalness={0.7} roughness={0.4} />
      </mesh>
      <mesh position={[cobotMountX, cobotMountY, profileUndersideZ - 0.005]}
        rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.062, 0.062, 0.006, 24]} />
        <meshStandardMaterial color="#22994a" metalness={0.4} roughness={0.5} />
      </mesh>
    </group>
  );
}

// ── Runtime collision detection ──────────────────────────────────────────────
// Conservative AABB-vs-AABB check: every cobot link's world-axis-aligned
// bounding box is tested against every COLLISION_BOX.  Reports the set of
// hit box names so the HMI can display them.
const COBOT_LINK_NAMES = [
  'base_link', 'link1_shoulder', 'link2_upper_arm', 'link3_forearm',
  'link4_wrist1', 'link5_wrist2', 'link6_wrist3',
  'gripper_base', 'stump_link', 'fixture_link', 'fixture1_link',
  'neck_link', 'appendage_link',
];

function collisionAABBs(): Array<{ name: string; box: THREE.Box3 }> {
  return COLLISION_BOXES.map((b) => ({
    name: b.name,
    box: new THREE.Box3(
      new THREE.Vector3(b.x - b.sx / 2, b.y - b.sy / 2, b.z - b.sz / 2),
      new THREE.Vector3(b.x + b.sx / 2, b.y + b.sy / 2, b.z + b.sz / 2),
    ),
  }));
}

// Compute the world AABB of THIS link only, NOT its descendants.  In the
// URDF tree every link is the parent of the joint to the next link, so
// setFromObject(link) would walk the whole subtree (e.g. base_link's box
// would contain the entire cobot).  We only union the link's own direct
// URDFVisual children (the actual STL meshes of that link).
function ownLinkBox(link: THREE.Object3D, out: THREE.Box3): boolean {
  out.makeEmpty();
  const tmp = new THREE.Box3();
  let any = false;
  for (const child of link.children) {
    if ((child as { isURDFVisual?: boolean }).isURDFVisual) {
      tmp.setFromObject(child);
      if (!tmp.isEmpty()) { out.union(tmp); any = true; }
    }
  }
  return any;
}

function checkCobotCollisions(
  robot: URDFRobot,
  obstacles: Array<{ name: string; box: THREE.Box3 }>,
): string[] {
  const hit = new Set<string>();
  const linkBox = new THREE.Box3();
  for (const linkName of COBOT_LINK_NAMES) {
    const link = robot.links[linkName];
    if (!link) continue;
    if (!ownLinkBox(link, linkBox)) continue;
    for (const ob of obstacles) {
      if (linkBox.intersectsBox(ob.box)) hit.add(ob.name);
    }
  }
  return Array.from(hit);
}

// ── Collision-zone overlay (toggle from HMI) ─────────────────────────────────
// Renders every COLLISION_BOX as a translucent coloured mesh + thin edge lines
// so the operator can visually identify the no-go zones the cobot must avoid.
function CollisionBoxes({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <group>
      {COLLISION_BOXES.map((b, i) => (
        <group key={i} position={[b.x, b.y, b.z]}>
          <mesh>
            <boxGeometry args={[b.sx, b.sy, b.sz]} />
            <meshBasicMaterial
              color={b.color ?? '#33dffe'}
              transparent opacity={0.18}
              depthWrite={false}
            />
          </mesh>
          <lineSegments>
            <edgesGeometry args={[new THREE.BoxGeometry(b.sx, b.sy, b.sz)]} />
            <lineBasicMaterial color={b.color ?? '#33dffe'} transparent opacity={0.9} />
          </lineSegments>
        </group>
      ))}
    </group>
  );
}

// ── World-coord label using <Html /> ─────────────────────────────────────────
function Label({ x, y, z, text, color = '#9fb' }: { x: number; y: number; z: number; text: string; color?: string }) {
  return (
    <Html position={[x, y, z]} center>
      <div style={{
        fontSize: 9, color, background: 'rgba(6,16,28,0.82)',
        border: `1px solid ${color}44`, padding: '2px 7px', borderRadius: 4,
        whiteSpace: 'nowrap', fontFamily: 'monospace', pointerEvents: 'none',
        letterSpacing: 0.4,
      }}>
        {text}
      </div>
    </Html>
  );
}

// ── Z-up camera bootstrap ────────────────────────────────────────────────────
function ZUpBootstrap() {
  const { camera, scene } = useThree();
  useEffect(() => {
    camera.up.set(0, 0, 1);
    scene.up.set(0, 0, 1);
    camera.lookAt(MESA_CENTRE[0], MESA_CENTRE[1], 1.0);
    camera.updateProjectionMatrix();
  }, [camera, scene]);
  return null;
}

// ── Side HMI panel (debug poses + joint readout) ─────────────────────────────
function HMIPanel({
  setPose,
  jointsRef,
  discAngleRef,
  setDiscAngle,
  gripperRef,
  gripperLiveRef,
  setGripper,
  gripperWorldRef,
  collisionsRef,
  showCollisions,
  toggleCollisions,
  jogJoint,
  savedPositions,
  saveCurrentPosition,
  loadSavedPosition,
  deleteSavedPosition,
  exportSavedPositions,
  clearSavedPositions,
  playerRef,
  cafiStateRef,
  playerPlay,
  playerPause,
  playerReset,
  cafiGraspYawRef,
  setCafiGraspYaw,
}: {
  setPose: (p: PoseName) => void;
  jointsRef: React.MutableRefObject<[number, number, number, number, number, number]>;
  discAngleRef: React.MutableRefObject<number>;
  setDiscAngle: (a: number) => void;
  gripperRef: React.MutableRefObject<number>;
  gripperLiveRef: React.MutableRefObject<number>;
  setGripper: (open: boolean) => void;
  gripperWorldRef: React.MutableRefObject<[number, number, number]>;
  collisionsRef: React.MutableRefObject<string[]>;
  showCollisions: boolean;
  toggleCollisions: () => void;
  jogJoint: (i: number, delta: number) => void;
  savedPositions: SavedPosition[];
  saveCurrentPosition: (name?: string) => void;
  loadSavedPosition: (i: number) => void;
  deleteSavedPosition: (i: number) => void;
  exportSavedPositions: () => void;
  clearSavedPositions: () => void;
  playerRef: React.MutableRefObject<PlayerState>;
  cafiStateRef: React.MutableRefObject<CafiState>;
  playerPlay: () => void;
  playerPause: () => void;
  playerReset: () => void;
  cafiGraspYawRef: React.MutableRefObject<number>;
  setCafiGraspYaw: (yaw: number) => void;
}) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(id);
  }, []);
  const j = jointsRef.current;
  const g = gripperWorldRef.current;
  const gripPct = (gripperLiveRef.current / GRIPPER_OPEN_M) * 100;
  const gripIsOpen = gripperRef.current > GRIPPER_OPEN_M / 2;
  const collisions = collisionsRef.current;
  return (
    <div style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, width: 300,
      background: 'linear-gradient(180deg, #0c1828 0%, #0a1422 100%)',
      borderLeft: '1px solid #1d2c44', padding: 14, color: '#dde4f0',
      overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12,
      zIndex: 25,
    }}>
      <div style={{ borderBottom: '1px solid #1d2c44', paddingBottom: 10 }}>
        <div style={{ fontSize: 8, letterSpacing: 4, color: '#22c55e', textTransform: 'uppercase' }}>
          V53 · URDF viewer
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>
          Schneider Riveting Cell
        </div>
      </div>

      {/* === Sequence player === */}
      <Section title="Cycle Sequence">
        {(() => {
          const p = playerRef.current;
          const step = SEQUENCE[p.step];
          const total = SEQUENCE.length;
          const progress = step && step.kind === 'pose' && step.duration > 0
            ? Math.min(1, p.t / step.duration)
            : step && step.kind === 'disc' && step.duration > 0
              ? Math.min(1, p.t / step.duration)
              : 0;
          const finished = p.step >= total;
          const label = finished
            ? '✓ Cycle complete'
            : step
              ? (step.label ?? (step.kind === 'pose'
                ? step.pose.replace('POSE_', '').replace(/_/g, ' ')
                : step.kind === 'gripper'
                  ? `Gripper ${step.open ? 'OPEN' : 'CLOSE'}`
                  : step.kind === 'cafi'
                    ? `CAFI → ${step.state}`
                    : step.kind === 'disc'
                      ? `Disc → ${(step.target * 180 / Math.PI).toFixed(0)}°`
                      : 'Waiting…'))
              : '—';
          return (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
                <button onClick={playerPlay}
                  disabled={p.playing}
                  style={{
                    ...btnStyle, padding: '8px 6px', fontSize: 11,
                    background: p.playing
                      ? 'linear-gradient(180deg,#3a4f6a 0%,#2a3548 100%)'
                      : 'linear-gradient(180deg,#22cc55 0%,#1aa044 100%)',
                    cursor: p.playing ? 'not-allowed' : 'pointer',
                  }}>▶ PLAY</button>
                <button onClick={playerPause}
                  disabled={!p.playing}
                  style={{
                    ...btnStyle, padding: '8px 6px', fontSize: 11,
                    background: !p.playing
                      ? 'linear-gradient(180deg,#3a4f6a 0%,#2a3548 100%)'
                      : 'linear-gradient(180deg,#f47835 0%,#d96416 100%)',
                    cursor: !p.playing ? 'not-allowed' : 'pointer',
                  }}>⏸ PAUSE</button>
                <button onClick={playerReset} style={{
                  ...btnStyle, padding: '8px 6px', fontSize: 11,
                  background: 'linear-gradient(180deg,#3b8bff 0%,#2563eb 100%)',
                }}>⏮ RESET</button>
              </div>
              <div style={{ ...statRow, marginTop: 8 }}>
                <span>step</span>
                <span>{finished ? `${total}/${total}` : `${p.step + 1}/${total}`}</span>
              </div>
              <div style={{ ...statRow }}>
                <span>now</span>
                <span style={{ color: '#9bf' }}>{label}</span>
              </div>
              <div style={{ ...statRow }}>
                <span>cafi</span>
                <span style={{ color: '#d97340' }}>{cafiStateRef.current}</span>
              </div>
              {/* progress bar */}
              <div style={{
                height: 6, background: '#1a2434', borderRadius: 3, marginTop: 6,
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', width: `${progress * 100}%`,
                  background: 'linear-gradient(90deg,#22dd55,#33dffe)',
                  transition: 'width 0.05s linear',
                }} />
              </div>
            </>
          );
        })()}
      </Section>

      {/* Pose buttons */}
      <Section title="Set Pose">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          {([
            'POSE_HOME', 'POSE_APPROACH_CONVEYOR',
            'POSE_PICK_CONVEYOR', 'POSE_LIFT_CONVEYOR',
            'POSE_APPROACH_LOAD_FIXTURE', 'POSE_PLACE_LOAD_FIXTURE',
            'POSE_RELEASE_LOAD_FIXTURE', 'POSE_PICK_RIVETED',
            'POSE_APPROACH_VISION', 'POSE_PLACE_VISION',
            'POSE_APPROACH_ACCEPT_BIN', 'POSE_DROP_ACCEPT_BIN',
            'POSE_APPROACH_REJECT_BIN', 'POSE_DROP_REJECT_BIN',
          ] as PoseName[]).map((p) => (
            <button key={p} onClick={() => setPose(p)} style={btnStyle}>
              {p.replace('POSE_', '').replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </Section>

      {/* Collision-zone toggle + live status */}
      <Section title="Collision Zones">
        <button onClick={toggleCollisions}
          style={{
            ...btnStyle,
            fontSize: 11, padding: '8px 10px',
            background: showCollisions
              ? 'linear-gradient(180deg,#33dffe 0%,#1ba0c0 100%)'
              : 'linear-gradient(180deg,#3a4f6a 0%,#2a3548 100%)',
          }}>
          {showCollisions ? '◉ HIDE' : '◯ SHOW'} ({COLLISION_BOXES.length} boxes)
        </button>
        <div style={{ ...statRow, marginTop: 8 }}>
          <span>status</span>
          <span style={{
            color: collisions.length > 0 ? '#ff5566' : '#22dd55',
            fontWeight: 700,
          }}>
            {collisions.length > 0 ? `✗ ${collisions.length} HIT` : '✓ CLEAR'}
          </span>
        </div>
        {collisions.length > 0 && (
          <div style={{
            marginTop: 4, padding: 6,
            background: 'rgba(80,20,20,0.4)',
            border: '1px solid #ff556644',
            borderRadius: 4,
            fontSize: 9, color: '#ff8090',
            fontFamily: 'monospace', lineHeight: 1.4,
          }}>
            {collisions.join(', ')}
          </div>
        )}
      </Section>

      {/* Gripper manual override */}
      <Section title="Gripper">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          <button onClick={() => setGripper(true)}
            style={{ ...btnStyle, background: gripIsOpen
              ? 'linear-gradient(180deg,#22cc55 0%,#1aa044 100%)'
              : 'linear-gradient(180deg,#3a4f6a 0%,#2a3548 100%)' }}>
            OPEN
          </button>
          <button onClick={() => setGripper(false)}
            style={{ ...btnStyle, background: !gripIsOpen
              ? 'linear-gradient(180deg,#f47835 0%,#d96416 100%)'
              : 'linear-gradient(180deg,#3a4f6a 0%,#2a3548 100%)' }}>
            CLOSE
          </button>
        </div>
        <div style={statRow}>
          <span>jaw</span>
          <span>{(gripperLiveRef.current * 1000).toFixed(1)} mm ({gripPct.toFixed(0)}%)</span>
        </div>
        {/* CAFI grasp yaw — spins the held workpiece around the gripper's
            tool axis without moving the cobot.  Only takes effect when the
            CAFI is in_gripper. */}
        <div style={{ marginTop: 8 }}>
          <div style={statRow}>
            <span>CAFI yaw</span>
            <span>{(cafiGraspYawRef.current * 180 / Math.PI).toFixed(1)}°</span>
          </div>
          <input type="range" min={-Math.PI} max={Math.PI} step={0.01}
            defaultValue={0}
            onInput={(e) => setCafiGraspYaw(parseFloat((e.target as HTMLInputElement).value))}
            style={{ width: '100%' }} />
        </div>
      </Section>

      {/* Disc rotation */}
      <Section title="Turntable">
        <input type="range" min={-Math.PI} max={Math.PI} step={0.01}
          defaultValue={0}
          onInput={(e) => setDiscAngle(parseFloat((e.target as HTMLInputElement).value))}
          style={{ width: '100%' }} />
        <div style={statRow}><span>angle</span><span>{(discAngleRef.current * 180 / Math.PI).toFixed(1)}°</span></div>
      </Section>

      {/* Telemetry */}
      <Section title="Telemetry (TCP world XYZ)">
        <div style={statRow}><span>x</span><span>{g[0].toFixed(3)} m</span></div>
        <div style={statRow}><span>y</span><span>{g[1].toFixed(3)} m</span></div>
        <div style={statRow}><span>z</span><span>{g[2].toFixed(3)} m</span></div>
      </Section>

      {/* Manual jog — 6 joints, ±0.001 / ±0.01 / ±0.1 / ±0.5 rad steps */}
      <Section title="Manual Jog (rad)">
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const v = j[i];
          const [lo, hi] = JOINT_LIMITS[i];
          const atLo = Math.abs(v - lo) < 1e-4;
          const atHi = Math.abs(v - hi) < 1e-4;
          return (
            <div key={i} style={{ marginBottom: 6 }}>
              <div style={statRow}>
                <span>j{i + 1}</span>
                <span style={{
                  color: atLo || atHi ? '#ff8080' : '#abc',
                }}>
                  {v >= 0 ? '+' : ''}{v.toFixed(3)} ({(v * 180 / Math.PI).toFixed(1)}°)
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2, marginTop: 2 }}>
                {[-0.5, -0.1, -0.01, -0.001, +0.001, +0.01, +0.1, +0.5].map((d) => (
                  <button key={d} onClick={() => jogJoint(i, d)} style={jogBtnStyle}>
                    {d > 0 ? '+' : ''}{Math.abs(d) >= 0.01 ? d : d.toFixed(3)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </Section>

      {/* Saved positions — teach-pendant style.  Persisted in localStorage. */}
      <Section title={`Saved Positions (${savedPositions.length})`}>
        <button onClick={() => saveCurrentPosition()} style={{
          ...btnStyle,
          fontSize: 11, padding: '8px 10px',
          background: 'linear-gradient(180deg,#22cc55 0%,#1aa044 100%)',
        }}>
          💾 SAVE current as pos{savedPositions.length + 1}
        </button>
        {savedPositions.map((p, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 4,
            marginTop: 4, alignItems: 'center',
          }}>
            <button onClick={() => loadSavedPosition(i)} style={{
              ...jogBtnStyle, textAlign: 'left', padding: '4px 6px',
              background: p.collisions.length > 0
                ? 'linear-gradient(180deg,#5a2030 0%,#3a1018 100%)'
                : 'linear-gradient(180deg,#2a3548 0%,#1a2434 100%)',
            }}>
              <div style={{ fontSize: 10, fontWeight: 700 }}>
                {p.name} {p.collisions.length > 0 ? '✗' : '✓'}
              </div>
              <div style={{ fontSize: 8, color: '#8090a0', fontFamily: 'monospace' }}>
                TCP ({p.tcp[0].toFixed(2)}, {p.tcp[1].toFixed(2)}, {p.tcp[2].toFixed(2)})
              </div>
            </button>
            <button onClick={() => deleteSavedPosition(i)} title="Delete"
              style={{ ...jogBtnStyle, padding: '4px 8px', background: '#3a1018' }}>
              ✕
            </button>
            <div style={{ width: 0 }} />
          </div>
        ))}
        {savedPositions.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 6 }}>
            <button onClick={exportSavedPositions} style={{
              ...jogBtnStyle, padding: '6px 8px',
              background: 'linear-gradient(180deg,#3b8bff 0%,#2563eb 100%)',
            }}>
              📋 COPY JSON
            </button>
            <button onClick={clearSavedPositions} style={{
              ...jogBtnStyle, padding: '6px 8px',
              background: 'linear-gradient(180deg,#5a2030 0%,#3a1018 100%)',
            }}>
              CLEAR ALL
            </button>
          </div>
        )}
      </Section>

      <div style={{ marginTop: 'auto', fontSize: 9, color: '#456', textAlign: 'center' }}>
        URDF loader · V53 meshes
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'rgba(20, 30, 48, 0.55)', border: '1px solid #1d2c44',
      borderRadius: 6, padding: 10,
    }}>
      <div style={{
        fontSize: 9, letterSpacing: 2, color: '#688',
        textTransform: 'uppercase', marginBottom: 8, fontWeight: 600,
      }}>{title}</div>
      {children}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, #b87333 0%, #8b5a25 100%)',
  color: '#fff', border: 'none', borderRadius: 4,
  padding: '6px 8px', fontSize: 9, fontWeight: 700,
  cursor: 'pointer', letterSpacing: 0.5, width: '100%',
};

const jogBtnStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg,#2a3548 0%,#1a2434 100%)',
  color: '#dde4f0', border: '1px solid #2a4060', borderRadius: 3,
  padding: '4px 2px', fontSize: 9, fontWeight: 600,
  cursor: 'pointer', letterSpacing: 0.2, fontFamily: 'monospace',
};

const statRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between',
  fontSize: 10, fontFamily: 'monospace', color: '#abc', padding: '2px 0',
};

// ── Root component ───────────────────────────────────────────────────────────
export default function CellViewer3D() {
  const jointsRef = useRef<[number, number, number, number, number, number]>([...POSE_LIB.POSE_HOME]);
  const discAngleRef = useRef(0);
  const gripperRef = useRef<number>(GRIPPER_OPEN_M);        // target
  const gripperLiveRef = useRef<number>(GRIPPER_OPEN_M);    // animated
  const gripperWorldRef = useRef<[number, number, number]>([0, 0, 0]);
  const collisionsRef = useRef<string[]>([]);
  const [showCollisions, setShowCollisions] = useState(false);
  const [savedPositions, setSavedPositions] = useState<SavedPosition[]>(loadSavedFromStorage);
  const cafiStateRef = useRef<CafiState>('conveyor');
  const cobotRobotRef = useRef<URDFRobot | null>(null);
  const turntableRobotRef = useRef<URDFRobot | null>(null);
  const cafiGraspYawRef = useRef<number>(0);
  const setCafiGraspYaw = (yaw: number) => { cafiGraspYawRef.current = yaw; };
  const playerRef = useRef<PlayerState>({
    playing: false,
    step: 0,
    t: 0,
    startJoints: [...POSE_LIB.POSE_HOME] as PlayerState['startJoints'],
    startDisc: 0,
  });
  const [, forcePlayerTick] = useState(0); // re-render HMI when player advances

  // Player controls — mutate playerRef and bump the HMI re-render.
  const playerPlay = () => {
    if (playerRef.current.step >= SEQUENCE.length) {
      // auto-reset before re-playing if already done
      playerReset();
    }
    playerRef.current.playing = true;
    forcePlayerTick((n) => n + 1);
  };
  const playerPause = () => {
    playerRef.current.playing = false;
    forcePlayerTick((n) => n + 1);
  };
  const playerReset = () => {
    playerRef.current = {
      playing: false,
      step: 0,
      t: 0,
      startJoints: [...POSE_LIB.POSE_HOME] as PlayerState['startJoints'],
      startDisc: 0,
    };
    jointsRef.current = [...POSE_LIB.POSE_HOME] as typeof jointsRef.current;
    discAngleRef.current = 0;
    gripperRef.current = GRIPPER_OPEN_M;
    cafiStateRef.current = 'conveyor';
    forcePlayerTick((n) => n + 1);
  };

  const setPose = (p: PoseName) => {
    jointsRef.current = [...POSE_LIB[p]] as typeof jointsRef.current;
    // Auto-set the gripper open/closed state for this pose (pick & place).
    gripperRef.current = GRIPPER_OPEN_AT_POSE[p] ? GRIPPER_OPEN_M : GRIPPER_CLOSED_M;
  };
  const setDiscAngle = (a: number) => { discAngleRef.current = a; };
  const setGripper = (open: boolean) => {
    gripperRef.current = open ? GRIPPER_OPEN_M : GRIPPER_CLOSED_M;
  };

  // Manual jog: nudge one joint by delta rad, clamped to the URDF limit.
  const jogJoint = (i: number, delta: number) => {
    const [lo, hi] = JOINT_LIMITS[i];
    const next = Math.max(lo, Math.min(hi, jointsRef.current[i] + delta));
    jointsRef.current[i] = next;
  };

  // Save the current cobot state (joints + disc + gripper + TCP + collisions)
  // as a SavedPosition.  Auto-names "pos1", "pos2", ... unless a name is given.
  const saveCurrentPosition = (name?: string) => {
    const auto = name && name.trim()
      ? name.trim()
      : `pos${savedPositions.length + 1}`;
    const entry: SavedPosition = {
      name: auto,
      joints: [...jointsRef.current] as SavedPosition['joints'],
      disc: discAngleRef.current,
      gripper: gripperRef.current,
      tcp: [...gripperWorldRef.current] as SavedPosition['tcp'],
      collisions: [...collisionsRef.current],
      timestamp: new Date().toISOString(),
    };
    const next = [...savedPositions, entry];
    setSavedPositions(next);
    persistSaved(next);
  };

  const loadSavedPosition = (i: number) => {
    const p = savedPositions[i];
    if (!p) return;
    jointsRef.current = [...p.joints] as typeof jointsRef.current;
    discAngleRef.current = p.disc;
    gripperRef.current = p.gripper;
  };

  const deleteSavedPosition = (i: number) => {
    const next = savedPositions.filter((_, idx) => idx !== i);
    setSavedPositions(next);
    persistSaved(next);
  };

  const exportSavedPositions = () => {
    const json = JSON.stringify(savedPositions, null, 2);
    try { navigator.clipboard.writeText(json); } catch { /* ignore */ }
    // Also log so the user can copy from devtools as a fallback.
    // eslint-disable-next-line no-console
    console.log('%c[Saved positions JSON]', 'color:#22dd55;font-weight:700', json);
  };

  const clearSavedPositions = () => {
    if (!window.confirm(`Delete all ${savedPositions.length} saved positions?`)) return;
    setSavedPositions([]);
    persistSaved([]);
  };

  return (
    <div style={{ background: '#07111e', borderTop: '1px solid #1a3550', borderBottom: '1px solid #1a3550' }}>
      <div style={{ padding: '32px 24px 16px', textAlign: 'center' }}>
        <div style={{ fontSize: 9, letterSpacing: 5, color: '#22c55e', textTransform: 'uppercase', marginBottom: 8 }}>
          Gemelo Digital · Visualizador V53
        </div>
        <div style={{ fontSize: 'clamp(20px,3vw,30px)', fontWeight: 700, color: '#f1f5f9' }}>
          Schneider Cell · URDF Loader
        </div>
        <div style={{ fontSize: 12, color: '#2a4060', marginTop: 8 }}>
          URDF V53 (lexium_cobot_with_final_gripper + turntable_rivet_cell) · Z-up scene
        </div>
      </div>

      <div style={{ height: '80vh', position: 'relative', maxWidth: 1500, margin: '0 auto' }}>
        <Canvas
          shadows
          camera={{ position: [3.4, -2.0, 2.2], fov: 42, near: 0.05, far: 50, up: [0, 0, 1] }}
          style={{ background: '#07111e' }}
          gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
        >
          <ZUpBootstrap />

          <ambientLight intensity={0.55} />
          <directionalLight
            position={[3, 3, 5]} intensity={1.2} castShadow
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

          <Suspense fallback={null}>
            <CellPrimitives />
            <Cobot
              jointsRef={jointsRef}
              gripperRef={gripperRef}
              gripperLiveRef={gripperLiveRef}
              gripperWorldRef={gripperWorldRef}
              collisionsRef={collisionsRef}
              robotRef={cobotRobotRef}
            />
            <Turntable angleRef={discAngleRef} robotRef={turntableRobotRef} />
            <CafiMesh
              stateRef={cafiStateRef}
              cobotRobotRef={cobotRobotRef}
              turntableRobotRef={turntableRobotRef}
              graspYawRef={cafiGraspYawRef}
            />
          </Suspense>

          <SequencePlayer
            playerRef={playerRef}
            jointsRef={jointsRef}
            discAngleRef={discAngleRef}
            gripperRef={gripperRef}
            cafiStateRef={cafiStateRef}
          />

          <CollisionBoxes visible={showCollisions} />

          <Label x={1.152} y={0.940} z={1.10}  text="Lexium Cobot"    color="#60a5fa" />
          <Label x={1.370} y={1.420} z={1.18}  text="Conveyor 1"      color="#fbbf24" />
          <Label x={0.692} y={1.259} z={1.18}  text="Turntable"       color="#a78bfa" />
          <Label x={0.692} y={1.409} z={1.42}  text="Riveting"        color="#fb923c" />
          <Label x={0.750} y={0.804} z={1.10}  text="Vision"          color="#a78bfa" />
          <Label x={0.750} y={0.804} z={1.62}  text="Cognex 2800"     color="#e879f9" />
          <Label x={1.650} y={0.720} z={1.18}  text="Aceptado"        color="#22dd55" />
          <Label x={1.330} y={0.700} z={1.18}  text="Rechazado"       color="#ff5566" />
          <Label x={0.684} y={0.462} z={1.30}  text="Control Station" color="#38bdf8" />
        </Canvas>

        <HMIPanel
          setPose={setPose}
          jointsRef={jointsRef}
          discAngleRef={discAngleRef}
          setDiscAngle={setDiscAngle}
          gripperRef={gripperRef}
          gripperLiveRef={gripperLiveRef}
          setGripper={setGripper}
          gripperWorldRef={gripperWorldRef}
          collisionsRef={collisionsRef}
          showCollisions={showCollisions}
          toggleCollisions={() => setShowCollisions((s) => !s)}
          jogJoint={jogJoint}
          savedPositions={savedPositions}
          saveCurrentPosition={saveCurrentPosition}
          loadSavedPosition={loadSavedPosition}
          deleteSavedPosition={deleteSavedPosition}
          exportSavedPositions={exportSavedPositions}
          clearSavedPositions={clearSavedPositions}
          playerRef={playerRef}
          cafiStateRef={cafiStateRef}
          playerPlay={playerPlay}
          playerPause={playerPause}
          playerReset={playerReset}
          cafiGraspYawRef={cafiGraspYawRef}
          setCafiGraspYaw={setCafiGraspYaw}
        />
      </div>
    </div>
  );
}

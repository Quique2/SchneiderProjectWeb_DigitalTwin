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

// V53 world anchors (from schneider_cell.urdf.xacro, all in metres, Z up).
const COBOT_BASE     : [number, number, number] = [1.152, 1.049, 1.000];
const TURNTABLE_BASE : [number, number, number] = [0.692, 1.259, 1.000];
const MESA_CENTRE    : [number, number, number] = [1.252205, 1.049061, 1.000];

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
}

const GRIPPER_SPEED = 0.04; // m/s (URDF velocity limit is 0.08)

function Cobot({ jointsRef, gripperRef, gripperLiveRef, gripperWorldRef }: CobotProps) {
  const robot = useUrdf('/urdf/lexium_cobot.urdf');
  const groupRef = useRef<THREE.Group>(null);

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

    const tcp = robot.frames['tcp_link'];
    if (tcp) {
      const v = new THREE.Vector3();
      tcp.getWorldPosition(v);
      gripperWorldRef.current = [v.x, v.y, v.z];
    }
  });

  if (!robot) return null;
  return (
    <group ref={groupRef} position={COBOT_BASE}>
      <primitive object={robot} />
    </group>
  );
}

// ── Turntable (loaded URDF, disc-driven) ─────────────────────────────────────
function Turntable({ angleRef }: { angleRef: React.MutableRefObject<number> }) {
  const robot = useUrdf('/urdf/turntable_rivet_cell.urdf');
  useFrame(() => {
    if (!robot) return;
    robot.setJointValue('table_rotation_joint', angleRef.current);
  });
  if (!robot) return null;
  return (
    <group position={TURNTABLE_BASE}>
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

      {/* Riveting station canopy (V53: 0.450 x 0.300 x 0.350, anchored at (0.692, 1.259, 1.000) with y_offset 0.200) */}
      <RivetingCanopy ax={0.692} ay={1.259 + 0.200} az={1.000} sx={0.450} sy={0.300} height={0.350} />

      {/* Control station box (V53: 0.483 x 0.254 x 1.200 @ (0.684, 0.462)) */}
      <mesh position={[0.684, 0.462, 0.600]} castShadow receiveShadow>
        <boxGeometry args={[0.483, 0.254, 1.200]} />
        <meshStandardMaterial color="#3a3f48" metalness={0.5} roughness={0.6} />
      </mesh>

      {/* Operator chair (seat + back + 4 legs) */}
      <OperatorChair x={0.684} y={0.150} sx={0.400} sy={0.300} seatTopZ={0.500} backH={0.400} legR={0.018} />

      {/* Aluminum cabin (4 corner posts + top frame, decorative) */}
      <AluminumCabin xMin={0.30} xMax={2.20} yMin={0.30} yMax={1.80} topZ={2.070} />
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
  return (
    <>
      <mesh position={[cx, cy, topZ - thickness / 2]} castShadow receiveShadow>
        <boxGeometry args={[sx, sy, thickness]} />
        <meshStandardMaterial color="#6a7080" metalness={0.4} roughness={0.55} />
      </mesh>
      {[[+lx, +ly], [+lx, -ly], [-lx, +ly], [-lx, -ly]].map(([dx, dy], i) => (
        <mesh key={i} position={[cx + dx, cy + dy, legZ]} castShadow>
          <boxGeometry args={[legSect, legSect, legH]} />
          <meshStandardMaterial color="#4a4f58" metalness={0.5} roughness={0.6} />
        </mesh>
      ))}
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

function RivetingCanopy({ ax, ay, az, sx, sy, height }: { ax: number; ay: number; az: number; sx: number; sy: number; height: number }) {
  const wallT = 0.01;
  const topZ = az + height;
  return (
    <group>
      {/* Top canopy plate */}
      <mesh position={[ax, ay, topZ]} castShadow receiveShadow>
        <boxGeometry args={[sx, sy, wallT]} />
        <meshStandardMaterial color="#7a8090" metalness={0.4} roughness={0.6} transparent opacity={0.6} />
      </mesh>
      {/* 4 vertical posts at corners */}
      {[[+1, +1], [+1, -1], [-1, +1], [-1, -1]].map(([dx, dy], i) => (
        <mesh key={i}
          position={[ax + (dx * (sx / 2 - 0.01)), ay + (dy * (sy / 2 - 0.01)), az + height / 2]}
          castShadow>
          <boxGeometry args={[0.020, 0.020, height]} />
          <meshStandardMaterial color="#5a606a" metalness={0.6} roughness={0.5} />
        </mesh>
      ))}
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

function AluminumCabin({ xMin, xMax, yMin, yMax, topZ }: { xMin: number; xMax: number; yMin: number; yMax: number; topZ: number }) {
  const postSect = 0.050;
  const corners: [number, number][] = [
    [xMin, yMin], [xMin, yMax], [xMax, yMin], [xMax, yMax],
  ];
  const topFrame: [[number, number], [number, number]][] = [
    [[xMin, yMin], [xMax, yMin]], // S edge
    [[xMin, yMax], [xMax, yMax]], // N edge
    [[xMin, yMin], [xMin, yMax]], // W edge
    [[xMax, yMin], [xMax, yMax]], // E edge
  ];
  return (
    <group>
      {corners.map(([cx, cy], i) => (
        <mesh key={`p${i}`} position={[cx, cy, topZ / 2]} castShadow>
          <boxGeometry args={[postSect, postSect, topZ]} />
          <meshStandardMaterial color="#8a909a" metalness={0.6} roughness={0.45} />
        </mesh>
      ))}
      {topFrame.map(([[ax, ay], [bx, by]], i) => {
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        const len = Math.hypot(bx - ax, by - ay);
        const isHoriz = Math.abs(bx - ax) > Math.abs(by - ay);
        return (
          <mesh key={`b${i}`} position={[mx, my, topZ]} castShadow>
            <boxGeometry args={[isHoriz ? len : postSect, isHoriz ? postSect : len, postSect]} />
            <meshStandardMaterial color="#8a909a" metalness={0.6} roughness={0.45} />
          </mesh>
        );
      })}
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
}: {
  setPose: (p: PoseName) => void;
  jointsRef: React.MutableRefObject<[number, number, number, number, number, number]>;
  discAngleRef: React.MutableRefObject<number>;
  setDiscAngle: (a: number) => void;
  gripperRef: React.MutableRefObject<number>;
  gripperLiveRef: React.MutableRefObject<number>;
  setGripper: (open: boolean) => void;
  gripperWorldRef: React.MutableRefObject<[number, number, number]>;
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

      <Section title="Joints (rad)">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} style={statRow}><span>j{i + 1}</span><span>{j[i].toFixed(3)}</span></div>
        ))}
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

  const setPose = (p: PoseName) => {
    jointsRef.current = [...POSE_LIB[p]] as typeof jointsRef.current;
    // Auto-set the gripper open/closed state for this pose (pick & place).
    gripperRef.current = GRIPPER_OPEN_AT_POSE[p] ? GRIPPER_OPEN_M : GRIPPER_CLOSED_M;
  };
  const setDiscAngle = (a: number) => { discAngleRef.current = a; };
  const setGripper = (open: boolean) => {
    gripperRef.current = open ? GRIPPER_OPEN_M : GRIPPER_CLOSED_M;
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
            />
            <Turntable angleRef={discAngleRef} />
          </Suspense>

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
        />
      </div>
    </div>
  );
}

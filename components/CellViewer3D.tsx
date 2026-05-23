import React, { Suspense, useMemo, useRef, useCallback } from 'react';
import { Canvas, useLoader, useFrame } from '@react-three/fiber';
import { OrbitControls, Html, Grid } from '@react-three/drei';
import * as THREE from 'three';
import { STLLoader } from 'three-stdlib';

import { SimStoreProvider, useSimStore } from './cell/store';
import { useSimulation } from './cell/useSimulation';
import HMIPanel from './cell/HMIPanel';
import {
  CAFI_LX, CAFI_LY, CAFI_LZ,
  DISC_CENTER_X, DISC_CENTER_Y, MESA_TOP_Z, DISC_TOP_Z,
} from './cell/constants';
import type { JointAngles6 } from './cell/poses';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const VISUALS: Visual[] = require('../assets/cell_visuals_world.json');

// ── Lexium Cobot kinematic chain (built from the user's URDF) ────────────────
// Source: C:\Users\kiki7\Downloads\Cobot_URDFBUENO\lexium_cobot_l03s.urdf
// The URDF uses SW global coordinates throughout: each link's visual origin
// is the NEGATIVE of the cumulative joint position in base_link, so all mesh
// vertices end up at their SW global positions when joints are at zero.
// File order matches the URDF mesh references (link1_connector is unused).
const COBOT_STL_FILES = [
  '/meshes/link0_base.STL',              // [0]  base_link
  '/meshes/link1_shoulder_rotation.STL', // [1]  link1_shoulder
  '/meshes/link2_shoulder_connector.STL',// [2]  link2_upper_arm (part 1)
  '/meshes/link2_elbow_joint.STL',       // [3]  link2_upper_arm (part 2)
  '/meshes/link3_elbow_connector.STL',   // [4]  link2_upper_arm (part 3)
  '/meshes/link3_forearm.STL',           // [5]  link3_forearm (part 1)
  '/meshes/link6_wrist3_cylinder.STL',   // [6]  link3_forearm (part 2)
  '/meshes/link5_wrist2_body.STL',       // [7]  link3_forearm (part 3)
  '/meshes/link4_wrist1_cylinder.STL',   // [8]  link4_wrist1 (part 1)
  '/meshes/link5_wrist2_cylinder.STL',   // [9]  link4_wrist1 (part 2)
  '/meshes/link6_wrist3_upper_body.STL', // [10] link5_wrist2
  '/meshes/link6_tool_flange.STL',       // [11] link6_wrist3
];
const GRIPPER_STL_FILES = [
  '/meshes/new_gripper_stump.STL',
  '/meshes/new_gripper_neck.STL',
  '/meshes/new_gripper_appendage.STL',
  '/meshes/new_gripper_fixture.STL',
  '/meshes/new_gripper_fixture1.STL',
];

// ── Types ─────────────────────────────────────────────────────────────────────
interface Visual {
  name: string;
  kind: 'box' | 'cyl' | 'sphere' | 'stl';
  world_xyz: [number, number, number];
  world_rot: number[][];
  sx?: number; sy?: number; sz?: number;
  radius?: number; height?: number;
  rot_axis?: string;
  mesh?: string;
  visual_xyz?: [number, number, number];
  visual_rpy?: [number, number, number];
  scale?: number;
  rgba?: [number, number, number, number];
}

// ── Coordinate transform helpers ──────────────────────────────────────────────
// ROS world: X=east, Y=north, Z=up
// Three.js:  X=east, Y=up,   Z=south
const CX = 1.252205, CY = 1.049061;

function tPos(wx: number, wy: number, wz: number): [number, number, number] {
  return [wx - CX, wz, -(wy - CY)];
}

// T = [[1,0,0],[0,0,1],[0,-1,0]]  (ROS→Three.js axis mapping)
// R_3js = T @ R_ros @ T^T
// Closed-form: R_3js = [[m00,m02,-m01],[m20,m22,-m21],[-m10,-m12,m11]]
function rosMatToThree(R: number[][]): THREE.Matrix4 {
  const [r0, r1, r2] = R;
  return new THREE.Matrix4().set(
     r0[0],  r0[2], -r0[1], 0,
     r2[0],  r2[2], -r2[1], 0,
    -r1[0], -r1[2],  r1[1], 0,
         0,      0,       0, 1
  );
}

// Cylinders with rot_axis store their FK orientation with the cylinder's long
// axis along local X of the link frame.  Three.js CylinderGeometry is along Y,
// so we right-multiply by Rz(-90°) to re-align.
const _RZ_NEG90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);

function rosRotToQuat(R: number[][], rotAxis?: string): THREE.Quaternion {
  const q = new THREE.Quaternion().setFromRotationMatrix(rosMatToThree(R));
  if (rotAxis) q.multiply(_RZ_NEG90);
  return q;
}

// For STL: apply visual_xyz offset (rotated by link frame) for position.
// V51: any STL with a visual_rpy gets that rotation applied (Z→Y / X swaps).
function stlTransform(v: Visual) {
  const R = v.world_rot;
  const vx = v.visual_xyz ?? [0, 0, 0];
  // For grippers: tool0 local-Z points west (-ROS X), so vx[2]=0.083 adds
  // -0.083 m in world X.  Zero that component to keep gripper aligned east-west.
  const vx2 = v.name.startsWith('new_gripper') ? 0 : vx[2];
  const wx = v.world_xyz[0] + R[0][0]*vx[0] + R[0][1]*vx[1] + R[0][2]*vx2;
  const wy = v.world_xyz[1] + R[1][0]*vx[0] + R[1][1]*vx[1] + R[1][2]*vx2;
  const wz = v.world_xyz[2] + R[2][0]*vx[0] + R[2][1]*vx[1] + R[2][2]*vx2;
  const pos = tPos(wx, wy, wz);
  if (v.name.startsWith('new_gripper')) pos[0] += 0.0675;
  const quat = rosRotToQuat(R);
  // Apply visual_rpy X-rotation (Rx) if specified. V51 fixture/CAFI STLs
  // use rpy=(π/2,0,0) to swap Y/Z axes.
  if (v.visual_rpy && v.visual_rpy[0]) {
    quat.multiply(new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), v.visual_rpy[0]
    ));
  }
  return { pos, quat };
}

// ── Primitive components ───────────────────────────────────────────────────────
function VisMat({ rgba }: { rgba?: [number,number,number,number] }) {
  const [r, g, b, a] = rgba ?? [0.65, 0.67, 0.70, 1.0];
  return (
    <meshStandardMaterial
      color={new THREE.Color(r, g, b)}
      transparent={a < 1}
      opacity={a}
      roughness={0.55}
      metalness={0.08}
      polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1}
    />
  );
}

function BoxMesh({ v }: { v: Visual }) {
  const pos = tPos(...v.world_xyz);
  const quat = rosRotToQuat(v.world_rot);
  // In Three.js local frame: width=sx (ROS X), height=sz (ROS Z→Y), depth=sy (ROS Y→Z)
  return (
    <mesh position={pos} quaternion={quat} castShadow receiveShadow>
      <boxGeometry args={[v.sx!, v.sz!, v.sy!]} />
      <VisMat rgba={v.rgba} />
    </mesh>
  );
}

function CylMesh({ v }: { v: Visual }) {
  const pos = tPos(...v.world_xyz);
  const quat = rosRotToQuat(v.world_rot, v.rot_axis);
  return (
    <mesh position={pos} quaternion={quat} castShadow>
      <cylinderGeometry args={[v.radius!, v.radius!, v.height!, 28]} />
      <VisMat rgba={v.rgba} />
    </mesh>
  );
}

function SphereMesh({ v }: { v: Visual }) {
  const pos = tPos(...v.world_xyz);
  return (
    <mesh position={pos} castShadow>
      <sphereGeometry args={[v.radius!, 20, 20]} />
      <VisMat rgba={v.rgba} />
    </mesh>
  );
}

function STLMeshInner({ v }: { v: Visual }) {
  const geometry = useLoader(STLLoader, v.mesh!);
  const { pos, quat } = useMemo(() => stlTransform(v), [v]);
  const sc = v.scale ?? 0.001;
  const [r, g, b] = v.rgba ?? [0.65, 0.68, 0.72];
  return (
    <mesh geometry={geometry} position={pos} quaternion={quat} scale={[sc, sc, sc]} castShadow>
      <meshStandardMaterial color={new THREE.Color(r, g, b)} roughness={0.45} metalness={0.12} />
    </mesh>
  );
}

function STLMeshSafe({ v }: { v: Visual }) {
  return <Suspense fallback={null}><STLMeshInner v={v} /></Suspense>;
}

function VisualElement({ v }: { v: Visual }) {
  if (v.kind === 'box')    return <BoxMesh v={v} />;
  if (v.kind === 'cyl')    return <CylMesh v={v} />;
  if (v.kind === 'sphere') return <SphereMesh v={v} />;
  if (v.kind === 'stl')    return <STLMeshSafe v={v} />;
  return null;
}

// ── Lexium Cobot kinematic chain (12 cobot STLs + 5 gripper STLs) ────────────
interface JointAngles {
  j1: number; j2: number; j3: number;
  j4: number; j5: number; j6: number;
}

function CobotLink({
  geometry, position, color,
}: {
  geometry: THREE.BufferGeometry;
  position: [number, number, number];
  color: THREE.Color;
}) {
  return (
    <mesh geometry={geometry} position={position} scale={[0.001, 0.001, 0.001]} castShadow>
      <meshStandardMaterial color={color} metalness={0.35} roughness={0.5} />
    </mesh>
  );
}

function CobotChain({
  basePos, baseYaw, jointAngles, gripperRef,
}: {
  basePos: [number, number, number];   // world position of the j1 axis (mount + 87mm Y)
  baseYaw: number;                       // rotation around the j1 axis (Y)
  jointAngles: JointAngles;
  gripperRef?: React.MutableRefObject<THREE.Group | null>;
}) {
  const cobotStls = useLoader(STLLoader, COBOT_STL_FILES);
  const gripperStls = useLoader(STLLoader, GRIPPER_STL_FILES);
  const { j1, j2, j3, j4, j5, j6 } = jointAngles;

  const linkColor    = useMemo(() => new THREE.Color(0.40, 0.40, 0.45), []);
  const baseColor    = useMemo(() => new THREE.Color(0.25, 0.25, 0.28), []);
  const gripperColor = useMemo(() => new THREE.Color(0.70, 0.70, 0.74), []);

  // Joint chain straight from the URDF (lexium_cobot_l03s.urdf):
  //   joint   origin in parent frame                rpy                axis
  //   j1      ( 0.1623,  0.0867,  0.0645)           (0, 0, 0)          Y  azimuth
  //   j2      (-0.0115,  0.0639,  0.0000)           (0, 0, 0.05)       Z  shoulder
  //   j3      (-0.0015,  0.2450,  0.2258)           (0, 0, 0)          Z  elbow
  //   j4      (-0.0060,  0.2295,  0.1244)           (0, 0, 0)          Z  wrist1
  //   j5      (-0.0010,  0.0465, -0.2300)           (0, 0, 0)          Y  wrist2
  //   j6      (-0.0040,  0.0720,  0.0898)           (0, 0, 0)          Z  wrist3
  //   tool0   ( 0.0000,  0.0680,  0.0000)           (0, 0, 0)          fixed
  //
  // Each link's visual origin is the negative of the cumulative joint position
  // (so the SW-global mesh vertices end up at their assembled location).
  //
  // basePos is the world position of the j1 axis. Inside the outer group an
  // extra offset of (-0.1623, -0.0867, -0.0645) puts base_link's frame so the
  // j1 axis coincides with the outer group's origin -> baseYaw rotates the
  // whole cobot around the actual mounting axis.

  return (
    <group position={basePos} rotation={[0, baseYaw, 0]}>
      <group position={[-0.1623, -0.0867, -0.0645]}>
        {/* base_link (mesh at the link origin = SW global origin) */}
        <CobotLink geometry={cobotStls[0]} position={[0, 0, 0]} color={baseColor} />

        {/* joint 1 — Y axis (azimuth) */}
        <group position={[0.1623, 0.0867, 0.0645]} rotation={[0, j1, 0]}>
          <CobotLink geometry={cobotStls[1]}
            position={[-0.1623, -0.0867, -0.0645]} color={linkColor} />

          {/* joint 2 — Z axis (shoulder elevation), static yaw 0.05 + j2 */}
          <group position={[-0.0115, 0.0639, 0]} rotation={[0, 0, 0.05 + j2]}>
            <CobotLink geometry={cobotStls[2]}
              position={[-0.1508, -0.1506, -0.0645]} color={linkColor} />
            <CobotLink geometry={cobotStls[3]}
              position={[-0.1508, -0.1506, -0.0645]} color={linkColor} />
            <CobotLink geometry={cobotStls[4]}
              position={[-0.1508, -0.1506, -0.0645]} color={linkColor} />

            {/* joint 3 — Z axis (elbow) */}
            <group position={[-0.0015, 0.2450, 0.2258]} rotation={[0, 0, j3]}>
              <CobotLink geometry={cobotStls[5]}
                position={[-0.1493, -0.3956, -0.2903]} color={linkColor} />
              <CobotLink geometry={cobotStls[6]}
                position={[-0.1493, -0.3956, -0.2903]} color={linkColor} />
              <CobotLink geometry={cobotStls[7]}
                position={[-0.1493, -0.3956, -0.2903]} color={linkColor} />

              {/* joint 4 — Z axis (wrist1) */}
              <group position={[-0.0060, 0.2295, 0.1244]} rotation={[0, 0, j4]}>
                <CobotLink geometry={cobotStls[8]}
                  position={[-0.1433, -0.6251, -0.4147]} color={linkColor} />
                <CobotLink geometry={cobotStls[9]}
                  position={[-0.1433, -0.6251, -0.4147]} color={linkColor} />

                {/* joint 5 — Y axis (wrist2) */}
                <group position={[-0.0010, 0.0465, -0.2300]} rotation={[0, j5, 0]}>
                  <CobotLink geometry={cobotStls[10]}
                    position={[-0.1423, -0.6716, -0.1847]} color={linkColor} />

                  {/* joint 6 — Z axis (wrist3) */}
                  <group position={[-0.0040, 0.0720, 0.0898]} rotation={[0, 0, j6]}>
                    <CobotLink geometry={cobotStls[11]}
                      position={[-0.1383, -0.7436, -0.2745]} color={baseColor} />

                    {/*
                      Gripper aligned with the flange COM in Z, then nudged
                      +20mm further in +Z to clear the flange surface.

                      Volume-weighted COMs:
                        link6_tool_flange COM (joint6Group):  (-0.91, -1.06, -2.30) mm
                        new_gripper_stump COM (gripper local): (172.21, 80.25, 71.15) mm

                      Rx(-π/2) maps gripper local (X, Y, Z) -> (X, Z, -Y).
                      position.z = 0.07795 (COM-aligned) + 0.020 = 0.09795
                    */}
                    <group>
                      {gripperStls.map((g, i) => (
                        <mesh
                          key={i}
                          geometry={g}
                          scale={[0.001, 0.001, 0.001]}
                          position={[-0.1722, -0.0712, 0.09795]}
                          rotation={[-Math.PI / 2, 0, 0]}
                          castShadow
                        >
                          <meshStandardMaterial
                            color={gripperColor}
                            metalness={0.3}
                            roughness={0.4}
                          />
                        </mesh>
                      ))}
                    </group>
                    {/*
                      Grasp-center marker. The CAFI in_gripper is attached here.
                      In gripper local frame the grasp center is around
                      (160, 40, 85)mm (middle of the fingers, X centered).
                      After Rx(-π/2) [gripper Y→ -Z, Z→ Y] and offset:
                        (160, 85, -40)mm = (0.160, 0.085, -0.040) m
                        + position(-0.1722, -0.0712, 0.09795)
                        = (-0.012, 0.014, 0.058)m in joint6Group
                    */}
                    <group ref={gripperRef} position={[-0.012, 0.014, 0.058]} />

                    {/* tool0 URDF frame (kept for reference, not used for gripper) */}
                    <group position={[0, 0.068, 0]} />
                  </group>
                </group>
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}

// ── Floor grid (ROS world origin offset) ─────────────────────────────────────
function FloorGrid() {
  return (
    <Grid
      args={[6, 6]}
      position={[0, 0.002, 0]}
      cellSize={0.25} cellThickness={0.4} cellColor="#0f1e30"
      sectionSize={1} sectionThickness={0.8} sectionColor="#162840"
      fadeDistance={8} infiniteGrid={false}
    />
  );
}

// ── Reach circle around cobot base ────────────────────────────────────────────
// V51: cobot mounted at (1.152, 1.049, 1.000) per schneider_cell.urdf.xacro
function ReachCircle() {
  const lineLoop = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const [cx, cy, cz] = tPos(1.152, 1.049, 1.010);
    const R = 0.626;
    for (let i = 0; i <= 80; i++) {
      const a = (i / 80) * Math.PI * 2;
      pts.push(new THREE.Vector3(cx + Math.cos(a) * R, cy, cz + Math.sin(a) * R));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: '#22c55e', transparent: true, opacity: 0.4 });
    return new THREE.LineLoop(geo, mat);
  }, []);
  return <primitive object={lineLoop} />;
}

// ── HTML label ────────────────────────────────────────────────────────────────
function Label({ wx, wy, wz, text, color = '#e2e8f0' }: {
  wx: number; wy: number; wz: number; text: string; color?: string;
}) {
  return (
    <Html position={tPos(wx, wy, wz)} center>
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

// ── Full cell scene ───────────────────────────────────────────────────────────
// CAFI rendered with the real cafi.STL mesh (V51).
// STL bbox in mm: X[0, 122.9] Y[0, 25.1] Z[0, 87.3]
//   X=123 → length along belt; Y=25 → thickness (vertical); Z=87 → depth on belt
// Three.js is already +Y up so no rotation needed. We just centre the mesh
// inside a wrapper group: the wrapper holds the world position+yaw, the
// inner mesh is offset by half-bbox so its centre coincides with the wrapper.
function CafiBox({ cafiId }: { cafiId: string }) {
  const store = useSimStore();
  const groupRef = useRef<THREE.Group>(null);
  const geom = useLoader(STLLoader, '/meshes/sim/cafi.STL');
  useFrame(() => {
    const c = store.get().cafis.find((x) => x.id === cafiId);
    if (!c || !groupRef.current) return;
    const [tx, ty, tz] = tPos(c.position[0], c.position[1], c.position[2]);
    groupRef.current.position.set(tx, ty, tz);
    groupRef.current.rotation.y = -c.yaw;
  });
  return (
    <group ref={groupRef}>
      <mesh
        geometry={geom}
        scale={[0.001, 0.001, 0.001]}
        position={[-0.0615, -0.0125, -0.0435]}
        castShadow
      >
        <meshStandardMaterial color="#d97340" metalness={0.2} roughness={0.55} />
      </mesh>
    </group>
  );
}

function CafiCollection() {
  const store = useSimStore();
  const [ids, setIds] = React.useState<string[]>([]);
  useFrame(() => {
    const next = store.get().cafis.map((c) => c.id);
    if (next.length !== ids.length || !next.every((id, i) => id === ids[i])) {
      setIds(next);
    }
  });
  return (
    <>
      {ids.map((id) => <CafiBox key={id} cafiId={id} />)}
    </>
  );
}

// Rotating disc + fixtures group. Uses the "rotate around pivot" trick:
// outer group at disc-centre in Three.js coords applies the rotation,
// inner group with the inverse translation puts children back at their
// natural world positions so VisualElement renders them with tPos as usual.
function RotatingFixtures() {
  const store = useSimStore();
  const groupRef = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y = -store.get().rotary.angle;
  });
  const [px, py, pz] = tPos(DISC_CENTER_X, DISC_CENTER_Y, DISC_TOP_Z);
  const rotaryNames = new Set([
    'fixture_load', 'fixture_rivet',
    'disco_rotating_disco_1', 'disco_rotating_bearingsprocket_1',
  ]);
  return (
    <group ref={groupRef} position={[px, py, pz]}>
      <group position={[-px, -py, -pz]}>
        {VISUALS.filter((v) => rotaryNames.has(v.name)).map((v, i) =>
          <VisualElement key={i} v={v} />
        )}
      </group>
    </group>
  );
}

// Live cobot — reads joint angles from store on each frame.
function LiveCobot({ basePos, gripperRef }: {
  basePos: [number, number, number];
  gripperRef: React.MutableRefObject<THREE.Group | null>;
}) {
  const store = useSimStore();
  // Use state + useFrame to push fresh joints to CobotChain.
  const [joints, setJoints] = React.useState<JointAngles>({
    j1: 0, j2: 0, j3: 0, j4: Math.PI / 2, j5: -Math.PI / 2, j6: 0,
  });
  useFrame(() => {
    const j = store.get().robot.joints;
    setJoints({ j1: j[0], j2: j[1], j3: j[2], j4: j[3], j5: j[4], j6: j[5] });
  });
  return (
    <CobotChain
      basePos={basePos}
      baseYaw={0}
      jointAngles={joints}
      gripperRef={gripperRef}
    />
  );
}

function CellScene({ gripperRef }: {
  gripperRef: React.MutableRefObject<THREE.Group | null>;
}) {
  // V51: cobot mount at (1.152, 1.049, 1.000) yaw=0. The j1 axis is +87 mm
  // above the mount per the Cobot URDF.
  //
  // BASE SHIFT — measured via the debug "Set Pose" buttons:
  //                       gripper got            expected            pre-shift err
  //   PICK_CONVEYOR       (1.072, 1.441, 1.116)  (1.235, 1.365, 1.083)  (+0.163, -0.076, -0.033)
  //   PLACE_LOAD_FIXTURE  (0.574, 1.185, 1.157)  (0.692, 1.109, ~1.12)  (+0.118, -0.076, -0.037)
  //
  // Analysis:
  //   - Y error is constant -0.076 m across both poses  → shift Y by -0.076
  //   - Z error is constant -0.035 m across both poses  → not shifted (would
  //     sink the cobot mount below the mesa; ~35 mm visual error accepted)
  //   - X error VARIES with pose (it scales linearly with target X distance,
  //     ~+0.156 + 0.083·(targetX - baseX)). This is an FK-chain X-scale issue
  //     that no uniform basePos shift can fully correct. We use the midpoint
  //     +0.140 so the residual is split symmetrically:
  //        PICK_CONV  → gripper ~23 mm east of pick
  //        PLACE_LOAD → gripper ~22 mm west of fixture
  //   - Re-measure with the remaining debug buttons (PLACE_VIS, ACCEPT,
  //     REJECT, etc.) to refine; per-pose j1 nudges may be needed for pixel-
  //     perfect alignment without touching the chain itself.
  // DIAGNOSTIC: temporarily zero out to confirm Railway is serving fresh JS.
  // If cobot moves visibly west vs the +0.140 build → bundle is fresh and the
  // math is off; if cobot doesn't move → Railway/CDN is serving stale bundle.
  const COBOT_SHIFT_X = 0.0;
  const COBOT_SHIFT_Y = 0.0;
  const cobotBasePos = tPos(
    1.152 + COBOT_SHIFT_X,
    1.049 + COBOT_SHIFT_Y,
    1.000 + 0.0867,
  );

  return (
    <group>
      <FloorGrid />
      <ReachCircle />

      {VISUALS
        .filter((v) => !v.name.startsWith('cobot_')
                    && !v.name.startsWith('new_gripper')
                    && v.name !== 'fixture_load'
                    && v.name !== 'fixture_rivet'
                    && !v.name.startsWith('disco_rotating_'))
        .map((v, i) => <VisualElement key={i} v={v} />)}

      <RotatingFixtures />

      <Suspense fallback={null}>
        <LiveCobot basePos={cobotBasePos} gripperRef={gripperRef} />
      </Suspense>

      <CafiCollection />

      {/* V51 layout labels */}
      <Label wx={1.152} wy={0.940} wz={1.10}  text="Lexium Cobot"    color="#60a5fa" />
      <Label wx={1.370} wy={1.420} wz={1.18}  text="Conveyor 1"      color="#fbbf24" />
      <Label wx={1.620} wy={1.420} wz={1.14}  text="Suministro CAFI" color="#fbbf24" />
      <Label wx={0.692} wy={1.030} wz={1.16}  text="Fixture LOAD"    color="#a78bfa" />
      <Label wx={0.692} wy={1.470} wz={1.16}  text="Fixture RIVET"   color="#a78bfa" />
      <Label wx={0.692} wy={1.409} wz={1.40}  text="Zona Remachado"  color="#fb923c" />
      <Label wx={0.750} wy={0.730} wz={1.06}  text="Fixture Vision"  color="#a78bfa" />
      <Label wx={0.750} wy={0.804} wz={1.62}  text="Cognex 2800"     color="#e879f9" />
      <Label wx={1.650} wy={0.640} wz={1.18}  text="Aceptado"        color="#4ade80" />
      <Label wx={1.330} wy={0.620} wz={1.18}  text="Rechazado"       color="#f87171" />
      <Label wx={0.684} wy={0.390} wz={0.82}  text="Control Station" color="#38bdf8" />
      <Label wx={0.704} wy={-0.05} wz={0.46}  text="Operador"        color="#38bdf8" />
    </group>
  );
}

// ── Inner component that uses simulation hooks ───────────────────────────────
function CellViewer3DInner() {
  // Shared ref captured inside Canvas (CobotChain) and read by sim hook outside.
  const gripperRef = useRef<THREE.Group | null>(null);

  // Convert Three.js world position back to ROS coords for the object_manager.
  // Inverse of tPos: ROS_X = three.X + CX, ROS_Y = -three.Z + CY, ROS_Z = three.Y
  const getGripperWorldXYZ = useCallback((): [number, number, number] | null => {
    const g = gripperRef.current;
    if (!g) return null;
    const v = new THREE.Vector3();
    g.getWorldPosition(v);
    return [v.x + CX, -v.z + CY, v.y];
  }, []);

  useSimulation(getGripperWorldXYZ);

  return (
    <div style={{ background: '#07111e', borderTop: '1px solid #1a3550', borderBottom: '1px solid #1a3550' }}>
      {/* Header */}
      <div style={{ padding: '32px 24px 16px', textAlign: 'center' }}>
        <div style={{ fontSize: 9, letterSpacing: 5, color: '#22c55e', textTransform: 'uppercase', marginBottom: 8 }}>
          Gemelo Digital · Simulación Interactiva
        </div>
        <div style={{ fontSize: 'clamp(20px,3vw,30px)', fontWeight: 700, color: '#f1f5f9' }}>
          Layout Físico de la Celda · V51
        </div>
        <div style={{ fontSize: 12, color: '#2a4060', marginTop: 8 }}>
          Pulsa "Colocar CAFI" para arrancar el ciclo · Replica fiel del Schneider Project Simulation
        </div>
        {/* DIAGNOSTIC MARKER — confirms which build is loaded in the browser */}
        <div style={{ fontSize: 11, color: '#ff5566', marginTop: 6, fontFamily: 'monospace', fontWeight: 700 }}>
          BUILD f9842ab · SHIFT X=0.000 Y=0.000
        </div>
      </div>

      {/* 3D Canvas + HMI panel */}
      <div style={{ height: '78vh', position: 'relative', maxWidth: 1500, margin: '0 auto' }}>
        <Canvas
          shadows
          camera={{ position: [-1.3, 1.9, 3.4], fov: 42 }}
          style={{ background: '#07111e' }}
          gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
        >
          <ambientLight intensity={0.55} />
          <directionalLight
            position={[1, 5, 3]} intensity={1.3} castShadow
            shadow-mapSize-width={2048} shadow-mapSize-height={2048}
            shadow-camera-near={0.1} shadow-camera-far={20}
            shadow-camera-left={-3} shadow-camera-right={3}
            shadow-camera-top={3} shadow-camera-bottom={-3}
          />
          <directionalLight position={[-2, 3, -2]} intensity={0.30} color="#a0c0ff" />
          <directionalLight position={[2, 2, 2]}  intensity={0.18} color="#ffe8c0" />

          <OrbitControls
            target={[0, 1.00, -0.15]}
            minPolarAngle={0.12} maxPolarAngle={Math.PI / 2.05}
            minDistance={1.5} maxDistance={9}
            enableDamping dampingFactor={0.07}
          />

          <Suspense fallback={null}>
            <CellScene gripperRef={gripperRef} />
          </Suspense>
        </Canvas>

        <HMIPanel />
      </div>

      {/* Legend */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center',
        padding: '14px 24px 26px', borderTop: '1px solid #0d1e30',
      }}>
        {[
          { color: '#22c55e', label: 'Reach cobot 626 mm' },
          { color: '#d97340', label: 'CAFI breaker' },
          { color: '#a78bfa', label: 'Fixtures' },
          { color: '#4ade80', label: 'Bin aceptado' },
          { color: '#f87171', label: 'Bin rechazado' },
          { color: '#60a5fa', label: 'Lexium Cobot L03S' },
          { color: '#e879f9', label: 'Cognex 2800' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#4a6a88' }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Exported component (wraps inner with the simulation store provider) ──────
export default function CellViewer3D() {
  return (
    <SimStoreProvider>
      <CellViewer3DInner />
    </SimStoreProvider>
  );
}

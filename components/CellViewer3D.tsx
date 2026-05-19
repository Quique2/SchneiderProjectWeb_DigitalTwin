import React, { Suspense, useMemo } from 'react';
import { Canvas, useLoader } from '@react-three/fiber';
import { OrbitControls, Html, Grid } from '@react-three/drei';
import * as THREE from 'three';
import { STLLoader } from 'three-stdlib';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const VISUALS: Visual[] = require('../assets/cell_visuals_world.json');

// ── Lexium Cobot kinematic chain (real STLs + hierarchical FK) ────────────────
// Joint params: offsets in meters, axes per the URDF/datasheet.
// All STLs were exported from SolidWorks with shared global coordinates and
// Y-up convention (same as Three.js), so each mesh is offset within its joint
// group by the negative cumulative joint offset, which puts the mesh's SW
// geometry exactly at its assembled position when all joints are at zero.
const COBOT_STL_FILES = [
  '/meshes/link0_base.STL',
  '/meshes/link1_shoulder_rotation.STL',
  '/meshes/link2_shoulder_connector.STL',
  '/meshes/link2_elbow_joint.STL',
  '/meshes/link3_forearm.STL',
  '/meshes/link3_elbow_connector.STL',
  '/meshes/link4_wrist1_cylinder.STL',
  '/meshes/link5_wrist2_body.STL',
  '/meshes/link5_wrist2_cylinder.STL',
  '/meshes/link6_wrist3_cylinder.STL',
  '/meshes/link6_wrist3_upper_body.STL',
  '/meshes/link6_tool_flange.STL',
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
// Fixture/CAFI STLs are Y-up → skip visual_rpy (Three.js is already Y-up).
// Gripper STLs are Z-up → apply visual_rpy Rx(-π/2) so Z maps to Three.js Y.
// Cobot link STLs are SolidWorks Y-up → visual_rpy Rx(+π/2) swaps SW Y → link Z.
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
  // Apply visual_rpy X-rotation (Rx) for STLs whose native axis convention
  // differs from the link frame: gripper (Z-up→Y-up) and cobot links (SW Y-up→ROS Z-up).
  const needsRpy = v.name.startsWith('new_gripper') || v.name.startsWith('cobot_link');
  if (needsRpy && v.visual_rpy && v.visual_rpy[0]) {
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
  basePos, baseYaw, jointAngles,
}: {
  basePos: [number, number, number];
  baseYaw: number;
  jointAngles: JointAngles;
}) {
  const cobotStls = useLoader(STLLoader, COBOT_STL_FILES);
  const gripperStls = useLoader(STLLoader, GRIPPER_STL_FILES);
  const { j1, j2, j3, j4, j5, j6 } = jointAngles;

  const linkColor    = useMemo(() => new THREE.Color(0.40, 0.40, 0.45), []);
  const baseColor    = useMemo(() => new THREE.Color(0.25, 0.25, 0.28), []);
  const gripperColor = useMemo(() => new THREE.Color(0.70, 0.70, 0.74), []);

  // Mesh placements derived directly from each STL's bbox center in the
  // shared SolidWorks global frame (Y-up). For every mesh:
  //   position = [ -bbox_center.X/1000, -joint_absolute_Y/1000, -bbox_center.Z/1000 ]
  // The -joint_Y term undoes the cumulative joint-group translation so the
  // SW-coord vertices land at the assembled position; the per-mesh X/Z values
  // center each mesh on its own geometric axis (which differs per mesh because
  // the links are asymmetric).
  //
  // IMPORTANT bug found analyzing bboxes directly:
  //   cobotStls[5] (link3_elbow_connector) and cobotStls[10] (link6_wrist3_upper_body)
  //   have IDENTICAL bboxes (X[0.4,153.7] Y[503.8,621.4] Z[3.2,84.3]) — both are
  //   wrist housing pieces despite their names. They belong to the j4 group, not
  //   j3 or j6 as their filenames suggest.
  //
  // Joint chain Y positions (absolute, in SW assembly): J1=0.086 J2=0.2095
  //   J3=0.3527 J4=0.5462 J5=0.5620 J6=0.5900 TCP=0.6214.

  return (
    <group position={basePos} rotation={[0, baseYaw, 0]}>
      {/* link0 — fixed base */}
      <CobotLink geometry={cobotStls[0]}
        position={[-0.0645, 0.0000, -0.0645]} color={baseColor} />

      {/* joint 1 (Y axis = azimuth) */}
      <group position={[0, 0.0860, 0]} rotation={[0, j1, 0]}>
        <CobotLink geometry={cobotStls[1]}
          position={[-0.0488, -0.0860, -0.0497]} color={linkColor} />

        {/* joint 2 (Z axis = shoulder elevation) */}
        <group position={[0, 0.1235, 0]} rotation={[0, 0, j2]}>
          <CobotLink geometry={cobotStls[2]}
            position={[-0.0658, -0.2095, -0.0655]} color={linkColor} />
          <CobotLink geometry={cobotStls[3]}
            position={[-0.0455, -0.2095, -0.0660]} color={linkColor} />

          {/* joint 3 (Z axis = elbow) */}
          <group position={[0, 0.1432, 0]} rotation={[0, 0, j3]}>
            <CobotLink geometry={cobotStls[4]}
              position={[-0.0428, -0.3527, -0.0932]} color={linkColor} />

            {/* joint 4 (Y axis = wrist roll) — all 4 wrist housing parts */}
            <group position={[0, 0.1935, 0]} rotation={[0, j4, 0]}>
              <CobotLink geometry={cobotStls[5]}
                position={[-0.0771, -0.5462, -0.0438]} color={linkColor} />
              <CobotLink geometry={cobotStls[6]}
                position={[-0.0394, -0.5462, -0.0222]} color={linkColor} />
              <CobotLink geometry={cobotStls[7]}
                position={[-0.0550, -0.5462, -0.0443]} color={linkColor} />
              <CobotLink geometry={cobotStls[10]}
                position={[-0.0771, -0.5462, -0.0438]} color={linkColor} />

              {/* joint 5 (Z axis = wrist pitch) — wrist2/3 cylinders */}
              <group position={[0, 0.0158, 0]} rotation={[0, 0, j5]}>
                <CobotLink geometry={cobotStls[8]}
                  position={[-0.0386, -0.5620, -0.0564]} color={linkColor} />
                <CobotLink geometry={cobotStls[9]}
                  position={[-0.0316, -0.5620, -0.0479]} color={linkColor} />

                {/* joint 6 (Y axis = tool spin) — tool flange */}
                <group position={[0, 0.0280, 0]} rotation={[0, j6, 0]}>
                  <CobotLink geometry={cobotStls[11]}
                    position={[-0.0270, -0.5900, -0.0345]} color={baseColor} />

                  {/* tool0 (TCP) — gripper attaches here */}
                  <group position={[0, 0.0314, 0]}>
                    {gripperStls.map((g, i) => (
                      <mesh
                        key={i}
                        geometry={g}
                        scale={[0.001, 0.001, 0.001]}
                        position={[-0.172, -0.085, 0.083]}
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
function ReachCircle() {
  const lineLoop = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const [cx, cy, cz] = tPos(1.670548, 0.920, 1.210);
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
function CellScene() {
  // Cobot joint angles for "about to grab a CAFI from the riveting station".
  // With the corrected joint chain (using STL-measured positions), the actual
  // arm reach from shoulder is only 0.412m (L1=0.143, L2=0.269), which is 27mm
  // SHORT of the legacy gripper distance of 0.439m from shoulder. The arm
  // CANNOT exactly reach the OLD tool0 pose without moving the base.
  //
  // Compromise: extend the arm fully toward the riveting fixture direction.
  // j2=-50°, j3=-5° puts tool0 at world ≈ (0.418, 1.655, -0.205) in Three.js,
  // which is 13mm below and 21mm south of the legacy gripper at (0.418,1.668,-0.226).
  const cobotJoints: JointAngles = {
    j1: 0,
    j2: -50 * Math.PI / 180,
    j3:  -5 * Math.PI / 180,
    j4: 0,
    j5: 0,
    j6: 0,
  };

  return (
    <group>
      <FloorGrid />
      <ReachCircle />

      {VISUALS
        .filter((v) => !v.name.startsWith('cobot_') && !v.name.startsWith('new_gripper'))
        .map((v, i) => <VisualElement key={i} v={v} />)}

      <Suspense fallback={null}>
        <CobotChain
          basePos={tPos(1.670548, 0.920, 1.200)}
          baseYaw={Math.PI / 2}
          jointAngles={cobotJoints}
        />
      </Suspense>

      {/* Labels */}
      <Label wx={1.671} wy={0.78}  wz={1.26}  text="Lexium Cobot"      color="#60a5fa" />
      <Label wx={1.671} wy={1.50}  wz={1.75}  text="Zona Remachado"    color="#fb923c" />
      <Label wx={1.069} wy={0.76}  wz={1.30}  text="Conveyor 1"        color="#fbbf24" />
      <Label wx={0.539} wy={0.76}  wz={1.27}  text="Suministro CAFI"   color="#fbbf24" />
      <Label wx={1.786} wy={0.49}  wz={1.38}  text="Aceptado"          color="#4ade80" />
      <Label wx={1.486} wy={0.49}  wz={1.38}  text="Rechazado"         color="#f87171" />
      <Label wx={2.28}  wy={1.06}  wz={1.82}  text="Cognex 2800"       color="#e879f9" />
      <Label wx={0.45}  wy={-0.02} wz={0.82}  text="Control Station"   color="#38bdf8" />
      <Label wx={0.345} wy={-0.26} wz={0.46}  text="Site Operator"     color="#38bdf8" />
      <Label wx={1.671} wy={1.28}  wz={1.27}  text="Fixture LOAD"      color="#a78bfa" />
      <Label wx={1.671} wy={1.48}  wz={1.27}  text="Fixture RIVET"     color="#a78bfa" />
    </group>
  );
}

// ── Exported component ────────────────────────────────────────────────────────
export default function CellViewer3D() {
  return (
    <div style={{ background: '#07111e', borderTop: '1px solid #1a3550', borderBottom: '1px solid #1a3550' }}>
      {/* Header */}
      <div style={{ padding: '32px 24px 16px', textAlign: 'center' }}>
        <div style={{ fontSize: 9, letterSpacing: 5, color: '#22c55e', textTransform: 'uppercase', marginBottom: 8 }}>
          Gemelo Digital
        </div>
        <div style={{ fontSize: 'clamp(20px,3vw,30px)', fontWeight: 700, color: '#f1f5f9' }}>
          Layout Físico de la Celda · V13
        </div>
        <div style={{ fontSize: 12, color: '#2a4060', marginTop: 8 }}>
          Arrastra para rotar · Scroll para zoom · Posiciones exactas del workspace ROS/FK
        </div>
      </div>

      {/* 3D Canvas */}
      <div style={{ height: '72vh', position: 'relative', maxWidth: 1300, margin: '0 auto' }}>
        <Canvas
          shadows
          camera={{ position: [-0.8, 1.9, 3.4], fov: 40 }}
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
            target={[0.15, 1.20, -0.25]}
            minPolarAngle={0.12} maxPolarAngle={Math.PI / 2.05}
            minDistance={1.5} maxDistance={9}
            enableDamping dampingFactor={0.07}
          />

          <Suspense fallback={null}>
            <CellScene />
          </Suspense>
        </Canvas>
      </div>

      {/* Legend */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center',
        padding: '14px 24px 26px', borderTop: '1px solid #0d1e30',
      }}>
        {[
          { color: '#22c55e', label: 'Reach cobot 626 mm' },
          { color: '#d97340', label: 'CAFI breaker (STL)' },
          { color: '#8a9090', label: 'Fixtures (STL real)' },
          { color: '#4ade80', label: 'Bin aceptado' },
          { color: '#f87171', label: 'Bin rechazado' },
          { color: '#60a5fa', label: 'Lexium Cobot' },
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

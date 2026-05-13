import React, { Suspense, useRef } from 'react';
import { Canvas, useLoader } from '@react-three/fiber';
import { OrbitControls, Html, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { STLLoader } from 'three-stdlib';

// ─── Coordinate mapping ──────────────────────────────────────────────────────
// ROS world frame: X=east, Y=north, Z=up
// Three.js frame:  X=right, Y=up, Z=toward viewer
// ros(x,y,z) → three [x-CX, z, -(y-CY)]
const CX = 1.252, CY = 1.049;
function ros(x: number, y: number, z: number): [number, number, number] {
  return [x - CX, z, -(y - CY)];
}

// ─── Primitive helpers ────────────────────────────────────────────────────────
function Box({ pos, size, color, opacity = 1, wireframe = false }: {
  pos: [number,number,number]; size: [number,number,number];
  color: string; opacity?: number; wireframe?: boolean;
}) {
  return (
    <mesh position={pos} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} transparent={opacity < 1} opacity={opacity} wireframe={wireframe} />
    </mesh>
  );
}

function Cyl({ pos, r, h, color, rot }: {
  pos: [number,number,number]; r: number; h: number;
  color: string; rot?: [number,number,number];
}) {
  return (
    <mesh position={pos} rotation={rot ?? [0,0,0]} castShadow>
      <cylinderGeometry args={[r, r, h, 20]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

// ─── STL mesh loader ─────────────────────────────────────────────────────────
function STLMesh({ url, pos, rot, color, scale = 0.001 }: {
  url: string; pos: [number,number,number]; rot: [number,number,number];
  color: string; scale?: number;
}) {
  const geometry = useLoader(STLLoader, url);
  return (
    <mesh geometry={geometry} position={pos} rotation={rot}
      scale={[scale, scale, scale]} castShadow>
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

function STLMeshSafe(props: Parameters<typeof STLMesh>[0]) {
  return (
    <Suspense fallback={null}>
      <STLMesh {...props} />
    </Suspense>
  );
}

// ─── Reach circle (cobot workspace) ──────────────────────────────────────────
function ReachCircle() {
  const points: THREE.Vector3[] = [];
  const cx = 1.671 - CX, cz = -(0.920 - CY), r = 0.626, y = 1.205;
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    points.push(new THREE.Vector3(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  return (
    <line geometry={geo}>
      <lineBasicMaterial color="#22c55e" transparent opacity={0.25} />
    </line>
  );
}

// ─── Hollow bin (4 walls + bottom) ───────────────────────────────────────────
function HollowBin({ pos, size, color }: { pos: [number,number,number]; size: [number,number,number]; color: string }) {
  const [w, h, d] = size;
  const t = 0.005;
  return (
    <group position={pos}>
      {/* bottom */}
      <Box pos={[0, -h/2 + t/2, 0]} size={[w, t, d]} color={color} opacity={0.5} />
      {/* front */}
      <Box pos={[0, 0, d/2 - t/2]} size={[w, h, t]} color={color} opacity={0.5} />
      {/* back */}
      <Box pos={[0, 0, -d/2 + t/2]} size={[w, h, t]} color={color} opacity={0.5} />
      {/* left */}
      <Box pos={[-w/2 + t/2, 0, 0]} size={[t, h, d]} color={color} opacity={0.5} />
      {/* right */}
      <Box pos={[w/2 - t/2, 0, 0]} size={[t, h, d]} color={color} opacity={0.5} />
    </group>
  );
}

// ─── Riveting cabin ───────────────────────────────────────────────────────────
function RivetingCabin() {
  const cx = 1.671 - CX, cy = 1.625 - CY, h = 0.500, cy3 = 1.200;
  const sw = 0.700, sd = 0.400;
  const postR = 0.015;
  // 4 posts at cabin corners
  const corners: [number,number][] = [
    [-sw/2, -sd/2], [sw/2, -sd/2], [sw/2, sd/2], [-sw/2, sd/2]
  ];
  return (
    <group>
      {corners.map(([dx, dz], i) => (
        <Cyl key={i} pos={[cx + dx, cy3 + h/2, -cy + dz]} r={postR} h={h} color="#5a6070" />
      ))}
      {/* back wall (north face, transparent) */}
      <Box pos={[cx, cy3 + h/2, -cy - sd/2]} size={[sw, h, 0.004]} color="#3a4555" opacity={0.25} />
      {/* canopy */}
      <Box pos={[cx, cy3 + h, -cy]} size={[sw, 0.040, sd]} color="#4a5565" opacity={0.5} />
      {/* press pillar */}
      <Cyl pos={[cx, cy3 + h * 0.6, -(1.475 - CY)]} r={0.020} h={0.260} color="#383d47" />
      {/* press head */}
      <Box pos={[cx, cy3 + 0.148, -(1.475 - CY)]} size={[0.120, 0.036, 0.060]} color="#303540" />
    </group>
  );
}

// ─── Simplified Lexium Cobot ──────────────────────────────────────────────────
function CobotArm() {
  const bx = 1.671 - CX, bz = -(0.920 - CY);
  const baseZ = 1.200;
  // Pedestal
  const pedH = 0.250, pedZ = baseZ + pedH / 2;
  // Simplified arm: 3 segments from pedestal to tool0
  // tool0 at Three.js: [0.419, 1.6685, -0.226]
  // We'll place 3 cylinders roughly following the arm path
  const GREEN = '#66c733';
  const WHITE = '#f2f2f2';
  const DARK = '#2a2d35';
  return (
    <group>
      {/* Pedestal */}
      <Cyl pos={[bx, pedZ, bz]} r={0.055} h={pedH} color={DARK} />
      <Cyl pos={[bx, baseZ + pedH, bz]} r={0.062} h={0.020} color={GREEN} />
      {/* Base rotation joint */}
      <Cyl pos={[bx, baseZ + pedH + 0.030, bz]} r={0.055} h={0.060} color={WHITE} />
      {/* Link 1: slight tilt north-up */}
      <Box pos={[bx, baseZ + pedH + 0.180, bz - 0.060]} size={[0.075, 0.260, 0.075]} color={WHITE} />
      {/* Joint 2 */}
      <Cyl pos={[bx, baseZ + pedH + 0.310, bz - 0.120]} r={0.048} h={0.052} color={GREEN} rot={[0,0,Math.PI/2]} />
      {/* Link 2: going toward fixture */}
      <Box pos={[bx, baseZ + pedH + 0.380, bz - 0.185]} size={[0.065, 0.200, 0.065]} color={WHITE} />
      {/* Joint 3 */}
      <Cyl pos={[bx, baseZ + pedH + 0.450, bz - 0.220]} r={0.040} h={0.040} color={GREEN} rot={[0,0,Math.PI/2]} />
      {/* End effector stub */}
      <Cyl pos={[bx, baseZ + pedH + 0.480, bz - 0.226]} r={0.030} h={0.040} color={DARK} />
      {/* Gripper (simplified box) */}
      <Box pos={[bx, baseZ + pedH + 0.430, bz - 0.226]} size={[0.130, 0.080, 0.070]} color="#b0b2bb" />
    </group>
  );
}

// ─── Label ────────────────────────────────────────────────────────────────────
function Label({ pos, text, color = '#e2e8f0' }: { pos: [number,number,number]; text: string; color?: string }) {
  return (
    <Html position={pos} center>
      <div style={{
        fontSize: 9, color, background: 'rgba(6,16,28,0.82)',
        border: `1px solid ${color}33`, padding: '2px 6px', borderRadius: 4,
        whiteSpace: 'nowrap', fontFamily: 'monospace', pointerEvents: 'none',
        letterSpacing: 0.5,
      }}>
        {text}
      </div>
    </Html>
  );
}

// ─── Full cell scene ──────────────────────────────────────────────────────────
function CellScene() {
  return (
    <group>
      {/* Floor */}
      <mesh rotation={[-Math.PI/2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[5, 5]} />
        <meshStandardMaterial color="#1a1d24" />
      </mesh>

      {/* Plant table */}
      <Box pos={ros(1.265, 1.150, 1.180)} size={[2.000, 0.040, 1.600]} color="#d0d3d9" />
      {/* Table legs */}
      {([[0.265,0.350],[2.265,0.350],[0.265,1.950],[2.265,1.950]] as [number,number][]).map(([lx,ly],i) => (
        <Box key={i} pos={ros(lx, ly, 0.600)} size={[0.060, 1.200, 0.060]} color="#6a6d75" />
      ))}

      {/* Cobot reach circle */}
      <ReachCircle />

      {/* Cobot arm */}
      <CobotArm />
      <Label pos={ros(1.671, 0.780, 1.310)} text="Lexium Cobot" color="#60a5fa" />

      {/* Conveyor 1 */}
      <Box pos={ros(1.069, 0.861, 1.2325)} size={[0.700, 0.065, 0.150]} color="#8a8d96" />
      <Label pos={ros(1.069, 0.750, 1.290)} text="Conveyor" color="#fbbf24" />

      {/* CAFI supply pallet */}
      <Box pos={ros(0.539, 0.861, 1.2075)} size={[0.360, 0.015, 0.685]} color="#aab0bb" />
      <Label pos={ros(0.539, 0.780, 1.260)} text="Suministro CAFI" color="#fbbf24" />

      {/* Reject bin */}
      <HollowBin pos={ros(1.486, 0.496, 1.275)} size={[0.227, 0.150, 0.211]} color="#c0392b" />
      <Label pos={ros(1.486, 0.496, 1.380)} text="Bin Rechazo" color="#f87171" />

      {/* Accept bin */}
      <HollowBin pos={ros(1.786, 0.496, 1.275)} size={[0.227, 0.150, 0.211]} color="#27ae60" />
      <Label pos={ros(1.786, 0.496, 1.380)} text="Bin Aceptado" color="#4ade80" />

      {/* Riveting cabin */}
      <RivetingCabin />

      {/* Rotary disc */}
      <Cyl pos={ros(1.671, 1.375, 1.210)} r={0.100} h={0.020} color="#7a8090" />
      <Label pos={ros(1.671, 1.375, 1.250)} text="Disco Rotatorio" color="#a78bfa" />

      {/* Load fixture (STL) */}
      <STLMeshSafe
        url="/meshes/Fixture_para_remache_1.STL"
        pos={ros(1.671, 1.275, 1.220)}
        rot={[Math.PI/2, 0, 0]}
        color="#9aa0b0"
      />

      {/* Rivet position fixture (STL - same geometry, inside cabin) */}
      <STLMeshSafe
        url="/meshes/Fixture_para_remache_1.STL"
        pos={ros(1.671, 1.475, 1.220)}
        rot={[Math.PI/2, 0, 0]}
        color="#9aa0b0"
      />

      {/* CAFI on load fixture (STL) */}
      <STLMeshSafe
        url="/meshes/cafi.STL"
        pos={ros(1.671, 1.275, 1.225)}
        rot={[Math.PI/2, 0, 0]}
        color="#d97340"
      />

      {/* Vision fixture (STL) */}
      <STLMeshSafe
        url="/meshes/Fixture_para_camara_final.STL"
        pos={ros(2.050, 1.200, 1.215)}
        rot={[Math.PI/2, 0, 0]}
        color="#9aa0b0"
      />
      <Label pos={ros(2.050, 1.050, 1.270)} text="Fixture Visión" color="#e879f9" />

      {/* CAFI on vision fixture (STL) */}
      <STLMeshSafe
        url="/meshes/cafi.STL"
        pos={ros(2.050, 1.200, 1.215)}
        rot={[Math.PI/2, 0, 0]}
        color="#d97340"
      />

      {/* Cognex camera column (floor-mounted) */}
      <Cyl pos={ros(2.330, 1.200, 0.900)} r={0.018} h={1.800} color="#7a8090" />
      {/* Camera arm */}
      <Box pos={ros(2.270, 1.200, 1.750)} size={[0.120, 0.018, 0.018]} color="#6a7080" />
      {/* Camera body */}
      <Box pos={ros(2.210, 1.200, 1.750)} size={[0.060, 0.045, 0.045]} color="#18191f" />
      <Cyl pos={ros(2.210, 1.200, 1.730)} r={0.014} h={0.028} color="#3a5568" rot={[Math.PI/2, 0, 0]} />
      <Label pos={ros(2.210, 1.050, 1.790)} text="Cognex 2800" color="#e879f9" />

      {/* Control station */}
      <Box pos={ros(0.450, 0.180, 0.600)} size={[0.500, 1.200, 0.300]} color="#353a45" />
      {/* Desk surface */}
      <Box pos={ros(0.450, 0.180, 0.722)} size={[0.500, 0.012, 0.300]} color="#4a5060" />
      {/* HMI screen */}
      <Box pos={ros(0.450, 0.040, 0.960)} size={[0.180, 0.120, 0.010]} color="#1a3050" />
      <Label pos={ros(0.450, 0.040, 1.080)} text="Control Station" color="#38bdf8" />

      {/* Cabin label */}
      <Label pos={ros(1.671, 1.750, 1.720)} text="Cabina Remachado" color="#fb923c" />
    </group>
  );
}

// ─── Main exported component ──────────────────────────────────────────────────
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
          Arrastra para rotar · Scroll para zoom · Modelos STL reales del workspace ROS
        </div>
      </div>

      {/* 3D Canvas */}
      <div style={{ height: '70vh', position: 'relative', maxWidth: 1200, margin: '0 auto' }}>
        <Canvas
          shadows
          camera={{ position: [1.6, 2.2, 3.0], fov: 42 }}
          style={{ background: '#07111e' }}
          gl={{ antialias: true }}
        >
          <ambientLight intensity={0.55} />
          <directionalLight
            position={[2, 4, 3]} intensity={1.2}
            castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048}
          />
          <directionalLight position={[-2, 3, -2]} intensity={0.4} color="#b0d0ff" />

          <OrbitControls
            target={[0.42, 1.25, -0.18]}
            minPolarAngle={0.2}
            maxPolarAngle={Math.PI / 2.1}
            minDistance={1.5}
            maxDistance={7}
            enableDamping dampingFactor={0.08}
          />

          <Suspense fallback={null}>
            <CellScene />
          </Suspense>
        </Canvas>
      </div>

      {/* Legend */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center',
        padding: '16px 24px 28px', borderTop: '1px solid #0d1e30',
      }}>
        {[
          { color: '#66c733', label: 'Cobot reach — 0.626 m' },
          { color: '#d97340', label: 'CAFI breaker (STL real)' },
          { color: '#9aa0b0', label: 'Fixtures (STL real)' },
          { color: '#27ae60', label: 'Bin aceptado' },
          { color: '#c0392b', label: 'Bin rechazo' },
          { color: '#18191f', label: 'Cognex In-Sight 2800' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#4a6a88' }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}

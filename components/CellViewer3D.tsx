// V53 cell visualizer — clean rewrite using urdf-loader.
// Scene is in ROS Z-up convention (camera.up = [0,0,1]) so URDF coordinates
// map 1:1 to Three.js, eliminating the axis-conversion bugs of the old
// hand-rolled CobotChain.  All meshes/poses come from V53.

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../context/ThemeContext';
import type { Theme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, Html } from '@react-three/drei';
import * as THREE from 'three';
import { STLLoader } from 'three-stdlib';
import URDFLoader from 'urdf-loader';
import type { URDFRobot } from 'urdf-loader';
import OperatorHMI from './OperatorHMI';
import { useCellSimulation, type UseCellSimulation } from './useCellSimulation';
import type { CafiEntity, CobotTask } from './cellStateTypes';
import type { CellStateMachine } from './cellStateMachine';

// La pestaña "Celda 3D" tiene dos modos (separados, al estilo ROS):
//   · HMI   = simulación automática tipo ROS (la máquina de estados pura
//             `cellStateMachine.ts` es la fuente de verdad; el visual la sigue).
//   · DEBUG = modo manual/diagnóstico (poses, IK, jogging, secuencia, sliders).
// El modo activo lo posee la máquina de estados (`snapshot.mode`); la barra de
// pestañas del panel hace `switchMode`. El binder visual sólo escribe los refs
// en modo HMI; en DEBUG los controles manuales son los dueños.

// ── V60 poses (legacy backup; kept as the TCP source of truth) ──────────────
// These joint values came from the V60 simulation's resolved_poses.py.  The
// V26 URDF has a re-parented elbow chain, so applying these joints to V26
// would put the TCP in the wrong world position — they're preserved here
// purely as the reference TCP poses and for the "RE-IK all poses for V26"
// button in the DEBUG panel.  Runtime POSE_LIB is the V26-native one below.
const POSE_LIB_V60: Record<string, [number, number, number, number, number, number]> = {
  POSE_HOME:                  [+0.000000, +0.000000, +0.000000, +1.570796, -1.570796, +0.000000],
  POSE_APPROACH_CONVEYOR:     [-2.372758, +1.485911, -1.332119, +1.331061, -1.605556, -2.373385],
  POSE_PICK_CONVEYOR:         [-2.372778, +1.961976, -1.699341, +1.222211, -1.605553, -2.373404],
  POSE_LIFT_CONVEYOR:         [-2.372773, +1.360180, -1.193885, +1.318553, -1.605554, -2.373398],
  POSE_APPROACH_LOAD_FIXTURE: [-0.821172, +1.338785, -1.418464, +1.739105, -1.570796, -0.785398],
  POSE_PLACE_LOAD_FIXTURE:    [-0.821256, +1.834278, -1.876262, +1.701416, -1.570796, -0.785398],
  POSE_RELEASE_LOAD_FIXTURE:  [-0.821159, +1.749900, -1.816596, +1.726125, -1.570796, -0.785398],
  POSE_RETREAT_LOAD_FIXTURE:  [-0.821172, +1.338785, -1.418464, +1.739105, -1.570796, -0.785398],
  POSE_APPROACH_PICK_RIVETED: [-0.821172, +1.338785, -1.418464, +1.739105, -1.570796, -0.785398],
  POSE_PICK_RIVETED:          [-0.821256, +1.834278, -1.876262, +1.701416, -1.570796, -0.785398],
  POSE_LIFT_RIVETED:          [-0.821206, +1.212485, -1.260442, +1.707372, -1.570796, -0.785398],
  POSE_APPROACH_VISION:       [+0.110638, +1.121233, -0.023105, +0.470515, -1.565045, +0.110383],
  POSE_PLACE_VISION:          [+0.113212, +1.676994, -0.659508, +0.552975, -1.565147, +0.113070],
  POSE_RELEASE_VISION:        [+0.113215, +1.582386, -0.589477, +0.577552, -1.565147, +0.113073],
  POSE_RETREAT_VISION:        [+0.110638, +1.120024, -0.020605, +0.469222, -1.565045, +0.110384],
  POSE_APPROACH_ACCEPT_BIN:   [+2.209657, +1.753535, -1.620040, +1.357474, -1.530664, +2.210256],
  POSE_DROP_ACCEPT_BIN:       [+2.209751, +0.480417, +1.809826, -0.799257, -1.530674, +2.210355],
  POSE_APPROACH_REJECT_BIN:   [+1.225784, -0.442571, +2.178227, -0.197937, -1.523750, +1.225389],
  POSE_DROP_REJECT_BIN:       [+1.225773, -0.031858, +2.523346, -0.953769, -1.523749, +1.225378],
};

// ── POSE LIBRARY REAL (grados) — capturada en HW por Santiago, 2026-06-04 ────
// Fuente de verdad ÚNICA del cobot visual. Poses en JOINT-SPACE puro (6 joints
// en GRADOS). NO se recalcula IK y NO se inventan poses: se cargan tal cual
// (deg→rad). Reglas del usuario: LIFT_* = APPROACH_* de la zona ; RETREAT_* =
// SAFE_* de la zona (resueltas como alias abajo, sin duplicar números).
// Todas verificadas dentro de JOINT_LIMITS del URDF.
const d2r = (deg: number) => (deg * Math.PI) / 180;

// NUEVA pose library REAL del usuario (2026-06-06) — los MISMOS nombres internos
// del pipeline del sim, pero con los joints de NEW_REAL_POSE_LIBRARY_DEG (el sim
// y Cobot en Vivo ahora comparten poses). Estación de remachado = FIXTURE_1 (la
// mesa gira para presentar A/B en el mismo punto; FIXTURE_1≈FIXTURE_2). Las poses
// intermedias PRE_* = pose final (descenso directo). NO ZERO_POSE, NO RIVET_FIXTURE_REAL.
export const POSE_LIBRARY_DEG = {
  HOME:                  [ 90.0,   0.0,   0.0,  90.0, -90.0, -89.9],

  // — Conveyor (pick de la pieza cruda) —
  SAFE_CONVEYOR:         [ 66.0,  -9.1,  57.5,  24.2, -91.8, -112.4],
  APPROACH_CONVEYOR:     [ 69.2, -19.3,  86.7, -15.0, -91.9, -109.3],
  PRE_PICK_CONVEYOR:     [ 68.5, -30.1,  91.9, -31.1, -91.4, -110.4],  // = PICK_CONVEYOR
  PICK_CONVEYOR:         [ 68.5, -30.1,  91.9, -31.1, -91.4, -110.4],

  // — Mesa rotatoria: place del CAFI crudo en fixture (= FIXTURE_1) —
  SAFE_RIVET:            [167.0,  -1.8,  51.9,  37.6, -91.4, -109.9],
  APPROACH_RIVET:        [185.8, -35.3,  36.0,  19.0, -92.7, -175.1],  // = APPROACH_PLACE_FIXTURE_1
  PRE_PLACE_RIVET:       [185.3, -35.3,  60.5,  -5.3, -92.7, -175.6],  // = PLACE_FIXTURE_1
  PLACE_RIVET:           [185.3, -35.3,  60.5,  -5.3, -92.7, -175.6],

  // — Mesa rotatoria: pick del CAFI ya remachado (= PICK_FIXTURE_1) —
  PRE_PICK_RIVET:        [185.3, -36.7,  65.0, -11.2, -92.7, -175.7],  // = PICK_FIXTURE_1
  PICK_RIVET:            [185.3, -36.7,  65.0, -11.2, -92.7, -175.7],

  // — Cámara/visión: place sobre el plato —
  SAFE_CAMERA:           [238.7,  25.9, 107.2,   9.9, -91.6, -122.8],
  APPROACH_PLACE_CAMERA: [217.0, -38.3,  67.3, -17.6, -90.1, -145.3],  // = APPROACH_CAMERA
  PRE_PLACE_CAMERA:      [216.9, -46.2,  74.8, -32.9, -90.1, -145.4],  // = PLACE_CAMERA
  PLACE_CAMERA:          [216.9, -46.2,  74.8, -32.9, -90.1, -145.4],

  // — Cámara/visión: pick del plato (mismas poses que el place) —
  APPROACH_PICK_CAMERA:  [217.0, -38.3,  67.3, -17.6, -90.1, -145.3],  // = APPROACH_CAMERA
  PRE_PICK_CAMERA:       [216.9, -46.2,  74.8, -32.9, -90.1, -145.4],  // = PICK_CAMERA
  PICK_CAMERA:           [216.9, -46.2,  74.8, -32.9, -90.1, -145.4],

  // — Bins —
  SAFE_BINS:             [238.6,  25.7, 107.0,   9.8, -91.6, -122.9],
  APPROACH_REJECTED:     [263.6,   5.6,  97.7,   1.8, -93.2,  -97.9],
  PRE_REJECTED:          [262.4, -14.8, 131.5, -56.7, -91.4,  -99.0],  // = FIRST_PLACE_REJECTED
  REJECTED_PLACE:        [262.4, -14.8, 131.5, -56.7, -91.4,  -99.0],
  LIFT_REJECTED:         [263.6,   5.6,  97.7,   1.8, -93.2,  -97.9],
  APPROACH_ACCEPTED:     [ 87.4, -17.6,-108.9,   3.3,  90.6,  -93.8],
  PRE_PLACE_ACCEPTED:    [ 88.8,  11.3,-139.3,  62.5,  89.9,  -92.4],  // = FIRST_PLACE_ACCEPTED
  ACCEPTED_PLACE:        [ 88.8,  11.3,-139.3,  62.5,  89.9,  -92.4],
  LIFT_ACCEPTED:         [ 88.7, -17.7,-102.0,  -3.5,  90.0,  -92.5],
  // Pose de retorno común tras dejar la pieza en el bin (antes del HOME).
  SAFE_RETURN:           [177.9,  14.8,  79.0,  26.4, -90.3,  -90.5],
} as const;

// Alias del usuario: LIFT = APPROACH, RETREAT = SAFE, INSPECTION = SAFE_CAMERA.
// Mismas poses, sin duplicar los números (se resuelven a la pose fuente).
// Tras dejar en el bin, el retreat va a SAFE_RETURN (pipeline real).
const POSE_ALIASES = {
  LIFT_CONVEYOR:        'APPROACH_CONVEYOR',
  RETREAT_CONVEYOR:     'SAFE_CONVEYOR',
  LIFT_RIVET:           'APPROACH_RIVET',
  RETREAT_RIVET:        'SAFE_RIVET',
  LIFT_PICK_RIVET:      'APPROACH_RIVET',
  RETREAT_PICK_RIVET:   'SAFE_RIVET',
  LIFT_PLACE_CAMERA:    'APPROACH_PLACE_CAMERA',
  RETREAT_PLACE_CAMERA: 'SAFE_CAMERA',
  INSPECTION_POSE:      'SAFE_CAMERA',
  LIFT_PICK_CAMERA:     'APPROACH_PICK_CAMERA',
  RETREAT_PICK_CAMERA:  'SAFE_CAMERA',
  RETREAT_REJECTED:     'SAFE_RETURN',
  RETREAT_ACCEPTED:     'SAFE_RETURN',
} as const;

type BasePoseName = keyof typeof POSE_LIBRARY_DEG;
type AliasName = keyof typeof POSE_ALIASES;
type PoseName = BasePoseName | AliasName;
type Joints6 = [number, number, number, number, number, number];

// Runtime POSE_LIB en RADIANES (deg→rad), alias incluidos. Fuente única; NO
// se sobreescribe en runtime (sin IK, sin caché) para respetar las poses reales.
const POSE_LIB: Record<PoseName, Joints6> = (() => {
  const lib = {} as Record<PoseName, Joints6>;
  for (const [k, v] of Object.entries(POSE_LIBRARY_DEG)) {
    lib[k as BasePoseName] = (v as readonly number[]).map(d2r) as Joints6;
  }
  for (const [alias, src] of Object.entries(POSE_ALIASES)) {
    lib[alias as AliasName] = [...lib[src as BasePoseName]] as Joints6;
  }
  return lib;
})();

// Bump suffix when the baked V26 POSE_LIB changes — invalidates any cache
// from a previous build whose joints might be inconsistent.
const POSE_LIB_V26_CACHE_KEY = 'schneider_v26_pose_lib_v6';

function loadPoseLibV26FromCache(): Record<string, [number, number, number, number, number, number]> | null {
  try {
    const raw = localStorage.getItem(POSE_LIB_V26_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Sanity: every V60 pose must be present and well-formed
    for (const name of Object.keys(POSE_LIB_V60)) {
      const v = parsed[name];
      if (!Array.isArray(v) || v.length !== 6 || v.some((x) => typeof x !== 'number')) return null;
    }
    return parsed;
  } catch { return null; }
}

function savePoseLibV26ToCache(lib: Record<string, [number, number, number, number, number, number]>) {
  try { localStorage.setItem(POSE_LIB_V26_CACHE_KEY, JSON.stringify(lib)); }
  catch { /* quota / privacy mode */ }
}

// Per-pose gripper state.  Mirrors the V53 pick/place trajectories:
//   PICK_* / APPROACH_PICK / HOME / RELEASE_* / RETREAT_* / DROP_* → OPEN
//   LIFT_* / PLACE_* / APPROACH_LOAD / APPROACH_VISION / APPROACH_BIN → CLOSED
// (the cobot is carrying the CAFI on all "closed" poses).
// Estado del gripper por pose (sólo COSMÉTICO: lo usa el salto manual de pose
// del panel DEBUG; el ciclo real abre/cierra con pasos `grip` explícitos tras
// llegar). Default = ABIERTO; aquí sólo se listan las poses en las que el cobot
// LLEVA la pieza (gripper cerrado).
const GRIPPER_OPEN_AT_POSE: Partial<Record<PoseName, boolean>> = {
  // Llevando la pieza cruda del conveyor al fixture:
  LIFT_CONVEYOR:        false,
  RETREAT_CONVEYOR:     false,
  APPROACH_RIVET:       false,
  PRE_PLACE_RIVET:      false,
  PLACE_RIVET:          false,
  // Llevando la pieza remachada a la cámara:
  LIFT_PICK_RIVET:      false,
  RETREAT_PICK_RIVET:   false,
  APPROACH_PLACE_CAMERA: false,
  PRE_PLACE_CAMERA:     false,
  PLACE_CAMERA:         false,
  // Llevando la pieza de la cámara al bin:
  LIFT_PICK_CAMERA:     false,
  RETREAT_PICK_CAMERA:  false,
  APPROACH_REJECTED:    false,
  PRE_REJECTED:         false,
  REJECTED_PLACE:       false,
  APPROACH_ACCEPTED:    false,
  PRE_PLACE_ACCEPTED:   false,
  ACCEPTED_PLACE:       false,
};

export const GRIPPER_OPEN_M  = 0.028;  // URDF upper limit
export const GRIPPER_CLOSED_M = 0.000;

// ── Velocidades de animación (capa de RENDER, NO afecta a la FSM) ────────────
// Cobot: tope duro de avance por joint para que ningún joint "salte" (look ROS).
//   0.008 rad/frame ≈ 0.48 rad/s @60 fps → movimiento pausado entre poses.
//   El paso real es COBOT_MAX_JOINT_SPEED*dt, recortado al techo por-frame.
const COBOT_MAX_JOINT_STEP  = 0.008;   // rad por frame (techo absoluto)
const COBOT_MAX_JOINT_SPEED = 0.48;    // rad/s
// Gating: un nuevo movimiento (waypoint) sólo arranca cuando el anterior
// terminó, es decir cuando TODOS los joints están dentro de ±COBOT_TARGET_EPS
// rad del waypoint actual. Así se ve cada movimiento completo, sin solaparse.
const COBOT_TARGET_EPS = 0.005;        // rad
// CLAMP DEL ELBOW DESACTIVADO (decisión de Santiago, 2026-06-03). Un clamp
//   absoluto de ±0.96 rad sobre joint_3 era incompatible con el robot: sus
//   poses calibradas trabajan en ~−1.2…−2.6 rad. Las poses ya funcionan en el
//   rango real; si aparece una pose problemática puntual se ajusta ahí.
// Muestras de IK a lo largo de la recta del TCP en los tramos LINEAR (approach).
const LINEAR_IK_SAMPLES = 12;
// Ritmo de consumo de waypoints en los tramos LINEAR (descenso/retiro suave).
const LINEAR_WP_PER_SEC = 8;
// Espera con el cobot quieto tras cerrar / antes de abrir el gripper (asentar).
const GRIP_SETTLE_MS = 1000;
// Conveyor: la pieza viaja entre las posiciones discretas de la FSM a velocidad
// lineal realista (interpolación frame a frame con dt real, sin teletransporte).
const CONVEYOR_SPEED = 0.4;            // unidades/segundo (máximo pedido)

// ── Velocidades por TIPO de movimiento (joint-space puro, sin IK) ────────────
// Regla del usuario (2026-06-04):
//   · JOINT      = traslado largo entre zonas → RÁPIDO.
//   · LINEAR     = approach/lift/retreat fino → LENTO y suave.
//   · PICK_PLACE = descenso final a PICK/PLACE → MUY LENTO y preciso.
// Antes los tramos LINEAR y JOINT compartían el mismo techo (0.48 rad/s) y el
// LINEAR además llevaba muestreo de IK → se sentía al revés (linear rápido,
// joint lento). Ahora cada tipo tiene su propia velocidad angular (rad/s) y la
// duración del tramo se deriva del mayor Δjoint. Easing smoothstep (velocidad
// nula en ambos extremos): sin overshoot, sin rebote, snap exacto al llegar.
type MoveSpeed = 'JOINT' | 'LINEAR' | 'PICK_PLACE';
const JOINT_MOVE_SPEED        = 1.40;  // rad/s — traslados largos (rápido)
const LINEAR_MOVE_SPEED       = 0.40;  // rad/s — approach/lift/retreat (lento)
const PICK_PLACE_LINEAR_SPEED = 0.18;  // rad/s — pick/place final (muy lento)

// ── Límites de velocidad REALES del cobot (fuente de verdad) ─────────────────
// Robot físico de la celda: Schneider Electric **Lexium Cobot LXMRL12S0**
// (6 ejes, payload 12 kg, alcance 1327 mm). Velocidad máx. por eje según la
// "Mechanical and Electrical Data" oficial de Schneider:
//     ejes 1-3 = 120 °/s   ·   ejes 4-6 = 180 °/s   ·   brida/TCP = 3 m/s.
// Son el TECHO real: el Teach Pendant joggea hasta este máximo al 100 % de
// velocidad y la simulación (player) nunca los excede (ver moveDurationFor).
const COBOT_MODEL = 'Lexium Cobot LXMRL12S0';
const JOINT_MAX_SPEED_DEG = [120, 120, 120, 180, 180, 180] as const;          // °/s por eje
const JOINT_MAX_SPEED = JOINT_MAX_SPEED_DEG.map((d) => (d * Math.PI) / 180);  // rad/s por eje
const TCP_MAX_LINEAR_SPEED = 3.0;            // m/s — velocidad máx. de la brida (TCP)
const TCP_MAX_ROT_SPEED    = Math.PI;        // rad/s (= 180 °/s) — reorientación del TCP (limitada por muñeca)

// ── Límites SEGUROS para el ROBOT REAL conectado (Cobot en Vivo) ─────────────
// El máx oficial (3 m/s, datasheet Schneider LXMRL12S0) es demasiado para
// pruebas reales. Cuando hay gateway conectado se usan estos topes en vez del
// máximo técnico. En DEMO (sin gateway) se permiten las velocidades de arriba.
export const LINEAR_REAL_MAX_MPS      = 0.20;  // m/s (= 200 mm/s) tope duro real
export const LINEAR_REAL_DEFAULT_MPS  = 0.05;  // m/s (= 50 mm/s) default real
export const JOINT_REAL_MAX_PERCENT   = 30;    // % del máx articular en real
export const JOINT_REAL_DEFAULT_PERCENT = 15;  // % default real
// Slider 0..1 → fracción del tope. Default real = 0.25 → 0.05 m/s lineal.
export const JOG_REAL_DEFAULT_FRAC    = LINEAR_REAL_DEFAULT_MPS / LINEAR_REAL_MAX_MPS; // 0.25
const MOVE_SPEED_RAD_S: Record<MoveSpeed, number> = {
  JOINT:      JOINT_MOVE_SPEED,
  LINEAR:     LINEAR_MOVE_SPEED,
  PICK_PLACE: PICK_PLACE_LINEAR_SPEED,
};
const MOVE_MIN_DURATION_S = 0.30;      // piso para tramos muy cortos

// smoothstep clásico: u²(3−2u). Suave ease-in-out, derivada 0 en 0 y 1 → no
// genera overshoot ni rebote (a diferencia de back/bounce/elastic).
const smoothstep = (u: number) => u * u * (3 - 2 * u);

// Duración (s) de un tramo según el mayor Δjoint y la velocidad del tipo.
// `physFloor` = duración mínima físicamente posible respetando el límite real de
// velocidad de CADA eje (JOINT_MAX_SPEED). La duración final nunca baja de ese
// piso → la simulación jamás mueve un eje más rápido que el cobot real.
function moveDurationFor(from: ArrayLike<number>, to: ArrayLike<number>, speed: MoveSpeed): number {
  let maxDelta = 0;
  let physFloor = 0;
  for (let i = 0; i < 6; i++) {
    const d = Math.abs(to[i] - from[i]);
    if (d > maxDelta) maxDelta = d;
    physFloor = Math.max(physFloor, d / JOINT_MAX_SPEED[i]);  // s = rad / (rad/s)
  }
  const cinematic = maxDelta / MOVE_SPEED_RAD_S[speed];
  return Math.max(MOVE_MIN_DURATION_S, cinematic, physFloor);
}

// Cobot joint limits, in radians (from the V53 URDF).
// J1 (base): rango físico real = 0 .. 2π (una vuelta completa, NO simétrico
// ±π). Esto permite que el IK rote la base en todo el círculo para alcanzar
// poses laterales (mover X/Y del TCP); con el rango antiguo ±π la base quedaba
// recortada y el IK lateral no convergía → MOVE LINEAR no movía en X/Y.
const JOINT_LIMITS: ReadonlyArray<[number, number]> = [
  [0, +6.28319],         // j1 (base rotation): 0..2π (una sola vuelta)
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
// Rotación visual EXTRA del CAFI cuando está en un fixture del disco, sobre la
// vertical (eje Z mundo, el disco es horizontal). Con las poses nuevas el cobot
// coloca el CAFI girado ~180° respecto a la orientación base del frame del
// fixture; este giro lo hace coincidir con cómo lo deja el gripper. TUNABLE:
// cambia a 0 / Math.PI/2 / -Math.PI/2 si visualmente no queda recto. NO mueve
// centros de fixture ni poses del robot ni offsets del disco (solo orientación).
const CAFI_FIXTURE_YAW = Math.PI;
const _cafiFixtureYawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), CAFI_FIXTURE_YAW);

// Rotación visual del CAFI cuando está SENTADO en el fixture/seat de VISIÓN (sobre
// el eje Z mundo; el CAFI queda plano). El cobot lo deja en PLACE_CAMERA con yaw
// ≈ −178° (FK), así que a identity se ve "girado raro". Este giro alinea el seat
// con cómo lo deja/recoge el gripper (place/pick limpios, sin salto raro). TUNABLE:
// prueba 0 / ±Math.PI/2 / Math.PI si no queda recto. NO mueve centro/X/Y/Z del
// plato, ni cámara/sensor, ni poses/IK: SOLO la orientación del CAFI en visión.
const VISION_SEAT_YAW = Math.PI;
const _visionSeatYawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), VISION_SEAT_YAW);

type StaticCafiState = 'conveyor' | 'at_vision' | 'in_accept_bin' | 'in_reject_bin';
const CAFI_AT: Record<StaticCafiState, [number, number, number]> = {
  conveyor:      [1.387345, 1.365, 1.052 + 0.0125], // banda en 1.052; pick alineado al sensor (x=1.387345)
  at_vision:     [0.750, 0.804, 1.025],            // top of vision plate + half-CAFI
  in_accept_bin: [1.650, 0.720, 1.020],            // bin floor + half-CAFI
  in_reject_bin: [1.330, 0.700, 1.020],
};

// Lateral-grasp offset used when the CAFI is attached to a *_cafi_lateral_target
// frame.  V53 turntable URDF visual offset = (-0.212983, +0.056354, -0.022608),
// kept here for on_fixture_* (matches the blue reference exactly).
const CAFI_OFFSET_ATTACHED: [number, number, number] = [-0.212983, 0.056354, -0.022608];
// User-tuned golden defaults for the in_gripper grasp offset.
const CAFI_GRASP_OFFSET_GOLD: [number, number, number] = [-0.205, +0.059, -0.023];
const CAFI_OFFSET_CENTERED: [number, number, number] = [-0.06145, +0.04365, -0.01255];

// ── Animation sequence (full V53 pick → rivet → vision → bin cycle) ─────────
// Verdict-aware: vision inspecting decides accept (green) vs reject (red),
// and the cobot routes to the corresponding bin.  The pre-verdict portion
// (everything up to the post-vision 5 s wait) is shared; the tails diverge.
type CafiColor = 'natural' | 'accept' | 'reject';
type Verdict = 'accept' | 'reject';

type SequenceStep =
  | { kind: 'pose';      pose: PoseName; speed: MoveSpeed;  label?: string }
  | { kind: 'gripper';   open: boolean;  dwell: number;    label?: string }
  | { kind: 'cafi';      state: CafiState;                 label?: string }
  | { kind: 'cafiColor'; color: CafiColor;                 label?: string }
  | { kind: 'disc';      target: number; duration: number; label?: string }
  | { kind: 'wait';      dwell: number;                    label?: string };

// Riveting cycle takes 30 s in the real cell (process spec).
const RIVET_DWELL_S = 30.0;
// Vision inspection takes 5 s while the cobot waits at HOME.
const VISION_DWELL_S = 5.0;

// === Pre-verdict portion (identical for accept and reject) ===
// Ends right before the verdict is known — the cobot has placed the CAFI on
// the vision plate, retreated to HOME, and is waiting for the verdict.
const SEQUENCE_PRE: SequenceStep[] = [
  // === init ===
  { kind: 'pose',      pose: 'HOME', speed: 'JOINT' },
  { kind: 'cafiColor', color: 'natural' },
  { kind: 'cafi',      state: 'conveyor', label: 'CAFI delivered to conveyor' },
  // === pick desde conveyor ===
  { kind: 'pose',      pose: 'SAFE_CONVEYOR',     speed: 'JOINT'  },
  { kind: 'pose',      pose: 'APPROACH_CONVEYOR', speed: 'LINEAR' },
  { kind: 'pose',      pose: 'PRE_PICK_CONVEYOR', speed: 'LINEAR' },
  { kind: 'pose',      pose: 'PICK_CONVEYOR',     speed: 'PICK_PLACE' },
  { kind: 'gripper',   open: false, dwell: 0.8,   label: 'Cerrando gripper' },
  { kind: 'cafi',      state: 'in_gripper' },
  { kind: 'pose',      pose: 'LIFT_CONVEYOR',     speed: 'LINEAR' },
  { kind: 'pose',      pose: 'RETREAT_CONVEYOR',  speed: 'LINEAR' },
  // === place en fixture (zona remachado) ===
  { kind: 'pose',      pose: 'SAFE_RIVET',        speed: 'JOINT'  },
  { kind: 'pose',      pose: 'APPROACH_RIVET',    speed: 'LINEAR' },
  { kind: 'pose',      pose: 'PRE_PLACE_RIVET',   speed: 'LINEAR' },
  { kind: 'pose',      pose: 'PLACE_RIVET',       speed: 'PICK_PLACE' },
  { kind: 'gripper',   open: true, dwell: 0.8,    label: 'Abriendo gripper' },
  { kind: 'cafi',      state: 'on_fixture_1' },
  { kind: 'pose',      pose: 'LIFT_RIVET',        speed: 'LINEAR' },
  { kind: 'pose',      pose: 'RETREAT_RIVET',     speed: 'LINEAR' },
  // === mesa gira 180°, remacha 30 s, gira de vuelta ===
  { kind: 'disc',      target: Math.PI, duration: 2.5, label: 'Mesa girando' },
  { kind: 'wait',      dwell: RIVET_DWELL_S,            label: 'Remachado (30 s)…' },
  { kind: 'disc',      target: 0.0,     duration: 2.5,  label: 'Mesa de vuelta' },
  // === pick del CAFI remachado ===
  { kind: 'pose',      pose: 'APPROACH_RIVET',    speed: 'LINEAR' },
  { kind: 'pose',      pose: 'PRE_PICK_RIVET',    speed: 'LINEAR' },
  { kind: 'pose',      pose: 'PICK_RIVET',        speed: 'PICK_PLACE' },
  { kind: 'gripper',   open: false, dwell: 0.8 },
  { kind: 'cafi',      state: 'in_gripper' },
  { kind: 'pose',      pose: 'LIFT_PICK_RIVET',   speed: 'LINEAR' },
  { kind: 'pose',      pose: 'RETREAT_PICK_RIVET', speed: 'LINEAR' },
  // === place en la cámara/visión ===
  { kind: 'pose',      pose: 'SAFE_CAMERA',          speed: 'JOINT'  },
  { kind: 'pose',      pose: 'APPROACH_PLACE_CAMERA', speed: 'LINEAR' },
  { kind: 'pose',      pose: 'PRE_PLACE_CAMERA',     speed: 'LINEAR' },
  { kind: 'pose',      pose: 'PLACE_CAMERA',         speed: 'PICK_PLACE' },
  { kind: 'gripper',   open: true, dwell: 0.8 },
  { kind: 'cafi',      state: 'at_vision' },
  { kind: 'pose',      pose: 'LIFT_PLACE_CAMERA',    speed: 'LINEAR' },
  { kind: 'pose',      pose: 'RETREAT_PLACE_CAMERA', speed: 'LINEAR' }, // = INSPECTION_POSE
  // === inspección (cobot esperando en INSPECTION_POSE = SAFE_CAMERA) ===
  { kind: 'wait',      dwell: VISION_DWELL_S,        label: 'Inspección (5 s)…' },
];

// === Pick desde la cámara (tras conocerse el veredicto) ===
const PICK_FROM_VISION: SequenceStep[] = [
  { kind: 'pose',    pose: 'APPROACH_PICK_CAMERA', speed: 'LINEAR' },
  { kind: 'pose',    pose: 'PRE_PICK_CAMERA',      speed: 'LINEAR' },
  { kind: 'pose',    pose: 'PICK_CAMERA',          speed: 'PICK_PLACE' },
  { kind: 'gripper', open: false, dwell: 0.8 },
  { kind: 'cafi',    state: 'in_gripper' },
  { kind: 'pose',    pose: 'LIFT_PICK_CAMERA',     speed: 'LINEAR' },
  { kind: 'pose',    pose: 'RETREAT_PICK_CAMERA',  speed: 'LINEAR' },
  { kind: 'pose',    pose: 'SAFE_BINS',            speed: 'JOINT' },
];

// === Cola con veredicto = ACCEPT (verde, bin de aceptados) ===
const TAIL_ACCEPT: SequenceStep[] = [
  { kind: 'pose',    pose: 'APPROACH_ACCEPTED',  speed: 'JOINT'  },
  { kind: 'pose',    pose: 'PRE_PLACE_ACCEPTED', speed: 'LINEAR' },
  { kind: 'pose',    pose: 'ACCEPTED_PLACE',     speed: 'PICK_PLACE' },
  { kind: 'gripper', open: true, dwell: 0.8 },
  { kind: 'cafi',    state: 'in_accept_bin' },
  { kind: 'pose',    pose: 'RETREAT_ACCEPTED',   speed: 'LINEAR' },
  { kind: 'pose',    pose: 'HOME',               speed: 'JOINT'  },
];

// === Cola con veredicto = REJECT (rojo, bin de rechazados) ===
const TAIL_REJECT: SequenceStep[] = [
  { kind: 'pose',    pose: 'APPROACH_REJECTED',  speed: 'JOINT'  },
  { kind: 'pose',    pose: 'PRE_REJECTED',       speed: 'LINEAR' },
  { kind: 'pose',    pose: 'REJECTED_PLACE',     speed: 'PICK_PLACE' },
  { kind: 'gripper', open: true, dwell: 0.8 },
  { kind: 'cafi',    state: 'in_reject_bin' },
  { kind: 'pose',    pose: 'RETREAT_REJECTED',   speed: 'LINEAR' },
  { kind: 'pose',    pose: 'HOME',               speed: 'JOINT'  },
];

function buildSequence(verdict: Verdict): SequenceStep[] {
  return [
    ...SEQUENCE_PRE,
    // Verdict applied: CAFI tints green (accept) or red (reject) on the plate.
    { kind: 'cafiColor', color: verdict,
      label: verdict === 'accept' ? 'Vision verdict: PASS ✓' : 'Vision verdict: FAIL ✗' },
    ...PICK_FROM_VISION,
    ...(verdict === 'accept' ? TAIL_ACCEPT : TAIL_REJECT),
  ];
}

// Default sequence used at boot (just for length/display before any START is
// pressed).  The player swaps to a freshly-built sequence each time the user
// hits a START button.
const SEQUENCE: SequenceStep[] = buildSequence('accept');

// V57 world anchors (from schneider_cell.urdf.xacro).  Compared to V53:
//   - disc shifted +0.300 m east (riveting_zone (0.692, 1.259) → (0.992, 1.259))
//   - conveyor shifted +0.300 m east (anchor (1.370, 1.365) → (1.670, 1.365))
//     so the conveyor pick X moves 1.235 → 1.535.
//   - mesa, cobot, vision, bins, control station unchanged.
export const COBOT_BASE     : [number, number, number] = [1.152, 1.049, 1.000];
// Reubicada para que la ESQUINA superior-izquierda del DISCO (x_min, y_max)
// caiga en (0.504205, 1.509061) de la mesa de trabajo. Disco = Ø400 mm
// (radio 0.200 m). OJO: TURNTABLE_BASE es el origen del MODELO, no el centro
// del disco: el table_rotation_joint lo offsetea (-0.015, 0, +0.078), así que
// el centro del disco = TURNTABLE_BASE + (-0.015, 0). Despeje:
// V43: posición world de base_link para que la esquina sup-izq del BOUNDING BOX
// COMPLETO del assembly (gearbase incluido: X[-0.265,+0.265], Y[-0.250,+0.250]
// en base_link, joint=0) caiga en (0.504205, 1.509061):
//   x = 0.504205 - (-0.265) = 0.769205
//   y = 1.509061 - (+0.250) = 1.259061
//   z = 1.000 + 0.001530 = 1.00153  (gearbase apoyado en el worktop = 1.000)
export const TURNTABLE_BASE : [number, number, number] = [0.769205, 1.259061, 1.00153];
export const MESA_CENTRE    : [number, number, number] = [1.252205, 1.049061, 1.000];

// ── Bases / elevadores por ESTACIÓN (SOLO Celda 3D) ──────────────────────────
// La MESA NO sube (se quedó en su altura real). En su lugar, cada estación se
// eleva con una base/riser propia para que el seat del CAFI coincida con el
// TCP real del cobot (pick/place), sin tocar poses ni mover el cobot.
//   base = cafiSeatZ_en_gripper(pose) − seatActualDeLaEstación   (FK del URDF)
// Valores (m), tunables en una línea:
//   · Conveyor: gripper 1.0734 vs seat 1.0645 → 0.9 cm → 0 (ya bien).
//   · Mesa rotatoria/fixtures: gripper PICK 1.1360 vs seat 1.1060 → +3.0 cm.
//       (sube el disco → sus frames de fixture suben; PLACE 1.163 queda ~2.7 cm
//        arriba → caída visible animada al colocar).
//   · Visión: gripper 1.0432 vs plato 1.025 → +1.8 cm.
//   · Bins: gripper 1.003/1.027 vs 1.020 → ±1.7 cm → 0 (ya bien).
// Estos NO son props compartidos con Cobot en Vivo (esa vista no los usa).
export const BASE_CONVEYOR  = 0.000;
export const BASE_TURNTABLE = 0.030;
export const BASE_VISION    = 0.018;
export const BASE_BINS      = 0.000;

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
  // Conveyor -7.5 cm en X (1.670→1.595) y caja sincronizada al mesh real (0.575×0.101).
  { x: 1.534845, y: 1.365, z: 1.022, sx: 0.575, sy: 0.101, sz: 0.080, name: 'Conveyor',         color: '#fbbf24' },
  // Suministro CAFI: bbox real del dispensador rotado 180°, base en worktop (1.942345,1.365,1.000).
  { x: 1.942345, y: 1.365, z: 1.1422, sx: 0.2397, sy: 0.1115, sz: 0.2844, name: 'Suministro CAFI', color: '#fbbf24' },
  // Quality bins (unchanged — outer envelope treated as no-go)
  { x: 1.650, y: 0.720, z: 1.075, sx: 0.227, sy: 0.172, sz: 0.150, name: 'Bin Aceptado',     color: '#22dd55' },
  { x: 1.330, y: 0.700, z: 1.075, sx: 0.227, sy: 0.182, sz: 0.150, name: 'Bin Rechazado',    color: '#ff5566' },
  // Vision fixture plate (unchanged)
  { x: 0.750, y: 0.804, z: 1.008, sx: 0.159, sy: 0.118, sz: 0.015, name: 'Vision fixture',   color: '#a78bfa' },
  // Cognex camera body + suspension column (unchanged)
  { x: 0.750, y: 0.804, z: 1.905, sx: 0.060, sy: 0.045, sz: 0.045, name: 'Cognex body',      color: '#e879f9' },
  { x: 0.750, y: 0.804, z: 1.795, sx: 0.024, sy: 0.024, sz: 0.550, name: 'Cognex column',    color: '#e879f9' },
  // V57: rivet cabin REMOVED.  Indicator post is the only new obstacle next
  // to the disc (post + 3 lamps, all at x ≈ disc_x − 0.220).
  { x: 0.549205, y: 1.259061, z: 1.22653, sx: 0.060, sy: 0.060, sz: 0.350, name: 'Rivet indicator',  color: '#fb923c' },
  // Turntable disc + rivet fixtures — V57 disc anchor (0.992, 1.259).
  // Top flush with the fixture body (disc top z≈1.078, fixture +50 mm).
  // V43: bbox world real del assembly (gearbase incluido) — base en worktop (0.769205,1.259061,1.00153).
  { x: 0.769205, y: 1.259061, z: 1.063731, sx: 0.530, sy: 0.500, sz: 0.127403, name: 'Turntable + fixtures', color: '#a78bfa' },
  // Cabin corner posts — en las 4 esquinas EXACTAS de la mesa (1.620×0.920).
  { x: 0.442205, y: 0.589061, z: 1.010, sx: 0.050, sy: 0.050, sz: 2.020, name: 'Cabin post SW',     color: '#c8c8cc' },
  { x: 2.062205, y: 0.589061, z: 1.010, sx: 0.050, sy: 0.050, sz: 2.020, name: 'Cabin post SE',     color: '#c8c8cc' },
  { x: 0.442205, y: 1.509061, z: 1.010, sx: 0.050, sy: 0.050, sz: 2.020, name: 'Cabin post NW',     color: '#c8c8cc' },
  { x: 2.062205, y: 1.509061, z: 1.010, sx: 0.050, sy: 0.050, sz: 2.020, name: 'Cabin post NE',     color: '#c8c8cc' },
  // Sensor sincronizado al mesh real (costado norte): face (1.4475, 1.4155).
  { x: 1.387345, y: 1.4155, z: 1.082, sx: 0.045, sy: 0.080, sz: 0.045, name: 'Sensor conveyor', color: '#33dffe' },
  { x: 0.626, y: 0.804, z: 1.040, sx: 0.080, sy: 0.045, sz: 0.045, name: 'Sensor vision',   color: '#33dffe' },
  // V57: NEMA17 motor moved with conveyor
  { x: 1.714845, y: 1.365, z: 1.018, sx: 0.045, sy: 0.045, sz: 0.060, name: 'NEMA17 motor',    color: '#fbbf24' },
];

// ── Hook: load a URDF asynchronously and expose the robot object ─────────────
export function useUrdf(url: string): URDFRobot | null {
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
  tcpEulerRef: React.MutableRefObject<[number, number, number]>;
  collisionsRef: React.MutableRefObject<string[]>;
  robotRef: React.MutableRefObject<URDFRobot | null>;
  groupRef: React.MutableRefObject<THREE.Group | null>;
  // TCP relativo a la base del cobot (mm + grados) para el TeachPendant. Opcional
  // (Celda 3D y Cobot en Vivo lo pasan; otros usos pueden omitirlo).
  tcpBaseRef?: React.MutableRefObject<TcpInBase | null>;
  // Subida visual en Z del cobot + sus obstáculos. Hoy NADIE lo pasa (el cobot
  // se queda a su altura REAL; las estaciones suben con bases). default 0.
  zLift?: number;
}

const GRIPPER_SPEED = 0.04; // m/s (URDF velocity limit is 0.08)

export function Cobot({ jointsRef, gripperRef, gripperLiveRef, gripperWorldRef, tcpEulerRef, collisionsRef, robotRef, groupRef, tcpBaseRef, zLift = 0 }: CobotProps) {
  const robot = useUrdf('/urdf/lexium_cobot.urdf');
  const obstacles = useMemo(() => liftObstacles(collisionAABBs(), zLift), [zLift]);

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
    const home = POSE_LIB.HOME;
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
      // Orientación mundo del TCP (Euler XYZ) para pre-rellenar el Linear TCP.
      const q = new THREE.Quaternion();
      tcp.getWorldQuaternion(q);
      const eu = new THREE.Euler().setFromQuaternion(q, 'XYZ');
      tcpEulerRef.current = [eu.x, eu.y, eu.z];
    }

    // TCP relativo a la BASE del cobot (para el TeachPendant) — FK real, no world.
    if (tcpBaseRef) tcpBaseRef.current = getTcpRelativeToCobotBase(robot);

    collisionsRef.current = checkCobotCollisions(robot, obstacles);
  });

  if (!robot) return null;
  return (
    <group ref={groupRef} position={[COBOT_BASE[0], COBOT_BASE[1], COBOT_BASE[2] + zLift]}>
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
// Vision verdict tint applied to the CAFI material.  Natural = factory
// orange; accept = green (PASS); reject = red (FAIL).
const CAFI_COLOR_NATURAL = '#d97340';
const CAFI_COLOR_ACCEPT  = '#22c55e';
const CAFI_COLOR_REJECT  = '#ef4444';
function cafiColorHex(c: CafiColor): string {
  return c === 'accept' ? CAFI_COLOR_ACCEPT
       : c === 'reject' ? CAFI_COLOR_REJECT
       : CAFI_COLOR_NATURAL;
}

function CafiMesh({
  stateRef, colorRef, cobotRobotRef, turntableRobotRef,
  graspYawRef, graspPitchRef, graspRollRef,
  graspOffsetXRef, graspOffsetYRef, graspOffsetZRef, layout = ZERO_LAYOUT,
}: {
  stateRef: React.MutableRefObject<CafiState>;
  colorRef: React.MutableRefObject<CafiColor>;
  cobotRobotRef: React.MutableRefObject<URDFRobot | null>;
  turntableRobotRef: React.MutableRefObject<URDFRobot | null>;
  graspYawRef: React.MutableRefObject<number>;
  graspPitchRef: React.MutableRefObject<number>;
  graspRollRef: React.MutableRefObject<number>;
  graspOffsetXRef: React.MutableRefObject<number>;
  graspOffsetYRef: React.MutableRefObject<number>;
  graspOffsetZRef: React.MutableRefObject<number>;
  // Offsets de layout: el CAFI estático (conveyor/visión/bins) sigue al objeto
  // movido. on_fixture_*/in_gripper siguen frames URDF → ya se mueven solos.
  layout?: LayoutOffsets;
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
  const graspEuler = useMemo(() => new THREE.Euler(0, 0, 0, 'XYZ'), []);
  const graspQuat = useMemo(() => new THREE.Quaternion(), []);
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
      // For in_gripper, compose the gripper frame's world rotation with the
      // operator's pitch/roll/yaw applied in the group's LOCAL frame.
      // Mapping (group local axes = gripper_base axes):
      //   pitch → X axis (lateral tilt forward/back)
      //   roll  → Y axis (jaw close direction)
      //   yaw   → Z axis (tool axis — spins the CAFI in plane)
      // Group sits at the gripper centre so all rotations are concentric.
      if (state === 'in_gripper') {
        graspEuler.set(
          graspPitchRef.current,
          graspRollRef.current,
          graspYawRef.current,
          'XYZ',
        );
        graspQuat.setFromEuler(graspEuler);
        g.quaternion.copy(tmpQuat).multiply(graspQuat);
      } else {
        // on_fixture_*: orienta como el frame del fixture + giro extra (vertical)
        // para que el CAFI quede como lo deja el gripper con las poses reales.
        g.quaternion.copy(tmpQuat).premultiply(_cafiFixtureYawQuat);
      }
      if (state === 'in_gripper') {
        // Live-tunable grasp offset (the operator can refine via HMI).
        m.position.set(
          graspOffsetXRef.current,
          graspOffsetYRef.current,
          graspOffsetZRef.current,
        );
      } else {
        m.position.set(...CAFI_OFFSET_ATTACHED);
      }
      if (m.geometry !== geomAttached) m.geometry = geomAttached;
      m.rotation.set(Math.PI / 2, 0, 0);
    } else {
      const xyz = CAFI_AT[state as StaticCafiState];
      if (xyz) {
        // Sigue al objeto movido (conveyor/visión/bins); Z sin cambio.
        const st = state as StaticCafiState;
        const off = st === 'conveyor' ? layout.conveyorOffset
          : st === 'at_vision' ? layout.visionOffset
          : st === 'in_accept_bin' ? layout.binAcceptOffset
          : st === 'in_reject_bin' ? layout.binRejectOffset
          : [0, 0] as [number, number];
        // Base/elevador por estación (DEBUG): el seat sube con su riser.
        const stBase = st === 'conveyor' ? BASE_CONVEYOR
          : st === 'at_vision' ? BASE_VISION
          : BASE_BINS; // bins
        g.position.set(xyz[0] + off[0], xyz[1] + off[1], xyz[2] + stBase);
        if (st === 'at_vision') g.quaternion.copy(_visionSeatYawQuat); else g.quaternion.identity();
        m.position.set(...CAFI_OFFSET_CENTERED);
        if (m.geometry !== geomStatic) m.geometry = geomStatic;
        m.rotation.set(Math.PI / 2, 0, 0);
      }
    }

    // Verdict tint: drive the standard material's colour from colorRef so
    // the player flipping cafiColor → accept/reject changes the visible
    // hue both on the vision plate and while the cobot carries the part
    // afterwards.
    const mat = m.material as THREE.MeshStandardMaterial;
    const desired = cafiColorHex(colorRef.current);
    if (`#${mat.color.getHexString()}` !== desired) mat.color.set(desired);

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

// ── Renderizador CAFI PER-ENTIDAD (modo HMI) ─────────────────────────────────
// UNA malla por CafiEntity (id único). Cada pieza decide su posición por SU
// propio estado, así que NUNCA hay dos copias ni teletransporte entre piezas:
//   · carried (carriedCafiId del binder) → sigue el gripper.
//   · IN_GRIPPER pero aún no carried → HOLD en su sitio (espera el attach visual).
//   · IN_*_FIXTURE/RIVETING/RIVETED → sigue el frame del fixture (rota con disco).
//   · conveyor → seat de banda, viaje suave.
//   · visión/bins → seat estático (+ base de estación, apilado en bins).
// Al SOLTAR (carried→no carried) anima la CAÍDA gripper→seat (easeOut 0.55 s);
// si el estado destino aún no llegó, sostiene en el punto de release y cae en
// cuanto se conoce el seat (robusto al timing FSM↔player).
const CAFI_DROP_DUR = 0.55; // s
function easeOutCubic(u: number): number { return 1 - Math.pow(1 - u, 3); }

// Seat estático (world) de una pieza NO-attached según su estado FSM. null si la
// pieza está en gripper/fixture/oculta (se resuelve por frame URDF, no aquí).
function cafiSeatTarget(entity: CafiEntity, layout: LayoutOffsets, stackIndex: number): [number, number, number] | null {
  switch (entity.state) {
    case 'DISPENSED': case 'ON_CONVEYOR_WAITING': case 'AT_SENSOR': {
      const p = WAITING_CAFI_POS[entity.state]; if (!p) return null;
      const o = layout.conveyorOffset;
      return [p[0] + o[0], p[1] + o[1], p[2] + BASE_CONVEYOR];
    }
    case 'IN_INSPECTION': case 'INSPECTED_PASS': case 'INSPECTED_FAIL': {
      const p = CAFI_AT.at_vision; const o = layout.visionOffset;
      return [p[0] + o[0], p[1] + o[1], p[2] + BASE_VISION];
    }
    case 'ACCEPTED_BIN': {
      const p = CAFI_AT.in_accept_bin; const o = layout.binAcceptOffset;
      return [p[0] + o[0], p[1] + o[1], p[2] + BASE_BINS + stackIndex * 0.028];
    }
    case 'REJECTED_BIN': {
      const p = CAFI_AT.in_reject_bin; const o = layout.binRejectOffset;
      return [p[0] + o[0], p[1] + o[1], p[2] + BASE_BINS + stackIndex * 0.028];
    }
    default: return null;
  }
}

type CafiPieceMode = 'gripper' | 'fixture' | 'conveyor' | 'static' | 'hold' | 'hidden';

function CafiPiece({
  entity, carriedCafiIdRef, cobotRobotRef, turntableRobotRef,
  graspYawRef, graspPitchRef, graspRollRef, graspOffsetXRef, graspOffsetYRef, graspOffsetZRef,
  layout, stackIndex, geomAttached, geomStatic, showDebug,
}: {
  entity: CafiEntity;
  carriedCafiIdRef: React.MutableRefObject<number | null>;
  cobotRobotRef: React.MutableRefObject<URDFRobot | null>;
  turntableRobotRef: React.MutableRefObject<URDFRobot | null>;
  graspYawRef: React.MutableRefObject<number>;
  graspPitchRef: React.MutableRefObject<number>;
  graspRollRef: React.MutableRefObject<number>;
  graspOffsetXRef: React.MutableRefObject<number>;
  graspOffsetYRef: React.MutableRefObject<number>;
  graspOffsetZRef: React.MutableRefObject<number>;
  layout: LayoutOffsets;
  stackIndex: number;
  geomAttached: THREE.BufferGeometry;
  geomStatic: THREE.BufferGeometry;
  showDebug: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const tmpPos = useMemo(() => new THREE.Vector3(), []);
  const tmpQuat = useMemo(() => new THREE.Quaternion(), []);
  const graspEuler = useMemo(() => new THREE.Euler(0, 0, 0, 'XYZ'), []);
  const graspQuat = useMemo(() => new THREE.Quaternion(), []);
  const wasCarriedRef = useRef(false);
  const pendingDropRef = useRef(false);                       // soltó, falta conocer el seat
  const carriedPosRef = useMemo(() => new THREE.Vector3(), []); // último punto en gripper
  const releaseQuat = useMemo(() => new THREE.Quaternion(), []); // orientación del gripper al soltar
  const releaseSetRef = useRef(false);                        // ya se capturó releaseQuat
  const positionedRef = useRef(false);                        // ya se posicionó al menos una vez
  const dropRef = useRef<{ t: number; from: THREE.Vector3; fromQuat: THREE.Quaternion } | null>(null);
  const convCurRef = useRef<THREE.Vector3 | null>(null);       // posición animada en banda

  useFrame((_, dt) => {
    const g = groupRef.current, m = meshRef.current;
    if (!g || !m) return;
    const isCarried = carriedCafiIdRef.current === entity.id;

    // 1) Modo
    let mode: CafiPieceMode;
    if (isCarried) mode = 'gripper';
    else switch (entity.state) {
      case 'DISPENSED': case 'ON_CONVEYOR_WAITING': case 'AT_SENSOR': mode = 'conveyor'; break;
      case 'IN_GRIPPER': mode = 'hold'; break;
      case 'IN_OUTSIDE_FIXTURE': case 'IN_RIVET_FIXTURE': case 'RIVETING': case 'RIVETED': mode = 'fixture'; break;
      case 'IN_INSPECTION': case 'INSPECTED_PASS': case 'INSPECTED_FAIL':
      case 'ACCEPTED_BIN': case 'REJECTED_BIN': mode = 'static'; break;
      default: mode = 'hidden';
    }
    if (mode === 'hidden') { g.visible = false; wasCarriedRef.current = isCarried; return; }
    g.visible = true;

    // 2) Target world (tmpPos/tmpQuat) + geometría/offset
    let useAttached = false;
    let ox = CAFI_OFFSET_CENTERED[0], oy = CAFI_OFFSET_CENTERED[1], oz = CAFI_OFFSET_CENTERED[2];
    if (mode === 'gripper') {
      const robot = cobotRobotRef.current;
      const frame = robot ? (robot.frames['cafi_lateral_target_frame'] ?? robot.getObjectByName('cafi_lateral_target_frame')) : null;
      if (robot && frame) {
        robot.updateMatrixWorld(true);
        frame.getWorldPosition(tmpPos); frame.getWorldQuaternion(tmpQuat);
        graspEuler.set(graspPitchRef.current, graspRollRef.current, graspYawRef.current, 'XYZ');
        graspQuat.setFromEuler(graspEuler); tmpQuat.multiply(graspQuat);
      } else { tmpPos.copy(g.position); tmpQuat.copy(g.quaternion); }
      useAttached = true; ox = graspOffsetXRef.current; oy = graspOffsetYRef.current; oz = graspOffsetZRef.current;
    } else if (mode === 'fixture') {
      const robot = turntableRobotRef.current;
      const fn = entity.fixtureId === 'B' ? 'cafi_part_2_link' : 'cafi_part_1_link';
      const frame = robot ? (robot.frames[fn] ?? robot.getObjectByName(fn)) : null;
      if (robot && frame) {
        robot.updateMatrixWorld(true);
        frame.getWorldPosition(tmpPos); frame.getWorldQuaternion(tmpQuat);
        tmpQuat.premultiply(_cafiFixtureYawQuat);
      } else { tmpPos.copy(g.position); tmpQuat.copy(g.quaternion); }
      useAttached = true; ox = CAFI_OFFSET_ATTACHED[0]; oy = CAFI_OFFSET_ATTACHED[1]; oz = CAFI_OFFSET_ATTACHED[2];
    } else {
      const seat = cafiSeatTarget(entity, layout, stackIndex);
      if (seat) tmpPos.set(seat[0], seat[1], seat[2]); else tmpPos.copy(g.position);
      // Orientación del seat:
      //   · VISIÓN → yaw del seat de cámara (alineado al gripper).
      //   · BINS → la MISMA rotación que tenía en el gripper al soltar (no se
      //     reorienta: cae "tal cual" lo dejó el cobot).
      //   · banda/otros → identity.
      const atVision = entity.state === 'IN_INSPECTION' || entity.state === 'INSPECTED_PASS' || entity.state === 'INSPECTED_FAIL';
      const atBin = entity.state === 'ACCEPTED_BIN' || entity.state === 'REJECTED_BIN';
      if (atVision) tmpQuat.copy(_visionSeatYawQuat);
      else if (atBin && releaseSetRef.current) tmpQuat.copy(releaseQuat);
      else tmpQuat.identity();
    }

    // geometría/offset/color (en 'hold' conserva lo que tenía: pieza aún en su fuente)
    if (mode !== 'hold') {
      const wantGeom = useAttached ? geomAttached : geomStatic;
      if (m.geometry !== wantGeom) m.geometry = wantGeom;
      m.position.set(ox, oy, oz);
      m.rotation.set(Math.PI / 2, 0, 0);
    }
    const mat = m.material as THREE.MeshStandardMaterial;
    const desired = entity.verdict === 'PASS' ? CAFI_COLOR_ACCEPT : entity.verdict === 'FAIL' ? CAFI_COLOR_REJECT : CAFI_COLOR_NATURAL;
    if (`#${mat.color.getHexString()}` !== desired) mat.color.set(desired);

    // 3) Detección de RELEASE (carried → no carried). Captura la orientación del
    // gripper para que en BINS la pieza caiga "tal cual" (sin reorientarse).
    const releasing = wasCarriedRef.current && !isCarried;
    wasCarriedRef.current = isCarried;
    if (isCarried) { pendingDropRef.current = false; dropRef.current = null; }
    else if (releasing) { pendingDropRef.current = true; releaseQuat.copy(g.quaternion); releaseSetRef.current = true; }
    if (mode !== 'conveyor') convCurRef.current = null;

    // 4) Aplicar posición. PRINCIPIO: la pieza SÓLO cambia de lugar por pick
    // (attach→gripper) o place (detach→caída al seat). Si no, ESPERA donde está.
    if (isCarried) {
      g.position.copy(tmpPos); g.quaternion.copy(tmpQuat);
      carriedPosRef.copy(g.position); positionedRef.current = true;
    } else if (pendingDropRef.current && (mode === 'fixture' || mode === 'static') && !dropRef.current) {
      // seat ya conocido → arranca la CAÍDA desde el punto de release
      dropRef.current = { t: 0, from: carriedPosRef.clone(), fromQuat: g.quaternion.clone() };
      pendingDropRef.current = false;
    }
    if (dropRef.current) {
      const d = dropRef.current;
      d.t += Math.min(0.05, dt);
      const u = Math.min(1, d.t / CAFI_DROP_DUR);
      const e = easeOutCubic(u);
      g.position.lerpVectors(d.from, tmpPos, e);
      g.quaternion.copy(d.fromQuat).slerp(tmpQuat, e);
      positionedRef.current = true;
      if (u >= 1) dropRef.current = null;
    } else if (isCarried) {
      // ya aplicado arriba
    } else if (pendingDropRef.current) {
      g.position.copy(carriedPosRef);            // sostén en el release hasta saber el seat
    } else if (mode === 'hold') {
      // ESPERA donde estaba (aún no lo recoge el cobot). Si nunca se posicionó
      // (estado IN_GRIPPER en el primer frame), no lo muestres en el origen.
      if (!positionedRef.current) g.visible = false;
    } else if (mode === 'conveyor') {
      if (!convCurRef.current) convCurRef.current = tmpPos.clone();
      else {
        const c = convCurRef.current;
        const dir = tmpPos.clone().sub(c);
        const dist = dir.length();
        if (dist > 1e-5) c.addScaledVector(dir.normalize(), Math.min(dist, CONVEYOR_SPEED * Math.min(0.05, dt)));
      }
      g.position.copy(convCurRef.current); g.quaternion.copy(tmpQuat); positionedRef.current = true;
    } else {
      g.position.copy(tmpPos); g.quaternion.copy(tmpQuat); positionedRef.current = true;
    }
  });

  return (
    <group ref={groupRef}>
      <mesh ref={meshRef} geometry={geomStatic} scale={[0.001, 0.001, 0.001]}
        position={CAFI_OFFSET_CENTERED} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <meshStandardMaterial color={CAFI_COLOR_NATURAL} metalness={0.25} roughness={0.55} />
      </mesh>
      {showDebug && (
        <>
          <mesh><sphereGeometry args={[0.012, 8, 8]} /><meshBasicMaterial color="#00e5ff" wireframe /></mesh>
          <Html position={[0, 0, 0.085]} center zIndexRange={[14, 0]}>
            <div style={{ fontSize: 8, color: '#00e5ff', background: 'rgba(6,16,28,0.8)', border: '1px solid #00e5ff55', padding: '1px 4px', borderRadius: 3, whiteSpace: 'nowrap', fontFamily: 'monospace', pointerEvents: 'none' }}>
              #{entity.id} {entity.state}
            </div>
          </Html>
        </>
      )}
    </group>
  );
}

// Mapea la lista de CAFIs de la FSM a una malla por entidad (modo HMI).
function CafiEntities({
  cafis, carriedCafiIdRef, cobotRobotRef, turntableRobotRef,
  graspYawRef, graspPitchRef, graspRollRef, graspOffsetXRef, graspOffsetYRef, graspOffsetZRef,
  layout, showDebug,
}: {
  cafis: CafiEntity[];
  carriedCafiIdRef: React.MutableRefObject<number | null>;
  cobotRobotRef: React.MutableRefObject<URDFRobot | null>;
  turntableRobotRef: React.MutableRefObject<URDFRobot | null>;
  graspYawRef: React.MutableRefObject<number>;
  graspPitchRef: React.MutableRefObject<number>;
  graspRollRef: React.MutableRefObject<number>;
  graspOffsetXRef: React.MutableRefObject<number>;
  graspOffsetYRef: React.MutableRefObject<number>;
  graspOffsetZRef: React.MutableRefObject<number>;
  layout: LayoutOffsets;
  showDebug: boolean;
}) {
  const [geomAttached, geomStatic] = useLoader(STLLoader, [
    '/meshes/v53/turntable/cafi.stl',
    '/meshes/v53/cell/cafi.STL',
  ]);
  let acc = 0, rej = 0;
  return (
    <>
      {cafis.map((c) => {
        let stack = 0;
        if (c.state === 'ACCEPTED_BIN') stack = acc++;
        else if (c.state === 'REJECTED_BIN') stack = rej++;
        return (
          <CafiPiece key={c.id} entity={c} stackIndex={stack}
            carriedCafiIdRef={carriedCafiIdRef} cobotRobotRef={cobotRobotRef} turntableRobotRef={turntableRobotRef}
            graspYawRef={graspYawRef} graspPitchRef={graspPitchRef} graspRollRef={graspRollRef}
            graspOffsetXRef={graspOffsetXRef} graspOffsetYRef={graspOffsetYRef} graspOffsetZRef={graspOffsetZRef}
            layout={layout} geomAttached={geomAttached} geomStatic={geomStatic} showDebug={showDebug} />
        );
      })}
    </>
  );
}

// ── Sequence player ──────────────────────────────────────────────────────────
// Drives jointsRef + discAngleRef + gripperRef + cafiStateRef + cafiColorRef
// from p.sequence using cosine-eased interpolation between consecutive poses.
// The sequence is per-run (built by buildSequence(verdict)) so accept/reject
// trajectories share the same player.
interface PlayerState {
  playing: boolean;
  step: number;     // current index into p.sequence
  t: number;        // elapsed time within current step (seconds)
  startJoints: [number, number, number, number, number, number];
  startDisc: number;
  sequence: SequenceStep[];
  verdict: Verdict;
}

function SequencePlayer({
  playerRef,
  jointsRef,
  discAngleRef,
  gripperRef,
  cafiStateRef,
  cafiColorRef,
  jogCmdRef,
}: {
  playerRef: React.MutableRefObject<PlayerState>;
  jointsRef: React.MutableRefObject<[number, number, number, number, number, number]>;
  discAngleRef: React.MutableRefObject<number>;
  gripperRef: React.MutableRefObject<number>;
  cafiStateRef: React.MutableRefObject<CafiState>;
  cafiColorRef: React.MutableRefObject<CafiColor>;
  jogCmdRef: React.MutableRefObject<{ kind: 'joint' | 'linear'; axis: number; dir: number } | null>;
}) {
  useFrame((_, dt) => {
    if (jogCmdRef.current) return;   // jog manual del TeachPendant tiene prioridad
    const p = playerRef.current;
    if (!p.playing) return;
    const seq = p.sequence;
    const step = seq[p.step];
    if (!step) { p.playing = false; return; }

    // First entry into a step? Snapshot the start state.
    if (p.t === 0) {
      p.startJoints = [...jointsRef.current] as PlayerState['startJoints'];
      p.startDisc = discAngleRef.current;
      // For instantaneous "set" steps, apply immediately.
      if (step.kind === 'cafi')      cafiStateRef.current = step.state;
      if (step.kind === 'cafiColor') cafiColorRef.current = step.color;
      if (step.kind === 'gripper')   gripperRef.current = step.open ? GRIPPER_OPEN_M : GRIPPER_CLOSED_M;
    }

    p.t += dt;

    let done = false;
    if (step.kind === 'pose') {
      const target = POSE_LIB[step.pose];
      // Duración por TIPO de movimiento (joint/linear/pick-place), derivada del
      // mayor Δjoint → joint rápido, linear lento, pick/place muy lento.
      const dur = Math.max(0.0001, moveDurationFor(p.startJoints, target, step.speed));
      const u = Math.min(1, p.t / dur);
      const eased = smoothstep(u);            // sin overshoot/rebote
      for (let i = 0; i < 6; i++) {
        jointsRef.current[i] =
          p.startJoints[i] + (target[i] - p.startJoints[i]) * eased;
      }
      if (u >= 1) {
        for (let i = 0; i < 6; i++) jointsRef.current[i] = target[i]; // snap exacto
        done = true;
      }
    } else if (step.kind === 'disc') {
      const dur = Math.max(0.0001, step.duration);
      const u = Math.min(1, p.t / dur);
      const eased = 0.5 * (1 - Math.cos(Math.PI * u));
      discAngleRef.current = p.startDisc + (step.target - p.startDisc) * eased;
      if (u >= 1) done = true;
    } else if (step.kind === 'gripper') {
      if (p.t >= step.dwell) done = true;
    } else if (step.kind === 'cafi' || step.kind === 'cafiColor') {
      done = true; // instantaneous
    } else if (step.kind === 'wait') {
      if (p.t >= step.dwell) done = true;
    }

    if (done) {
      p.step += 1;
      p.t = 0;
      if (p.step >= seq.length) p.playing = false;
    }
  });
  return null;
}

// ── Binder visual ROS-like ───────────────────────────────────────────────────
// Hace que la escena SIGA a la máquina de estados pura (la fuente de verdad).
// SÓLO actúa en modo HMI: lee el snapshot cada frame y escribe los refs del
// cobot (pose por etapa, con suavizado), del gripper, y de la CAFI primaria
// (estado visual + color por veredicto).  En modo DEBUG retorna de inmediato y
// deja los refs a los controles manuales (separación HMI/DEBUG).  El ángulo del
// disco lo escribe el hook `useCellSimulation` (también sólo en HMI).
// Pose del cobot según su tarea actual (recurso único). El acepta/rechaza ya
// viene codificado en la tarea (PLACE_ACCEPT / PLACE_REJECT), sin override.
const COBOT_TASK_POSE: Record<CobotTask, PoseName> = {
  IDLE:            'HOME',
  PICK_CONVEYOR:   'PICK_CONVEYOR',
  PLACE_OUTSIDE:   'PLACE_RIVET',
  PICK_RIVETED:    'PICK_RIVET',
  PLACE_VISION:    'PLACE_CAMERA',
  PICK_VISION:     'PICK_CAMERA',
  PLACE_ACCEPT:    'ACCEPTED_PLACE',
  PLACE_REJECT:    'REJECTED_PLACE',
  RECOVERY_REJECT: 'REJECTED_PLACE',
  RECOVERY_HOME:   'HOME',
};

// Secuencia de PASOS por tarea (el cobot visual es autónomo: la FSM sólo dice
// QUÉ tarea, el timing fino lo maneja este player).  Pasos:
//   move   → interpola los 6 joints hacia la pose (joint-space PURO, SIN IK).
//            `speed` define el ritmo: JOINT=rápido (traslado), LINEAR=lento
//            (approach/lift/retreat), PICK_PLACE=muy lento (descenso final).
//   grip   → fija el target del gripper (cierra/abre); termina al animar el live.
//   wait   → cobot quieto N ms (asentar el agarre/soltado).
//   attach → el CAFI pasa a seguir el gripper (recién aquí se "pega").
//   detach → el CAFI se suelta (vuelve a su posición lógica de la FSM).
// Patrón pick:  SAFE(J)·APPROACH(L)·PRE_PICK(L)·PICK(PP)·cierra·wait·ATTACH·LIFT(L)·RETREAT(L)
// Patrón place: SAFE(J)·APPROACH(L)·PRE_PLACE(L)·PLACE(PP)·wait·abre·DETACH·LIFT(L)·RETREAT(L)
type Step =
  | { k: 'move'; pose: PoseName; speed: MoveSpeed }
  | { k: 'grip'; close: boolean }
  | { k: 'wait'; ms: number }
  | { k: 'attach' }
  | { k: 'detach' };

const TASK_STEPS: Record<CobotTask, Step[]> = {
  IDLE: [{ k: 'move', pose: 'HOME', speed: 'JOINT' }],
  PICK_CONVEYOR: [
    { k: 'move', pose: 'SAFE_CONVEYOR',     speed: 'JOINT'  },
    { k: 'move', pose: 'APPROACH_CONVEYOR', speed: 'LINEAR' },
    { k: 'move', pose: 'PRE_PICK_CONVEYOR', speed: 'LINEAR' },
    { k: 'move', pose: 'PICK_CONVEYOR',     speed: 'PICK_PLACE' },
    { k: 'grip', close: true },
    { k: 'wait', ms: GRIP_SETTLE_MS },
    { k: 'attach' },
    { k: 'move', pose: 'LIFT_CONVEYOR',     speed: 'LINEAR' },
    { k: 'move', pose: 'RETREAT_CONVEYOR',  speed: 'LINEAR' },
  ],
  PLACE_OUTSIDE: [
    { k: 'move', pose: 'SAFE_RIVET',      speed: 'JOINT'  },
    { k: 'move', pose: 'APPROACH_RIVET',  speed: 'LINEAR' },
    { k: 'move', pose: 'PRE_PLACE_RIVET', speed: 'LINEAR' },
    { k: 'move', pose: 'PLACE_RIVET',     speed: 'PICK_PLACE' },
    { k: 'wait', ms: GRIP_SETTLE_MS },
    { k: 'grip', close: false },
    { k: 'detach' },
    { k: 'move', pose: 'LIFT_RIVET',      speed: 'LINEAR' },
    { k: 'move', pose: 'RETREAT_RIVET',   speed: 'LINEAR' },
  ],
  PICK_RIVETED: [
    { k: 'move', pose: 'SAFE_RIVET',        speed: 'JOINT'  },
    { k: 'move', pose: 'APPROACH_RIVET',    speed: 'LINEAR' },
    { k: 'move', pose: 'PRE_PICK_RIVET',    speed: 'LINEAR' },
    { k: 'move', pose: 'PICK_RIVET',        speed: 'PICK_PLACE' },
    { k: 'grip', close: true },
    { k: 'wait', ms: GRIP_SETTLE_MS },
    { k: 'attach' },
    { k: 'move', pose: 'LIFT_PICK_RIVET',   speed: 'LINEAR' },
    { k: 'move', pose: 'RETREAT_PICK_RIVET', speed: 'LINEAR' },
  ],
  PLACE_VISION: [
    { k: 'move', pose: 'SAFE_CAMERA',          speed: 'JOINT'  },
    { k: 'move', pose: 'APPROACH_PLACE_CAMERA', speed: 'LINEAR' },
    { k: 'move', pose: 'PRE_PLACE_CAMERA',     speed: 'LINEAR' },
    { k: 'move', pose: 'PLACE_CAMERA',         speed: 'PICK_PLACE' },
    { k: 'wait', ms: GRIP_SETTLE_MS },
    { k: 'grip', close: false },
    { k: 'detach' },
    { k: 'move', pose: 'LIFT_PLACE_CAMERA',    speed: 'LINEAR' },
    { k: 'move', pose: 'RETREAT_PLACE_CAMERA', speed: 'LINEAR' }, // = INSPECTION_POSE
  ],
  PICK_VISION: [
    { k: 'move', pose: 'SAFE_CAMERA',          speed: 'JOINT'  },
    { k: 'move', pose: 'APPROACH_PICK_CAMERA', speed: 'LINEAR' },
    { k: 'move', pose: 'PRE_PICK_CAMERA',      speed: 'LINEAR' },
    { k: 'move', pose: 'PICK_CAMERA',          speed: 'PICK_PLACE' },
    { k: 'grip', close: true },
    { k: 'wait', ms: GRIP_SETTLE_MS },
    { k: 'attach' },
    { k: 'move', pose: 'LIFT_PICK_CAMERA',     speed: 'LINEAR' },
    { k: 'move', pose: 'RETREAT_PICK_CAMERA',  speed: 'LINEAR' },
  ],
  // PASS: …FIRST_PLACE_ACCEPTED → abrir → detach (CAFI queda en bin) → wait →
  //       LIFT_PLACE_ACCEPTED → SAFE_RETURN.  SIN HOME (sólo FINALIZAR va a HOME).
  PLACE_ACCEPT: [
    { k: 'move', pose: 'SAFE_BINS',          speed: 'JOINT'  },
    { k: 'move', pose: 'APPROACH_ACCEPTED',  speed: 'JOINT'  },
    { k: 'move', pose: 'PRE_PLACE_ACCEPTED', speed: 'LINEAR' },
    { k: 'move', pose: 'ACCEPTED_PLACE',     speed: 'PICK_PLACE' },
    { k: 'grip', close: false },
    { k: 'detach' },
    { k: 'wait', ms: GRIP_SETTLE_MS },
    { k: 'move', pose: 'LIFT_ACCEPTED',      speed: 'LINEAR' },
    { k: 'move', pose: 'RETREAT_ACCEPTED',   speed: 'LINEAR' },  // = SAFE_RETURN
  ],
  // FAIL: bin distinto (rechazado). Mismo patrón, SIN HOME.
  PLACE_REJECT: [
    { k: 'move', pose: 'SAFE_BINS',         speed: 'JOINT'  },
    { k: 'move', pose: 'APPROACH_REJECTED', speed: 'JOINT'  },
    { k: 'move', pose: 'PRE_REJECTED',      speed: 'LINEAR' },
    { k: 'move', pose: 'REJECTED_PLACE',    speed: 'PICK_PLACE' },
    { k: 'grip', close: false },
    { k: 'detach' },
    { k: 'wait', ms: GRIP_SETTLE_MS },
    { k: 'move', pose: 'LIFT_REJECTED',     speed: 'LINEAR' },
    { k: 'move', pose: 'RETREAT_REJECTED',  speed: 'LINEAR' },  // = SAFE_RETURN
  ],
  RECOVERY_REJECT: [
    { k: 'move', pose: 'SAFE_BINS',         speed: 'JOINT'  },
    { k: 'move', pose: 'APPROACH_REJECTED', speed: 'JOINT'  },
    { k: 'move', pose: 'PRE_REJECTED',      speed: 'LINEAR' },
    { k: 'move', pose: 'REJECTED_PLACE',    speed: 'PICK_PLACE' },
    { k: 'wait', ms: GRIP_SETTLE_MS },
    { k: 'grip', close: false },
    { k: 'detach' },
    { k: 'move', pose: 'RETREAT_REJECTED',  speed: 'LINEAR' },
  ],
  RECOVERY_HOME: [{ k: 'move', pose: 'HOME', speed: 'LINEAR' }],
};

// Precalcula los waypoints (joints) de un tramo LINEAR: FK de la pose inicial y
// la objetivo → recta del TCP (posición lerp, orientación slerp) muestreada en
// `samples` puntos, resolviendo IK local seedeada en cada uno.  Devuelve la
// lista de joints, o null si algún punto no converge (el llamador hace fallback
// a JOINT y reporta cuál pose falló).  Muta el robot internamente (IK); el
// llamador debe restaurar la pose viva al terminar.
function buildLinearWaypoints(
  robot: URDFRobot, group: THREE.Object3D,
  startJoints: number[], targetJoints: number[],
  obstacles: ReturnType<typeof collisionAABBs>, samples: number,
): number[][] | null {
  const posA = new THREE.Vector3(), quatA = new THREE.Quaternion();
  const posB = new THREE.Vector3(), quatB = new THREE.Quaternion();
  applyJoints6(robot, startJoints);  tcpPose(robot, group, posA, quatA);
  applyJoints6(robot, targetJoints); tcpPose(robot, group, posB, quatB);
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
  const wps: number[][] = [];
  let seed = [...startJoints];
  for (let k = 1; k <= samples; k++) {
    const s = k / samples;
    pos.lerpVectors(posA, posB, s);
    quat.copy(quatA).slerp(quatB, s);
    const r = solveIK6DOnce(robot, group, [pos.x, pos.y, pos.z], quat, seed, obstacles);
    if (!r.converged) return null;   // IK no convergió → fallback en el llamador
    seed = r.joints;
    wps.push([...r.joints]);
  }
  return wps;
}

function mapSimCafiToVisual(c: CafiEntity): CafiState {
  switch (c.state) {
    case 'DISPENSED':
    case 'ON_CONVEYOR_WAITING':
    case 'AT_SENSOR':        return 'conveyor';
    case 'IN_GRIPPER':       return 'in_gripper';
    case 'IN_OUTSIDE_FIXTURE':
    case 'IN_RIVET_FIXTURE':
    case 'RIVETING':
    case 'RIVETED':          return c.fixtureId === 'B' ? 'on_fixture_2' : 'on_fixture_1';
    case 'IN_INSPECTION':
    case 'INSPECTED_PASS':
    case 'INSPECTED_FAIL':   return 'at_vision';
    case 'ACCEPTED_BIN':     return 'in_accept_bin';
    case 'REJECTED_BIN':     return 'in_reject_bin';
    default:                 return 'parked';
  }
}

interface MoveState { poly: number[][]; cursor: number; rate: number; kind?: 'linear' | 'joint' }

// ── Animador de movimientos manuales del panel DEBUG (Linear TCP / Set Joints) ─
// Consume `moveRef` (polilínea de joints + cursor) y avanza `jointsRef` con el
// MISMO gating que el cobot ROS-like: techo de COBOT_MAX_JOINT_STEP (0.008
// rad/frame) por joint y fin del movimiento cuando TODOS los joints están a
// ±COBOT_TARGET_EPS (0.005 rad) del objetivo.  El `Cobot` aplica jointsRef al
// URDF cada frame, así que el Telemetry (gripperWorldRef) se actualiza solo.
// Es INDEPENDIENTE de la FSM/cellStateMachine: sólo actúa cuando el panel encola
// un movimiento (manualMoveRef), por lo que funciona en cualquier estado.
function ManualMover({ moveRef, movingRef, jointsRef }: {
  moveRef: React.MutableRefObject<MoveState | null>;
  movingRef: React.MutableRefObject<boolean>;
  jointsRef: React.MutableRefObject<[number, number, number, number, number, number]>;
}) {
  useFrame((_, dt) => {
    const mv = moveRef.current;
    if (!mv) return;
    const end = mv.poly.length - 1;
    mv.cursor = Math.min(end, mv.cursor + mv.rate * Math.min(0.05, dt));
    const seg = Math.min(end - 1, Math.floor(mv.cursor));
    const frac = mv.cursor - seg;
    const a = mv.poly[seg];
    const b = mv.poly[seg + 1];
    const maxStep = Math.min(COBOT_MAX_JOINT_SPEED * Math.min(0.05, dt), COBOT_MAX_JOINT_STEP);
    for (let i = 0; i < 6; i++) {
      const desired = a[i] + (b[i] - a[i]) * frac;
      const cur = jointsRef.current[i];
      const diff = desired - cur;
      const stepLen = Math.min(Math.abs(diff), maxStep);
      jointsRef.current[i] = cur + Math.sign(diff) * stepLen;
    }
    // Fin: cursor al final Y todos los joints dentro de ±EPS del objetivo.
    if (mv.cursor >= end) {
      const fin = mv.poly[end];
      let atFinal = true;
      for (let i = 0; i < 6; i++) if (Math.abs(jointsRef.current[i] - fin[i]) > COBOT_TARGET_EPS) atFinal = false;
      if (atFinal) {
        jointsRef.current = [...fin] as typeof jointsRef.current; // snap exacto
        moveRef.current = null;
        movingRef.current = false;
      }
    }
  });
  return null;
}

function CellVisualBinder({
  machine, jointsRef, gripperRef, gripperLiveRef, cafiStateRef, cafiColorRef,
  cobotRobotRef, cobotGroupRef, obstacles, pickOffsetXRef, jogCmdRef, carriedCafiIdRef,
}: {
  machine: CellStateMachine;
  jointsRef: React.MutableRefObject<[number, number, number, number, number, number]>;
  gripperRef: React.MutableRefObject<number>;
  gripperLiveRef: React.MutableRefObject<number>;
  cafiStateRef: React.MutableRefObject<CafiState>;
  cafiColorRef: React.MutableRefObject<CafiColor>;
  cobotRobotRef: React.MutableRefObject<URDFRobot | null>;
  cobotGroupRef: React.MutableRefObject<THREE.Group | null>;
  obstacles: ReturnType<typeof collisionAABBs>;
  pickOffsetXRef: React.MutableRefObject<number>;
  jogCmdRef: React.MutableRefObject<{ kind: 'joint' | 'linear'; axis: number; dir: number } | null>;
  // CAFI que el cobot VISUAL carga (compartido con CafiEntities). Lo set/clear el
  // player en los pasos attach/detach → el renderizador per-entidad lo lee.
  carriedCafiIdRef: React.MutableRefObject<number | null>;
}) {
  // Player de PASOS: el cobot visual es autónomo. Recibe de la FSM sólo la tarea
  // actual (cobotTask) y ejecuta su secuencia (TASK_STEPS) paso a paso. Una tarea
  // nueva no arranca hasta terminar la secuencia en curso (gating). El attach del
  // CAFI ocurre en el paso `attach` (tras pick + cierre + wait), no antes.
  const planTaskRef = useRef<CobotTask | null>(null);
  const stepsRef = useRef<Step[]>([]);
  const stepIdxRef = useRef(0);
  // Animación del tramo actual: interpolación temporizada joint-space (sin IK).
  const animRef = useRef<{ start: Joints6; target: Joints6; dur: number; t: number } | null>(null);
  const waitTRef = useRef(0);
  const cafiAttachedRef = useRef(false);
  const idleRestPoseRef = useRef<'HOME' | 'HOLD' | null>(null); // modo de descanso IDLE: HOME (parado) o HOLD (no mover)
  // CAFI de la tarea VISUAL en curso, capturado al CARGAR la tarea. El attach ata
  // ESTE id (no snap.activeCafiId actual): la FSM va más rápido y puede reasignar
  // activeCafiId antes de que el cobot visual llegue al pick → ataba el equivocado
  // y la otra pieza se teletransportaba. Así sólo se mueve la pieza correcta.
  const taskCafiIdRef = useRef<number | null>(null);
  // Ya se avisó a la FSM que esta tarea visual terminó (lockstep). Se resetea al
  // cargar tarea; se marca en attach/detach (o al cerrar la secuencia si no hay).
  const signaledRef = useRef(false);

  useFrame((_, dt) => {
    // Jog manual del TeachPendant en curso → el binder CEDE jointsRef este frame
    // (el ManualJogger es el único que escribe). Al soltar, el binder retoma.
    if (jogCmdRef.current) return;
    const snap = machine.snapshot();
    if (snap.mode !== 'HMI') return; // DEBUG: los controles manuales son dueños.
    const robot = cobotRobotRef.current;
    const group = cobotGroupRef.current;
    const task = snap.cobotTask;
    const frozen = snap.cell === 'PAUSED' || snap.cell === 'FAULT'; // STOP → congela

    // ── 1) Intérprete de la secuencia del cobot ──────────────────────────────
    if (robot && group && !frozen) {
      // (Re)cargar la secuencia al cambiar de tarea, sólo si la anterior terminó.
      // CAMBIO: en IDLE el cobot NO se va a HOME durante producción y TAMPOCO se
      // mueve a SAFE_RETURN por su cuenta. Mientras la celda está RUNNING y libre,
      // se QUEDA donde está (HOLD): al arrancar sigue en HOME; tras un ciclo se
      // queda en SAFE_RETURN (ahí terminan PLACE_ACCEPT/REJECT). Sólo va a HOME
      // cuando la celda NO está RUNNING (arranque inicial / STOP→IDLE / FINALIZAR).
      const seqDone = stepIdxRef.current >= stepsRef.current.length;
      let nextSteps: Step[] | null = null;
      if (task === 'IDLE') {
        const restMode: 'HOME' | 'HOLD' = snap.cell === 'RUNNING' ? 'HOLD' : 'HOME';
        if (seqDone && (planTaskRef.current !== 'IDLE' || idleRestPoseRef.current !== restMode)) {
          nextSteps = restMode === 'HOME' ? [{ k: 'move', pose: 'HOME', speed: 'JOINT' }] : [];
          idleRestPoseRef.current = restMode;
        }
      } else if (seqDone && planTaskRef.current !== task) {
        nextSteps = TASK_STEPS[task];
      }
      if (nextSteps) {
        stepsRef.current = nextSteps;
        stepIdxRef.current = 0;
        animRef.current = null;
        waitTRef.current = 0;
        planTaskRef.current = task;
        taskCafiIdRef.current = snap.activeCafiId; // CAFI de ESTA tarea (estable durante ella)
        signaledRef.current = false;               // nueva tarea: aún no avisamos a la FSM
      }

      const steps = stepsRef.current;
      if (stepIdxRef.current < steps.length) {
        const step = steps[stepIdxRef.current];
        let stepDone = false;
        if (step.k === 'move') {
          // Movimiento joint-space PURO (sin IK, sin inventar poses): interpolación
          // temporizada con smoothstep. La duración la fija el TIPO (JOINT rápido,
          // LINEAR lento, PICK_PLACE muy lento). Snap exacto al final → sin overshoot.
          if (!animRef.current) {
            const start = [...jointsRef.current] as Joints6;
            const target = [...POSE_LIB[step.pose]] as Joints6;
            animRef.current = {
              start, target,
              dur: moveDurationFor(start, target, step.speed),
              t: 0,
            };
          }
          const mv = animRef.current;
          mv.t += Math.min(0.05, dt);
          const u = Math.min(1, mv.t / mv.dur);
          const eased = smoothstep(u);
          for (let i = 0; i < 6; i++) {
            jointsRef.current[i] = mv.start[i] + (mv.target[i] - mv.start[i]) * eased;
          }
          if (u >= 1) {
            for (let i = 0; i < 6; i++) jointsRef.current[i] = mv.target[i]; // snap exacto
            animRef.current = null;
            stepDone = true;
          }
        } else if (step.k === 'grip') {
          gripperRef.current = step.close ? GRIPPER_CLOSED_M : GRIPPER_OPEN_M;
          // Termina cuando el gripper animado (live) alcanzó el target.
          if (Math.abs(gripperLiveRef.current - gripperRef.current) < 1e-4) stepDone = true;
        } else if (step.k === 'wait') {
          waitTRef.current += dt;
          if (waitTRef.current * 1000 >= step.ms) { waitTRef.current = 0; stepDone = true; }
        } else if (step.k === 'attach') {
          // El cobot visual YA tomó la pieza → avisa a la FSM que la tarea (pick)
          // terminó (lockstep). La FSM marca IN_GRIPPER y agenda la siguiente.
          cafiAttachedRef.current = true; carriedCafiIdRef.current = taskCafiIdRef.current ?? snap.activeCafiId;
          machine.notifyCobotVisualDone(); signaledRef.current = true; stepDone = true;
        } else if (step.k === 'detach') {
          // El cobot visual YA soltó la pieza → avisa a la FSM (lockstep). La FSM
          // pone la pieza en su destino justo cuando abre el gripper → la caída
          // ocurre en el momento correcto (no flotando ni teletransportada).
          cafiAttachedRef.current = false; carriedCafiIdRef.current = null;
          machine.notifyCobotVisualDone(); signaledRef.current = true; stepDone = true;
        }
        if (stepDone) stepIdxRef.current += 1;
      }

      // Tareas sin attach/detach (p. ej. RECOVERY_HOME): avisar al cerrar la
      // secuencia para que la FSM no espere el timer largo.
      if (stepIdxRef.current >= stepsRef.current.length && !signaledRef.current
          && planTaskRef.current !== null && planTaskRef.current !== 'IDLE') {
        machine.notifyCobotVisualDone(); signaledRef.current = true;
      }
    }

    // ── 2) CAFI primaria: el attach lo manda el player, no el estado FSM ──────
    const primaryId = snap.activeCafiId ?? snap.sensorCafiId;
    const primary = primaryId != null ? snap.cafis.find((c) => c.id === primaryId) : null;
    if (primary) {
      const fsmVis = mapSimCafiToVisual(primary);
      const visTask = planTaskRef.current; // tarea que el cobot VISUAL ejecuta
      const isPick = visTask === 'PICK_CONVEYOR' || visTask === 'PICK_RIVETED' || visTask === 'PICK_VISION';
      const isPlace = visTask === 'PLACE_OUTSIDE' || visTask === 'PLACE_VISION' ||
        visTask === 'PLACE_ACCEPT' || visTask === 'PLACE_REJECT' || visTask === 'RECOVERY_REJECT';
      // ¿Ya pasó el paso `detach` de la secuencia actual? (CAFI soltado en destino)
      const detachDone = stepsRef.current.findIndex((s) => s.k === 'detach') >= 0 &&
        stepIdxRef.current > stepsRef.current.findIndex((s) => s.k === 'detach');
      let vis: CafiState;
      let fromHold = false;
      if (cafiAttachedRef.current && primary.id === carriedCafiIdRef.current) {
        vis = 'in_gripper';                       // el player ya lo "pegó" (pieza cargada)
      } else if (isPlace && detachDone) {
        // Tras soltar (open + detach) el CAFI QUEDA en su destino — no debe
        // seguir al gripper en el lift/retreat ni teletransportarse (CAMBIO 5).
        vis = visTask === 'PLACE_VISION' ? 'at_vision'
          : visTask === 'PLACE_ACCEPT' ? 'in_accept_bin'
          : (visTask === 'PLACE_REJECT' || visTask === 'RECOVERY_REJECT') ? 'in_reject_bin'
          : (snap.outsideFixtureId === 'B' ? 'on_fixture_2' : 'on_fixture_1'); // PLACE_OUTSIDE
      } else if (fsmVis === 'in_gripper' && isPick && !cafiAttachedRef.current) {
        // La FSM ya marcó IN_GRIPPER pero el cobot visual aún no completó el
        // pick: mantener el CAFI en su FUENTE hasta el paso `attach`.
        vis = visTask === 'PICK_RIVETED'
          ? (snap.outsideFixtureId === 'B' ? 'on_fixture_2' : 'on_fixture_1')
          : visTask === 'PICK_VISION' ? 'at_vision'
            : 'conveyor';                          // PICK_CONVEYOR: CafiMesh estático en el sensor
        fromHold = true;
      } else {
        vis = fsmVis;
      }
      // La banda en viaje normal la dibuja WaitingCafis (parked en CafiMesh); el
      // hold de pick en 'conveyor' SÍ lo dibuja CafiMesh, no se parkea.
      cafiStateRef.current = (vis === 'conveyor' && !fromHold) ? 'parked' : vis;
      cafiColorRef.current =
        primary.verdict === 'PASS' ? 'accept' :
        primary.verdict === 'FAIL' ? 'reject' : 'natural';
    } else {
      cafiAttachedRef.current = false;
      carriedCafiIdRef.current = null;
      cafiStateRef.current = 'parked';
      cafiColorRef.current = 'natural';
    }
  });
  return null;
}

// ── CAFIs secundarias (cola + piezas ya depositadas en bins) ──────────────────
// La CAFI primaria la dibuja `CafiMesh` (sigue gripper/fixture).  Aquí se
// renderizan las DEMÁS piezas: las que esperan en banda/suministro (cola de
// hasta 2) y las acumuladas en los bins.  Usan el MISMO modelo STL real que la
// primaria (cell/cafi.STL, ya cacheado por CafiMesh) — coherencia visual en
// todas las etapas.  En la banda viajan con interpolación lineal suave; en los
// bins aparecen directamente.
const WAITING_CAFI_POS: Partial<Record<CafiEntity['state'], [number, number, number]>> = {
  AT_SENSOR:           [1.387345, 1.365, 1.0645], // banda 1.052 + 0.0125 (igual que CAFI_AT.conveyor)
  ON_CONVEYOR_WAITING: [1.740, 1.365, 1.0825], // viajando por la banda
  DISPENSED:           [1.920, 1.365, 1.0825], // recién dispensada en el suministro
  ACCEPTED_BIN:        [1.650, 0.720, 1.020],
  REJECTED_BIN:        [1.330, 0.700, 1.020],
};

// Estados en los que la pieza viaja por la banda (se interpola a CONVEYOR_SPEED).
const CONVEYOR_TRAVEL_STATES: ReadonlyArray<CafiEntity['state']> = [
  'DISPENSED', 'ON_CONVEYOR_WAITING', 'AT_SENSOR',
];

// Una CAFI secundaria en banda/bin.  Mantiene su posición actual en un ref y se
// desplaza linealmente hacia el objetivo a CONVEYOR_SPEED (dt real) cuando
// `travel` es true; si no, salta directo (bins).  Mismo STL/offset/rotación que
// la CafiMesh estática para que se vea idéntica a la primaria.
function ConveyorCafi({
  target, travel, color, geom,
}: {
  target: [number, number, number];
  travel: boolean;
  color: string;
  geom: THREE.BufferGeometry;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const cur = useRef<THREE.Vector3 | null>(null);
  const tgt = useMemo(() => new THREE.Vector3(), []);
  const dir = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    const g = groupRef.current;
    if (!g) return;
    tgt.set(target[0], target[1], target[2]);
    if (!cur.current) {
      cur.current = tgt.clone();                 // primera aparición: sin viaje
    } else if (travel) {
      const c = cur.current;
      dir.copy(tgt).sub(c);
      const dist = dir.length();
      if (dist > 1e-5) {
        const stepLen = Math.min(dist, CONVEYOR_SPEED * Math.min(0.05, dt));
        c.addScaledVector(dir.normalize(), stepLen);
      }
    } else {
      cur.current.copy(tgt);                      // bins: directo
    }
    g.position.copy(cur.current);
  });
  return (
    <group ref={groupRef}>
      <mesh
        geometry={geom}
        scale={[0.001, 0.001, 0.001]}
        position={CAFI_OFFSET_CENTERED}
        rotation={[Math.PI / 2, 0, 0]}
        castShadow
      >
        <meshStandardMaterial color={color} metalness={0.25} roughness={0.55} />
      </mesh>
    </group>
  );
}

function WaitingCafis({ cafis, primaryId, layout = ZERO_LAYOUT, zLift = 0 }: { cafis: CafiEntity[]; primaryId: number | null; layout?: LayoutOffsets; zLift?: number }) {
  // cell/cafi.STL: ya lo carga CafiMesh para los estados estáticos → cacheado.
  const geomStatic = useLoader(STLLoader, '/meshes/v53/cell/cafi.STL');
  let acceptStack = 0;
  let rejectStack = 0;
  return (
    <>
      {cafis.map((c) => {
        const isConveyor = CONVEYOR_TRAVEL_STATES.includes(c.state);
        // El primario lo dibuja CafiMesh, EXCEPTO en banda: ahí lo dibuja aquí
        // para que viaje continuo y el handoff al sensor no tenga salto.
        if (c.id === primaryId && !isConveyor) return null;
        const pos = WAITING_CAFI_POS[c.state];
        if (!pos) return null;
        // Offset de layout: banda → conveyor, bins → su bin (X,Y; Z sin cambio).
        const off = isConveyor ? layout.conveyorOffset
          : c.state === 'ACCEPTED_BIN' ? layout.binAcceptOffset
          : c.state === 'REJECTED_BIN' ? layout.binRejectOffset
          : [0, 0] as [number, number];
        // Apila piezas en los bins para que no se solapen.
        let dz = 0;
        if (c.state === 'ACCEPTED_BIN') dz = (acceptStack++) * 0.028;
        else if (c.state === 'REJECTED_BIN') dz = (rejectStack++) * 0.028;
        const color =
          c.verdict === 'PASS' ? CAFI_COLOR_ACCEPT :
          c.verdict === 'FAIL' ? CAFI_COLOR_REJECT : CAFI_COLOR_NATURAL;
        return (
          <ConveyorCafi
            key={c.id}
            target={[pos[0] + off[0], pos[1] + off[1], pos[2] + dz + zLift]}
            travel={isConveyor}
            color={color}
            geom={geomStatic}
          />
        );
      })}
    </>
  );
}

// ── CAFIs montadas en el disco (2ª pieza concurrente, sigue el frame URDF) ────
// Estados montados que NO dibuja la CafiMesh primaria. Cada pieza copia la pose
// mundial del frame del fixture (cafi_part_1_link / cafi_part_2_link) cada frame,
// así rota con el disco. Permite ver DOS CAFIs en el disco a la vez.
const MOUNTED_VIS_STATES: ReadonlyArray<CafiEntity['state']> = [
  'IN_OUTSIDE_FIXTURE', 'IN_RIVET_FIXTURE', 'RIVETING', 'RIVETED',
];

function CafiOnFixture({ fixtureId, color, robotRef }: {
  fixtureId: 'A' | 'B';
  color: string;
  robotRef: React.MutableRefObject<URDFRobot | null>;
}) {
  // turntable/cafi.stl: el mismo STL/offset que usa CafiMesh en on_fixture_*
  // (ya cacheado) → la 2ª pieza se ve idéntica a la primaria y rota con el disco.
  const geomAttached = useLoader(STLLoader, '/meshes/v53/turntable/cafi.stl');
  const groupRef = useRef<THREE.Group>(null);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const quat = useMemo(() => new THREE.Quaternion(), []);
  useFrame(() => {
    const robot = robotRef.current;
    const g = groupRef.current;
    if (!robot || !g) return;
    const frameName = fixtureId === 'B' ? 'cafi_part_2_link' : 'cafi_part_1_link';
    const frame = robot.frames[frameName] ?? robot.getObjectByName(frameName);
    if (!frame) { g.visible = false; return; }
    robot.updateMatrixWorld(true);
    frame.getWorldPosition(pos);
    frame.getWorldQuaternion(quat);
    g.visible = true;
    g.position.copy(pos);
    g.quaternion.copy(quat).premultiply(_cafiFixtureYawQuat); // mismo giro que CafiMesh on_fixture
  });
  return (
    <group ref={groupRef}>
      <mesh
        geometry={geomAttached}
        scale={[0.001, 0.001, 0.001]}
        position={CAFI_OFFSET_ATTACHED}
        rotation={[Math.PI / 2, 0, 0]}
        castShadow
      >
        <meshStandardMaterial color={color} metalness={0.25} roughness={0.55} />
      </mesh>
    </group>
  );
}

function FixtureCafis({ cafis, primaryId, robotRef }: {
  cafis: CafiEntity[];
  primaryId: number | null;
  robotRef: React.MutableRefObject<URDFRobot | null>;
}) {
  return (
    <>
      {cafis
        .filter((c) => c.id !== primaryId && c.fixtureId != null && MOUNTED_VIS_STATES.includes(c.state))
        .map((c) => (
          <CafiOnFixture
            key={c.id}
            fixtureId={c.fixtureId === 'B' ? 'B' : 'A'}
            color={c.verdict === 'PASS' ? CAFI_COLOR_ACCEPT : c.verdict === 'FAIL' ? CAFI_COLOR_REJECT : CAFI_COLOR_NATURAL}
            robotRef={robotRef}
          />
        ))}
    </>
  );
}

// ── Turntable (loaded URDF, disc-driven) ─────────────────────────────────────
export function Turntable({
  angleRef, robotRef, offset = [0, 0], zLift = 0,
}: {
  angleRef: React.MutableRefObject<number>;
  robotRef: React.MutableRefObject<URDFRobot | null>;
  // Offset X,Y opcional (default [0,0]) — Cobot en Vivo alinea el disco a las
  // poses reales (PICK_FIXTURE_1/2) sin tocar Celda 3D. Z nunca cambia.
  offset?: [number, number];
  // Subida visual en Z del disco (Celda 3D pasa BASE_TURNTABLE; Cobot en Vivo
  // omite → 0). Sus frames de fixture suben → las CAFIs montadas los siguen solas.
  zLift?: number;
}) {
  const robot = useUrdf('/urdf/turntable_rivet_cell_v43.urdf');
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
    // V38 URDF: table_rotation_joint tiene rango [-π, 0] (0°→−180°). La sim/HMI
    // expresan el ángulo del disco como magnitud positiva (HOME=0°, WORK=+180°),
    // así que lo negamos AQUÍ para caer dentro del límite del joint. Si pasáramos
    // un valor positivo, urdf-loader lo recortaría a 0 y el disco no indexaría.
    robot.setJointValue('table_rotation_joint', -angleRef.current);
    // Without forcing matrixWorld, downstream consumers (CafiMesh querying
    // the fixture frames) read the previous frame's pose and the CAFI
    // appears to lag/snap instead of following the rotating disc.
    if (groupRef.current) groupRef.current.updateMatrixWorld(true);
  });
  if (!robot) return null;
  return (
    <group ref={groupRef} position={[TURNTABLE_BASE[0] + offset[0], TURNTABLE_BASE[1] + offset[1], TURNTABLE_BASE[2] + zLift]}>
      <primitive object={robot} />
    </group>
  );
}

// ── Alineación de layout a las poses reales (compartida Celda 3D ↔ Cobot en Vivo) ─
// Mueve los objetos en X,Y para que el gripper caiga sobre ellos en las poses de
// pick/place reales. Usa el ASIENTO del CAFI (cafi_lateral_target_frame por FK),
// no el TCP del dedo. NO toca Z. Anclas = punto de recepción actual de cada objeto
// (CAFI_AT). El disco se alinea al fixture que esté del lado del pick (PICK_RIVET).
const LO_CONVEYOR_ANCHOR: [number, number] = [1.387345, 1.365];
const LO_VISION_ANCHOR:   [number, number] = [0.750, 0.804];
const LO_ACCEPT_ANCHOR:   [number, number] = [1.650, 0.720];
const LO_REJECT_ANCHOR:   [number, number] = [1.330, 0.700];

export interface LayoutOffsets {
  conveyorOffset: [number, number];
  visionOffset: [number, number];
  binAcceptOffset: [number, number];
  binRejectOffset: [number, number];
  turntableOffset: [number, number];
}
export const ZERO_LAYOUT: LayoutOffsets = {
  conveyorOffset: [0, 0], visionOffset: [0, 0],
  binAcceptOffset: [0, 0], binRejectOffset: [0, 0], turntableOffset: [0, 0],
};

const _csPos = new THREE.Vector3();
// Asiento del CAFI en world (m) para unos joints (RAD). El robot de useUrdf tiene
// su raíz en el origen → la posición leída es relativa a la raíz; le sumo COBOT_BASE.
export function cafiSeatWorld(robot: URDFRobot, jointsRad: readonly number[]): [number, number, number] | null {
  for (let i = 0; i < 6; i++) robot.setJointValue(`joint_${i + 1}`, jointsRad[i]);
  robot.updateMatrixWorld(true);
  const frame = robot.frames['cafi_lateral_target_frame'] ?? robot.getObjectByName('cafi_lateral_target_frame');
  if (!frame) return null;
  frame.getWorldPosition(_csPos);
  return [_csPos.x + COBOT_BASE[0], _csPos.y + COBOT_BASE[1], _csPos.z + COBOT_BASE[2]];
}

// Calcula los offsets X,Y por FK (instancias propias del URDF, no perturban la
// escena en vivo). Misma fuente de poses que el sim (POSE_LIB) → Celda 3D y Cobot
// en Vivo quedan idénticos. enabled=false → todo [0,0] (layout original).
export function useLayoutOffsets(enabled: boolean): LayoutOffsets {
  const cobot = useUrdf('/urdf/lexium_cobot.urdf');
  const tt = useUrdf('/urdf/turntable_rivet_cell_v43.urdf');
  return useMemo(() => {
    if (!enabled || !cobot) return ZERO_LAYOUT;
    const seat = (key: PoseName): [number, number] | null => {
      const w = cafiSeatWorld(cobot, POSE_LIB[key]);
      return w ? [w[0], w[1]] : null;
    };
    const delta = (s: [number, number] | null, a: [number, number]): [number, number] =>
      s ? [s[0] - a[0], s[1] - a[1]] : [0, 0];
    // Disco: FK del turntable a ángulo 0 → world de cada fixture; alineo el más
    // cercano al asiento de PICK_RIVET (el que está del lado del cobot).
    let turntableOffset: [number, number] = [0, 0];
    const sFix = seat('PICK_RIVET');
    if (tt && sFix) {
      tt.setJointValue('table_rotation_joint', 0);
      tt.updateMatrixWorld(true);
      const fw = (name: string): [number, number] | null => {
        const f = tt.frames[name] ?? tt.getObjectByName(name);
        if (!f) return null;
        const v = new THREE.Vector3(); f.getWorldPosition(v);
        return [v.x + TURNTABLE_BASE[0], v.y + TURNTABLE_BASE[1]];
      };
      const cands = [fw('cafi_part_1_link'), fw('cafi_part_2_link')].filter(Boolean) as [number, number][];
      if (cands.length) {
        const near = cands.reduce((b, p) =>
          Math.hypot(p[0] - sFix[0], p[1] - sFix[1]) < Math.hypot(b[0] - sFix[0], b[1] - sFix[1]) ? p : b);
        turntableOffset = [sFix[0] - near[0], sFix[1] - near[1]];
      }
    }
    return {
      conveyorOffset:  delta(seat('PICK_CONVEYOR'), LO_CONVEYOR_ANCHOR),
      visionOffset:    delta(seat('PICK_CAMERA'), LO_VISION_ANCHOR),
      binAcceptOffset: delta(seat('ACCEPTED_PLACE'), LO_ACCEPT_ANCHOR),
      binRejectOffset: delta(seat('REJECTED_PLACE'), LO_REJECT_ANCHOR),
      turntableOffset,
    };
  }, [enabled, cobot, tt]);
}

// ── Primitive cell pieces (mesa, cabin, conveyor, bins, etc.) ────────────────
// Offsets X,Y opcionales por bloque (default [0,0]) — los usa SOLO Cobot en Vivo
// para alinear los objetos a las poses reales sin tocar Celda 3D (que llama a
// <CellPrimitives/> sin props → todo queda en su sitio).  NUNCA se desplaza la
// cámara Cognex (congelada) ni se cambia Z.
export function CellPrimitives({
  conveyorOffset = [0, 0],
  visionOffset = [0, 0],
  binAcceptOffset = [0, 0],
  binRejectOffset = [0, 0],
  mesaOffset = [0, 0],
  convBase = 0,
  turntableBase = 0,
  visionBase = 0,
  binsBase = 0,
}: {
  conveyorOffset?: [number, number];
  visionOffset?: [number, number];
  binAcceptOffset?: [number, number];
  binRejectOffset?: [number, number];
  // mesaOffset: desplaza SOLO el worktop gris (MesaTable) — Cobot en Vivo lo
  // iguala al offset del turntable para conservar la relación mesa↔base del
  // turntable (gap 6.2 cm en X, a ras en el borde norte). Default [0,0] → Celda 3D.
  mesaOffset?: [number, number];
  // Bases/elevadores POR ESTACIÓN en Z (Celda 3D pasa BASE_*; Cobot en Vivo omite
  // → 0, intacta). La MESA NO sube. Cada estación se eleva con su riser propio:
  // conveyor, mesa rotatoria/fixtures, plato de visión, bins. NO sube: piso,
  // cámara Cognex (congelada), repisa inferior, HMI de perfil ni cabina externa.
  convBase?: number;
  turntableBase?: number;
  visionBase?: number;
  binsBase?: number;
} = {}) {
  const [cdx, cdy] = conveyorOffset;   // bloque conveyor (banda+sensor+motor+feeder)
  const [vdx, vdy] = visionOffset;     // plato de visión + sensor + cámara Cognex (centrada sobre el plato)
  const [adx, ady] = binAcceptOffset;  // bin aceptado
  const [rdx, rdy] = binRejectOffset;  // bin rechazado
  const [mdx, mdy] = mesaOffset;       // worktop gris (solo la mesa, no el piso)
  return (
    <>
      {/* Floor slab */}
      <mesh position={[MESA_CENTRE[0], MESA_CENTRE[1], -0.0025]} receiveShadow>
        <boxGeometry args={[2.504, 2.098, 0.005]} />
        <meshStandardMaterial color="#1a2740" roughness={0.9} />
      </mesh>

      {/* Mesa: slab + 4 legs (V53 plant_table 1.62 x 0.92 x 1.00). LA MESA NO SUBE
          (topZ fijo 1.000). mesaOffset la desplaza en X,Y (solo Cobot en Vivo). */}
      <MesaTable cx={MESA_CENTRE[0] + mdx} cy={MESA_CENTRE[1] + mdy} sx={1.620} sy={0.920} topZ={1.000} thickness={0.040} legSect={0.060} legInset={0.060} />

      {/* Riser/elevador bajo la MESA ROTATORIA: bloque físico de turntableBase de
          alto sobre el worktop (1.000), para que el disco/fixtures suban a la
          altura del seat real del CAFI (≈ PICK_FIXTURE). Sólo si hay base. */}
      {turntableBase > 0 && (
        <mesh position={[TURNTABLE_BASE[0] + mdx, TURNTABLE_BASE[1] + mdy, 1.000 + turntableBase / 2]} castShadow receiveShadow>
          <boxGeometry args={[0.500, 0.470, turntableBase]} />
          <meshStandardMaterial color="#3a4048" metalness={0.55} roughness={0.5} />
        </mesh>
      )}

      {/* Conveyor — 575 x 101 x 52 mm. Movido Δ=-0.060155 en X (1.595→1.534845)
          para que su extremo este (centro+0.2875=1.822345) coincida con el
          slide_exit del feeder rotado. Frame en worktop: belt en 1.052. */}
      <mesh position={[1.534845 + cdx, 1.365 + cdy, 1.026 + convBase]} castShadow receiveShadow>
        <boxGeometry args={[0.575, 0.101, 0.052]} />
        <meshStandardMaterial color="#4a4a52" metalness={0.4} roughness={0.5} />
      </mesh>
      {/* Belt top surface (top en z=1.052) */}
      <mesh position={[1.534845 + cdx, 1.365 + cdy, 1.052 + convBase]} receiveShadow>
        <boxGeometry args={[0.555, 0.091, 0.003]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.85} />
      </mesh>
      {/* Riser bajo el conveyor (sólo si convBase>0; hoy 0 → no se dibuja). */}
      {convBase > 0 && (
        <mesh position={[1.534845 + cdx, 1.365 + cdy, 1.000 + convBase / 2]} castShadow receiveShadow>
          <boxGeometry args={[0.575, 0.101, convBase]} />
          <meshStandardMaterial color="#3a4048" metalness={0.55} roughness={0.5} />
        </mesh>
      )}

      {/* Dispensador real (slide_cafi_feeder), ROTADO 180° en Z. Borde derecho
          a ras del límite derecho de la mesa (X=2.062205): bbox half=0.119860 →
          base.x = 2.062205 - 0.119860 = 1.942345. Z: el punto más bajo del
          feeder está en z=0.000 (base_link), así que position.z = 1.000 deja la
          base APOYADA en el worktop (top=1.000), a ras con turntable/conveyor.
          (rotation.z=π no cambia Z; el flotado anterior era por estar en 1.070
          sobre el worktop de 1.000). slide_exit en base.x-0.120 = 1.822345. */}
      <CafiFeeder x={1.942345 + cdx} y={1.365 + cdy} z={1.000 + convBase} />

      {/* Bins (hollow boxes, no top) — aceptado and rechazado */}
      <HollowBin x={1.650 + adx} y={0.720 + ady} sx={0.226837} sy={0.172} h={0.150} color="#22dd55" baseZ={1.000 + binsBase} />
      <HollowBin x={1.330 + rdx} y={0.700 + rdy} sx={0.226837} sy={0.182} h={0.150} color="#ff5566" baseZ={1.000 + binsBase} />
      {/* Risers bajo los bins (sólo si binsBase>0; hoy 0 → no se dibujan). */}
      {binsBase > 0 && (
        <>
          <mesh position={[1.650 + adx, 0.720 + ady, 1.000 + binsBase / 2]} castShadow receiveShadow>
            <boxGeometry args={[0.226837, 0.172, binsBase]} />
            <meshStandardMaterial color="#3a4048" metalness={0.55} roughness={0.5} />
          </mesh>
          <mesh position={[1.330 + rdx, 0.700 + rdy, 1.000 + binsBase / 2]} castShadow receiveShadow>
            <boxGeometry args={[0.226837, 0.182, binsBase]} />
            <meshStandardMaterial color="#3a4048" metalness={0.55} roughness={0.5} />
          </mesh>
        </>
      )}

      {/* Vision fixture — real V53 STL (Fixture_para_camara_final). Sube visionBase. */}
      <VisionFixture x={0.750 + vdx} y={0.804 + vdy} z={1.000 + visionBase} />
      {/* Riser bajo el plato de visión (sólo si visionBase>0). */}
      {visionBase > 0 && (
        <mesh position={[0.750 + vdx, 0.804 + vdy, 1.000 + visionBase / 2]} castShadow receiveShadow>
          <boxGeometry args={[0.170, 0.130, visionBase]} />
          <meshStandardMaterial color="#3a4048" metalness={0.55} roughness={0.5} />
        </mesh>
      )}

      {/* Cell-level photoelectric sensors (V53 sick_grte18s_p2312) */}
      {/* sensor_conveyor_end: montado en el COSTADO NORTE del conveyor, a +14 cm
          de la esquina superior-izquierda (scene (1.3825, 1.4155)) a lo largo de
          la banda → faceX=1.5225. La cara óptica está en el borde norte de la
          banda (1.4155) y el haz cruza hacia el sur; base/poste al norte, fuera
          de la banda (no interfiere con el CAFI). */}
      <SickPhotoelectric faceX={1.387345 + cdx} faceY={1.4155 + cdy} faceZ={1.082 + convBase}
        beamYaw={-Math.PI / 2} mesaZ={1.000 + convBase} beamLen={0.130} />
      {/* sensor_vision_piece_present: west of cradle, beam yaw=0 (east) */}
      <SickPhotoelectric faceX={0.586 + vdx} faceY={0.804 + vdy} faceZ={1.040 + visionBase}
        beamYaw={0} mesaZ={1.000 + visionBase} beamLen={0.130} />

      {/* Conveyor drive motor: NEMA17 STL bajo el extremo este de la banda.
          Sigue al conveyor: X 1.775 → 1.714845 (Δ=-0.060155). Z=1.018. */}
      <Nema17Motor x={1.714845 + cdx} y={1.365 + cdy} z={1.018 + convBase} axisYaw={Math.PI / 2} />

      {/* Cámara Cognex. Z=1.905 CONGELADA (regla permanente del usuario, nunca
          cambia). En X,Y sigue a visionOffset para quedar CENTRADA sobre el
          fixture de visión (que ya se movió con el mismo offset). En Celda 3D
          visionOffset=[0,0] → vuelve a X=0.750,Y=0.804. La columna se autoajusta. */}
      <CognexCamera x={0.750 + vdx} y={0.804 + vdy} z={1.905} cabinTopZ={2.070} />

      {/* V57: rivet cabin REMOVED (was 2 posts + canopy + tray).  Replaced
          by a small stack-light tower next to the disc that signals rivet
          state via the same red/amber/green lamps.  Anchored at the V57
          riveting_zone = (0.992, 1.259, 1.000) with local offset
          (-0.220, 0, 0.150) per schneider_cell.urdf.xacro. */}
      <RivetingIndicator
        anchorX={TURNTABLE_BASE[0]}
        anchorY={TURNTABLE_BASE[1]}
        anchorZ={TURNTABLE_BASE[2] + turntableBase}
      />

      {/* Layout real (foto de la estación): la "Control Station" separada se
          eliminó.  Ahora, integrado al marco de aluminio:
            · HMI sujeto al perfil vertical IZQUIERDO, a media/alta altura, al frente.
            · Repisa de madera baja entre los perfiles inferiores con el PLC
              (gabinete gris, izquierda) y el controlador del cobot (centro).
            · La mesa principal queda libre (sin PC ni e-stop). */}
      <WoodLowerShelf offset={mesaOffset} />
      <ProfileMountedHMI offset={mesaOffset} />

      {/* Aluminum cabin — 4 posts, top + bottom perimeter, cobot ceiling
          cross-beams (matches aluminum_cabin.xacro V36). */}
      {/* Postes en las 4 esquinas EXACTAS de la mesa (1.620×0.920, centro
          MESA_CENTRE): (0.442205,0.589061)…(2.062205,1.509061). Centrados en
          el vértice (perfil 50 mm → 25 mm a cada lado). Altura Z=2.070 sin
          cambio: techo + travesaños del cobot se reconectan solos al frame. */}
      <AluminumCabin xMin={0.442205} xMax={2.062205} yMin={0.589061} yMax={1.509061}
        topZ={2.070} postSection={0.050}
        cobotMountX={0.950} cobotMountY={0.972} offset={mesaOffset} />
    </>
  );
}

// ── V53 STL-based scene parts ────────────────────────────────────────────────

// Vision fixture: real V53 STL plate.  The xacro applies Rx(+π/2) so the
// mesh's Y axis (15 mm thickness) becomes link Z, then centres the bbox via
// xyz (-0.079329, 0.058950, 0).  We replicate both in three.js (Z-up scene).
export function VisionFixture({ x, y, z }: { x: number; y: number; z: number }) {
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

// ── Dispensador de CAFIs (slide_cafi_feeder_description) ──────────────────────
// Reemplaza el placeholder "Suministro CAFI".  Los 6 STL vienen YA en metros y
// recentrados en el footprint del base_link (Z-up, igual que la escena), con
// origin (0,0,0) cada uno → se renderizan directos, sin escala ni rotación.
// El grupo se ancla en el base_link (apoyado sobre la mesa).  Frames del URDF:
//   slide_exit (0.120,0,0.070) · pick_ref (0.110,0,0.075) · sensor (0.075,0,0.080)
//   cafi_drop (-0.045,0,0.285).  Colores = materiales del URDF.
function CafiFeeder({ x, y, z }: { x: number; y: number; z: number }) {
  const [base, sideL, sideR, ramp, back, entrance] = useLoader(STLLoader, [
    '/models/feeder/base_bottom.stl',
    '/models/feeder/side_entrance_left.stl',
    '/models/feeder/side_entrance_right.stl',
    '/models/feeder/bottom_ramp.stl',
    '/models/feeder/back_entrance.stl',
    '/models/feeder/cafi_entrance.stl',
  ]);
  return (
    // rotation.z = π: gira el feeder 180° para que la rampa/slide_exit apunten
    // hacia el conveyor (oeste). La rotación es sobre Z (vertical), así que la
    // base NO se invierte ni cambia de Z — sigue apoyada en `z`.
    <group position={[x, y, z]} rotation={[0, 0, Math.PI]}>
      <mesh geometry={base} castShadow receiveShadow>
        <meshStandardMaterial color="#40454d" metalness={0.45} roughness={0.55} />
      </mesh>
      <mesh geometry={sideL} castShadow receiveShadow>
        <meshStandardMaterial color="#adb3b8" metalness={0.4} roughness={0.5} />
      </mesh>
      <mesh geometry={sideR} castShadow receiveShadow>
        <meshStandardMaterial color="#adb3b8" metalness={0.4} roughness={0.5} />
      </mesh>
      <mesh geometry={ramp} castShadow receiveShadow>
        <meshStandardMaterial color="#1a8c59" metalness={0.3} roughness={0.6} />
      </mesh>
      <mesh geometry={back} castShadow receiveShadow>
        <meshStandardMaterial color="#3373d9" metalness={0.3} roughness={0.6} />
      </mesh>
      <mesh geometry={entrance} castShadow receiveShadow>
        <meshStandardMaterial color="#f2731f" metalness={0.3} roughness={0.6} />
      </mesh>
    </group>
  );
}

export function MesaTable({ cx, cy, sx, sy, topZ, thickness, legSect, legInset }: {
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

function HollowBin({ x, y, sx, sy, h, color, baseZ = 1.000 }: { x: number; y: number; sx: number; sy: number; h: number; color: string; baseZ?: number }) {
  const wt = 0.005;
  const bottomZ = baseZ + wt / 2;
  const wallZ = baseZ + wt + (h - wt) / 2;
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

export function CognexCamera({ x, y, z, cabinTopZ }: { x: number; y: number; z: number; cabinTopZ: number }) {
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

// V57 rivet indicator — replaces the V53 cabin.  Just a vertical post next
// to the disc carrying 3 lamps (red/amber/green) that mirror the V53 cabin
// stack-light.  Per schneider_cell.urdf.xacro: post at riveting_zone +
// (-0.220, 0, 0.150) m, R=12 mm × length 300 mm; lamps R=25 mm at z-offset
// 0.180 (red), 0.130 (amber), 0.080 (green) from the post centre.
function RivetingIndicator({ anchorX, anchorY, anchorZ }: {
  anchorX: number; anchorY: number; anchorZ: number;
}) {
  const postX = anchorX - 0.220;
  const postY = anchorY;
  const postCenterZ = anchorZ + 0.150;
  return (
    <group>
      {/* Vertical post — Three.js cylinder is along local Y; Rx(+π/2) maps Y→Z */}
      <mesh position={[postX, postY, postCenterZ]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.012, 0.012, 0.300, 16]} />
        <meshStandardMaterial color="#5a606a" metalness={0.55} roughness={0.5} />
      </mesh>
      {/* Lamps — red top, amber middle, green bottom (offsets from post centre) */}
      <mesh position={[postX, postY, postCenterZ + 0.180]} castShadow>
        <sphereGeometry args={[0.025, 20, 20]} />
        <meshStandardMaterial color="#ff3030" emissive="#ff3030" emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[postX, postY, postCenterZ + 0.130]} castShadow>
        <sphereGeometry args={[0.025, 20, 20]} />
        <meshStandardMaterial color="#ffaa20" emissive="#ffaa20" emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[postX, postY, postCenterZ + 0.080]} castShadow>
        <sphereGeometry args={[0.025, 20, 20]} />
        <meshStandardMaterial color="#22dd55" emissive="#22dd55" emissiveIntensity={0.4} />
      </mesh>
    </group>
  );
}

// ── Layout real (foto de la estación) ───────────────────────────────────────
// La vieja Control Station (banco con escritorio/monitor/PLC/HMI) se retiró.  En
// su lugar, 2 módulos integrados al marco de aluminio, fieles a la foto:
//   · WoodLowerShelf    — repisa de madera baja + PLC (gabinete gris, izq.) y
//                         controlador del cobot (centro).
//   · ProfileMountedHMI — HMI en el perfil vertical izquierdo, media/alta altura,
//                         mirando al frente (-Y).
// La mesa principal queda libre (sin PC ni e-stop).  Coordenadas de mundo (marco:
// xMin 0.442205, xMax 2.062205, yMin 0.589061 = frente, yMax 1.509061 = fondo,
// perfil 50 mm; mesa top z=1.000).

// Repisa de madera entre los perfiles inferiores, con el PLC (gabinete gris a la
// izquierda) y el controlador del cobot (caja oscura, en la zona central).
// offset X,Y opcional (default [0,0]): Cobot en Vivo iguala la repisa inferior y
// sus gabinetes (PLC izq · controlador centro · gabinete aux der) al mesaOffset
// para que queden integrados bajo la mesa movida. El HMI NO está aquí (va sujeto
// al marco, que no se mueve). Z nunca cambia. Celda 3D → [0,0] (sin cambio).
function WoodLowerShelf({ offset = [0, 0] }: { offset?: [number, number] } = {}) {
  const [ox, oy] = offset;
  const boardT = 0.028;
  const boardZ = 0.430;                       // ≈1/3 de altura, como en la foto
  const boardTop = boardZ + boardT / 2;
  const cx = 1.205, cy = 0.980;               // centro de la tabla
  const bw = 1.46, bd = 0.80;                 // tabla limpia y rectangular
  const wood = <meshStandardMaterial color="#b98a4e" roughness={0.86} metalness={0.04} />;
  const alu  = <meshStandardMaterial color="#c8c8cc" metalness={0.65} roughness={0.4} />;
  const ctl  = <meshStandardMaterial color="#2c2f36" metalness={0.5} roughness={0.5} />;
  const plcCab  = <meshStandardMaterial color="#9aa0aa" metalness={0.45} roughness={0.5} />;  // gabinete gris
  const plcDoor = <meshStandardMaterial color="#7e8590" metalness={0.5} roughness={0.45} />;
  const beige = <meshStandardMaterial color="#c9bda0" metalness={0.2} roughness={0.7} />;
  return (
    <group position={[ox, oy, 0]}>
      {/* 2 rieles de soporte (perfil alu) bajo la tabla → se ve apoyada */}
      <mesh position={[cx, cy - bd / 2 + 0.06, boardZ - boardT / 2 - 0.022]} castShadow>
        <boxGeometry args={[bw, 0.045, 0.045]} />{alu}</mesh>
      <mesh position={[cx, cy + bd / 2 - 0.06, boardZ - boardT / 2 - 0.022]} castShadow>
        <boxGeometry args={[bw, 0.045, 0.045]} />{alu}</mesh>
      {/* Tabla de madera (contrachapado) */}
      <mesh position={[cx, cy, boardZ]} castShadow receiveShadow>
        <boxGeometry args={[bw, bd, boardT]} />{wood}</mesh>

      {/* PLC: gabinete gris claro (Schneider) del lado IZQUIERDO (ya SIN rojo) */}
      <mesh position={[0.80, 0.965, boardTop + 0.13]} castShadow>
        <boxGeometry args={[0.19, 0.20, 0.26]} />{plcCab}</mesh>
      <mesh position={[0.80, 0.965 - 0.20 / 2 - 0.001, boardTop + 0.13]}>
        <boxGeometry args={[0.16, 0.002, 0.21]} />{plcDoor}</mesh>

      {/* Controlador del cobot: caja oscura grande, en la ZONA CENTRAL */}
      <mesh position={[1.205, 0.985, boardTop + 0.15]} castShadow>
        <boxGeometry args={[0.42, 0.255, 0.30]} />{ctl}</mesh>
      <mesh position={[1.205, 0.985 - 0.255 / 2 - 0.001, boardTop + 0.15]}>
        <boxGeometry args={[0.30, 0.002, 0.20]} />
        <meshStandardMaterial color="#16181c" metalness={0.6} roughness={0.4} /></mesh>

      {/* Bloque claro (PSU/fuente) a la derecha — reequilibrado y alineado */}
      <mesh position={[1.62, 0.985, boardTop + 0.09]} castShadow>
        <boxGeometry args={[0.24, 0.22, 0.18]} />{beige}</mesh>
    </group>
  );
}

// HMI sujeto al perfil vertical IZQUIERDO (frontal), montado a MEDIA/ALTA altura
// y mirando al frente (-Y), visible desde el frente — como en la foto real.
function ProfileMountedHMI({ offset = [0, 0] }: { offset?: [number, number] } = {}) {
  const postX = 0.442205;
  const frontFaceY = 0.589061 - 0.025;        // cara -Y del poste frontal-izq.
  const z = 1.420;                            // media/alta altura (mesa=1.0, techo=2.07)
  const arm = 0.085;
  const sw = 0.275, sh = 0.190, sd = 0.024;
  const screenY = frontFaceY - arm - sd / 2;
  const clamp  = <meshStandardMaterial color="#3a3f48" metalness={0.6} roughness={0.45} />;
  const bezel  = <meshStandardMaterial color="#16161a" metalness={0.6} roughness={0.4} />;
  const screen = <meshStandardMaterial color="#0f3a78" emissive="#1f5eb8" emissiveIntensity={0.55} roughness={0.3} />;
  return (
    // Sigue al marco (offset) para quedar atornillado a su poste, sin flotar.
    <group position={[offset[0], offset[1], 0]}>
      {/* Abrazadera al perfil + brazo (se ve sujeto, no flotando) */}
      <mesh position={[postX, frontFaceY + 0.001, z]} castShadow>
        <boxGeometry args={[0.07, 0.06, 0.11]} />{clamp}</mesh>
      <mesh position={[postX, frontFaceY - arm / 2, z]} castShadow>
        <boxGeometry args={[0.028, arm, 0.028]} />{clamp}</mesh>
      {/* Pantalla HMI mirando -Y (al operador) */}
      <mesh position={[postX, screenY, z]} castShadow>
        <boxGeometry args={[sw, sd, sh]} />{bezel}</mesh>
      <mesh position={[postX, screenY - sd / 2 - 0.001, z]}>
        <boxGeometry args={[sw * 0.9, 0.003, sh * 0.82]} />{screen}</mesh>
    </group>
  );
}


// Aluminum cabin frame — V36 aluminum_cabin.xacro (50x50 mm profile):
//   - 4 vertical posts floor → top profile underside
//   - Top perimeter frame (4 bars on N/S/W/E) sitting ON the posts
//   - Bottom perimeter (2 bars on N/S, low)
//   - 3 cobot ceiling cross-beams (2 X-bars at cobot_y ± 0.150, 1 Y-bar at cobot_x)
//   - Cobot mount flange (cylinder + accent disc) at the cobot mount XY
export function AluminumCabin({ xMin, xMax, yMin, yMax, topZ, postSection, cobotMountX, cobotMountY, offset = [0, 0] }: {
  xMin: number; xMax: number; yMin: number; yMax: number;
  topZ: number; postSection: number;
  cobotMountX: number; cobotMountY: number;
  // offset X,Y opcional (default [0,0]): Cobot en Vivo iguala el marco al mesaOffset
  // para que los postes queden centrados en las esquinas de la mesa movida. Como
  // xMin/xMax/yMin/yMax YA coinciden con las esquinas de la mesa base, basta con
  // trasladar todo el marco por el mismo offset. Celda 3D → [0,0] (sin cambio).
  offset?: [number, number];
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
    <group position={[offset[0], offset[1], 0]}>
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
      {/* Bottom perimeter — rectángulo CERRADO al ras del piso: barras S y N a lo
          largo de X + barras W y E a lo largo de Y (antes faltaban W/E → el marco
          inferior se veía abierto). Se encuentran en las esquinas igual que el
          marco superior, cubriendo todo el ancho (xLen) y la profundidad (yLen). */}
      <mesh position={[xMid, yMin, postSection / 2]} castShadow>
        <boxGeometry args={[xLen, postSection, postSection]} />{aluMat}
      </mesh>
      <mesh position={[xMid, yMax, postSection / 2]} castShadow>
        <boxGeometry args={[xLen, postSection, postSection]} />{aluMat}
      </mesh>
      <mesh position={[xMin, yMid, postSection / 2]} castShadow>
        <boxGeometry args={[postSection, yLen, postSection]} />{aluMat}
      </mesh>
      <mesh position={[xMax, yMid, postSection / 2]} castShadow>
        <boxGeometry args={[postSection, yLen, postSection]} />{aluMat}
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

export function collisionAABBs(): Array<{ name: string; box: THREE.Box3 }> {
  return COLLISION_BOXES.map((b) => ({
    name: b.name,
    box: new THREE.Box3(
      new THREE.Vector3(b.x - b.sx / 2, b.y - b.sy / 2, b.z - b.sz / 2),
      new THREE.Vector3(b.x + b.sx / 2, b.y + b.sy / 2, b.z + b.sz / 2),
    ),
  }));
}

// Sube TODAS las cajas de obstáculo en Z (clon, no muta). dz=0 → sin cambio.
// (Hoy el cobot no sube, así que se llama con dz=0 y devuelve el set original.)
function liftObstacles(
  obs: Array<{ name: string; box: THREE.Box3 }>, dz: number,
): Array<{ name: string; box: THREE.Box3 }> {
  if (!dz) return obs;
  const t = new THREE.Vector3(0, 0, dz);
  return obs.map((o) => ({ name: o.name, box: o.box.clone().translate(t) }));
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

// ── Inverse kinematics (position-only DLS + collision-aware sampling) ────────
// 3D-target IK: given a desired TCP world XYZ, find joint values that put the
// cobot's tcp_link at that position while avoiding the COLLISION_BOXES.  Uses
// numerical Jacobian (finite differences) + damped least squares update with
// step clamping.  For collision avoidance, restarts from random perturbations
// of the initial guess until a clean solution is found or attempts run out.

interface IKResult {
  joints: [number, number, number, number, number, number];
  positionError: number;
  collisions: string[];
  iterations: number;
  converged: boolean;
  attempts: number;
}

const IK_EPSILON = 1e-4;
const IK_LAMBDA = 0.05;
const IK_STEP_CLAMP = 0.3;
const IK_MAX_ITER = 200;
const IK_TOLERANCE = 0.001;        // 1 mm — strict convergence
const IK_ACCEPT_TOL = 0.005;       // 5 mm — acceptable if clean
const IK_MAX_ATTEMPTS = 48;
const IK_PERTURB_MAX = 1.8;        // rad — large enough to escape local collisions

function applyJoints6(robot: URDFRobot, joints: number[]): void {
  for (let i = 0; i < 6; i++) robot.setJointValue(`joint_${i + 1}`, joints[i]);
}

function tcpWorld(
  robot: URDFRobot, rootGroup: THREE.Object3D, out: THREE.Vector3,
): void {
  rootGroup.updateMatrixWorld(true);
  const tcp = robot.frames['tcp_link'];
  if (tcp) tcp.getWorldPosition(out);
  else out.set(0, 0, 0);
}

// Full TCP pose: position + world quaternion.
function tcpPose(
  robot: URDFRobot, rootGroup: THREE.Object3D,
  outPos: THREE.Vector3, outQuat: THREE.Quaternion,
): void {
  rootGroup.updateMatrixWorld(true);
  const tcp = robot.frames['tcp_link'];
  if (!tcp) { outPos.set(0, 0, 0); outQuat.identity(); return; }
  tcp.getWorldPosition(outPos);
  tcp.getWorldQuaternion(outQuat);
}

// ── TCP relativo a la BASE del cobot (base_link), NO al world/escena ─────────
// El controlador real reporta el TCP en su propio frame de base (base_link), no
// en coordenadas de escena.  base_link está rotado 90° en X respecto al root del
// URDF (joint world→base_link rpy="π/2 0 0"), así que NO basta restar COBOT_BASE:
// hay que aplicar el transform completo.
//   TCP_in_cobot_base = inverse(T_world_base_link) · T_world_tcp
// Sale 100% de la FK real del robot (no de offsets de layout). Devuelve posición
// en mm y orientación (Euler XYZ) en grados.  Asume que el robot ya tiene los
// joints aplicados y matrixWorld fresco (Cobot lo refresca cada frame).
export interface TcpInBase { xMm: number; yMm: number; zMm: number; rxDeg: number; ryDeg: number; rzDeg: number; }
const _tcpRelMat = new THREE.Matrix4();
const _tcpBaseInv = new THREE.Matrix4();
const _tcpRelPos = new THREE.Vector3();
const _tcpRelQuat = new THREE.Quaternion();
const _tcpRelScale = new THREE.Vector3();
const _tcpRelEuler = new THREE.Euler(0, 0, 0, 'XYZ');
const TCP_R2DEG = 180 / Math.PI;
export function getTcpRelativeToCobotBase(robot: URDFRobot): TcpInBase | null {
  const base = robot.links['base_link'];
  const tcp = robot.frames['tcp_link'];
  if (!base || !tcp) return null;
  _tcpBaseInv.copy(base.matrixWorld).invert();
  _tcpRelMat.multiplyMatrices(_tcpBaseInv, tcp.matrixWorld);
  _tcpRelMat.decompose(_tcpRelPos, _tcpRelQuat, _tcpRelScale);
  _tcpRelEuler.setFromQuaternion(_tcpRelQuat, 'XYZ');
  return {
    xMm: _tcpRelPos.x * 1000, yMm: _tcpRelPos.y * 1000, zMm: _tcpRelPos.z * 1000,
    rxDeg: _tcpRelEuler.x * TCP_R2DEG, ryDeg: _tcpRelEuler.y * TCP_R2DEG, rzDeg: _tcpRelEuler.z * TCP_R2DEG,
  };
}

// Axis-angle 3-vector from a (small) rotation quaternion.  Returns the
// shortest rotation (picks the sign that keeps angle in [-π, π]).
function quatToAxisAngleVec(q: THREE.Quaternion, out: THREE.Vector3): void {
  let qw = q.w, qx = q.x, qy = q.y, qz = q.z;
  if (qw < 0) { qw = -qw; qx = -qx; qy = -qy; qz = -qz; } // shortest path
  const xyzLen = Math.sqrt(qx * qx + qy * qy + qz * qz);
  if (xyzLen < 1e-12) { out.set(0, 0, 0); return; }
  const angle = 2 * Math.atan2(xyzLen, qw);
  const k = angle / xyzLen;
  out.set(qx * k, qy * k, qz * k);
}

function ikJacobian(
  robot: URDFRobot, rootGroup: THREE.Object3D, joints: number[],
): number[][] {
  const J = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];
  const pos = new THREE.Vector3();
  const neg = new THREE.Vector3();
  for (let i = 0; i < 6; i++) {
    const orig = joints[i];
    joints[i] = orig + IK_EPSILON;
    applyJoints6(robot, joints);
    tcpWorld(robot, rootGroup, pos);
    joints[i] = orig - IK_EPSILON;
    applyJoints6(robot, joints);
    tcpWorld(robot, rootGroup, neg);
    J[0][i] = (pos.x - neg.x) / (2 * IK_EPSILON);
    J[1][i] = (pos.y - neg.y) / (2 * IK_EPSILON);
    J[2][i] = (pos.z - neg.z) / (2 * IK_EPSILON);
    joints[i] = orig;
  }
  applyJoints6(robot, joints);
  return J;
}

function invert3x3(m: number[][]): number[][] | null {
  const a = m[0][0], b = m[0][1], c = m[0][2];
  const d = m[1][0], e = m[1][1], f = m[1][2];
  const g = m[2][0], h = m[2][1], i = m[2][2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [
    [(e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k],
    [(f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k],
    [(d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k],
  ];
}

function dlsUpdate(J: number[][], err: [number, number, number]): number[] {
  const JJT = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += J[i][k] * J[j][k];
      JJT[i][j] = s + (i === j ? IK_LAMBDA * IK_LAMBDA : 0);
    }
  }
  const inv = invert3x3(JJT);
  if (!inv) return [0, 0, 0, 0, 0, 0];
  const tmp = [
    inv[0][0] * err[0] + inv[0][1] * err[1] + inv[0][2] * err[2],
    inv[1][0] * err[0] + inv[1][1] * err[1] + inv[1][2] * err[2],
    inv[2][0] * err[0] + inv[2][1] * err[1] + inv[2][2] * err[2],
  ];
  const delta = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 6; i++) {
    delta[i] = J[0][i] * tmp[0] + J[1][i] * tmp[1] + J[2][i] * tmp[2];
  }
  return delta;
}

function solveIKOnce(
  robot: URDFRobot, rootGroup: THREE.Object3D,
  targetWorld: [number, number, number],
  initialJoints: number[],
  obstacles: ReturnType<typeof collisionAABBs>,
): { joints: number[]; positionError: number; collisions: string[]; iterations: number; converged: boolean } {
  const joints = [...initialJoints];
  const tcp = new THREE.Vector3();
  let posErr = Infinity;
  let iter = 0;
  for (iter = 0; iter < IK_MAX_ITER; iter++) {
    applyJoints6(robot, joints);
    tcpWorld(robot, rootGroup, tcp);
    const err: [number, number, number] = [
      targetWorld[0] - tcp.x,
      targetWorld[1] - tcp.y,
      targetWorld[2] - tcp.z,
    ];
    posErr = Math.sqrt(err[0] * err[0] + err[1] * err[1] + err[2] * err[2]);
    if (posErr < IK_TOLERANCE) break;
    const J = ikJacobian(robot, rootGroup, joints);
    const delta = dlsUpdate(J, err);
    let stepNorm = 0;
    for (let i = 0; i < 6; i++) stepNorm += delta[i] * delta[i];
    stepNorm = Math.sqrt(stepNorm);
    if (stepNorm > IK_STEP_CLAMP) {
      const s = IK_STEP_CLAMP / stepNorm;
      for (let i = 0; i < 6; i++) delta[i] *= s;
    }
    for (let i = 0; i < 6; i++) {
      const [lo, hi] = JOINT_LIMITS[i];
      joints[i] = Math.max(lo, Math.min(hi, joints[i] + delta[i]));
    }
  }
  applyJoints6(robot, joints);
  rootGroup.updateMatrixWorld(true);
  const collisions = checkCobotCollisions(robot, obstacles);
  return { joints, positionError: posErr, collisions, iterations: iter, converged: posErr < IK_TOLERANCE };
}

// Strict ordering for IK candidates:
//   1. fewer collisions wins
//   2. break ties by lower position error
// Convergence flag alone is intentionally NOT a tiebreaker — a "converged"
// solution that still collides is worse than a slightly off-target one
// that's clean.
function isBetterIK(a: { collisions: string[]; positionError: number }, b: { collisions: string[]; positionError: number } | null): boolean {
  if (!b) return true;
  if (a.collisions.length !== b.collisions.length) return a.collisions.length < b.collisions.length;
  return a.positionError < b.positionError;
}

// 6×6 Jacobian — finite differences of TCP pose (3 pos + 3 axis-angle rot)
// w.r.t. each joint angle.
function ik6Jacobian(
  robot: URDFRobot, rootGroup: THREE.Object3D, joints: number[],
): number[][] {
  const J: number[][] = [
    [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0],
  ];
  const posP = new THREE.Vector3();
  const posN = new THREE.Vector3();
  const quatP = new THREE.Quaternion();
  const quatN = new THREE.Quaternion();
  const qDelta = new THREE.Quaternion();
  const axisAng = new THREE.Vector3();
  for (let i = 0; i < 6; i++) {
    const orig = joints[i];
    joints[i] = orig + IK_EPSILON;
    applyJoints6(robot, joints);
    tcpPose(robot, rootGroup, posP, quatP);
    joints[i] = orig - IK_EPSILON;
    applyJoints6(robot, joints);
    tcpPose(robot, rootGroup, posN, quatN);
    joints[i] = orig;
    const inv2eps = 1 / (2 * IK_EPSILON);
    J[0][i] = (posP.x - posN.x) * inv2eps;
    J[1][i] = (posP.y - posN.y) * inv2eps;
    J[2][i] = (posP.z - posN.z) * inv2eps;
    // qDelta = quatP * quatN^-1
    qDelta.copy(quatN).invert().premultiply(quatP);
    quatToAxisAngleVec(qDelta, axisAng);
    J[3][i] = axisAng.x * inv2eps;
    J[4][i] = axisAng.y * inv2eps;
    J[5][i] = axisAng.z * inv2eps;
  }
  applyJoints6(robot, joints);
  return J;
}

// Gauss-Jordan inverse of an NxN matrix.  Returns null if singular.
function invertNxN(m: number[][], n: number): number[][] | null {
  const a: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(2 * n);
    for (let j = 0; j < n; j++) row[j] = m[i][j];
    for (let j = 0; j < n; j++) row[n + j] = (i === j) ? 1 : 0;
    a.push(row);
  }
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let maxAbs = Math.abs(a[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r][col]);
      if (v > maxAbs) { maxAbs = v; pivot = r; }
    }
    if (maxAbs < 1e-12) return null;
    if (pivot !== col) { const t = a[col]; a[col] = a[pivot]; a[pivot] = t; }
    const inv = 1 / a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] *= inv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  const out: number[][] = [];
  for (let i = 0; i < n; i++) out.push(a[i].slice(n));
  return out;
}

// 6D DLS update: Δθ = J^T (J J^T + λ²I)^-1 err, with err and Δθ length 6.
function dls6Update(J: number[][], err: number[]): number[] {
  const JJT: number[][] = [
    [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0],
  ];
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += J[i][k] * J[j][k];
      JJT[i][j] = s + (i === j ? IK_LAMBDA * IK_LAMBDA : 0);
    }
  }
  const inv = invertNxN(JJT, 6);
  if (!inv) return [0, 0, 0, 0, 0, 0];
  const tmp = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 6; i++) {
    let s = 0;
    for (let j = 0; j < 6; j++) s += inv[i][j] * err[j];
    tmp[i] = s;
  }
  const delta = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 6; i++) {
    let s = 0;
    for (let j = 0; j < 6; j++) s += J[j][i] * tmp[j];
    delta[i] = s;
  }
  return delta;
}

// 6D pose IK: pin BOTH position and orientation.  Pos error in m, rot error
// in rad (axis-angle magnitude).  6-DOF arm with a 6D target generally has a
// discrete solution set (multiple branches), so collision avoidance via
// random restart hops between branches rather than exploring a null space.
const IK_ROT_TOLERANCE = 0.005;     // ~0.3°
const IK_ROT_ACCEPT_TOL = 0.02;     // ~1.1°

interface IK6Result {
  joints: [number, number, number, number, number, number];
  positionError: number;
  rotationError: number;
  collisions: string[];
  iterations: number;
  converged: boolean;
  attempts: number;
}

function solveIK6DOnce(
  robot: URDFRobot, rootGroup: THREE.Object3D,
  targetPos: [number, number, number],
  targetQuat: THREE.Quaternion,
  initialJoints: number[],
  obstacles: ReturnType<typeof collisionAABBs>,
): { joints: number[]; positionError: number; rotationError: number; collisions: string[]; iterations: number; converged: boolean } {
  const joints = [...initialJoints];
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const qDelta = new THREE.Quaternion();
  const axisAng = new THREE.Vector3();
  let posErr = Infinity;
  let rotErr = Infinity;
  let iter = 0;
  for (iter = 0; iter < IK_MAX_ITER; iter++) {
    applyJoints6(robot, joints);
    tcpPose(robot, rootGroup, pos, quat);
    const ex = targetPos[0] - pos.x;
    const ey = targetPos[1] - pos.y;
    const ez = targetPos[2] - pos.z;
    posErr = Math.sqrt(ex * ex + ey * ey + ez * ez);
    // qDelta = targetQuat * quat^-1 (rotates current to target)
    qDelta.copy(quat).invert().premultiply(targetQuat);
    quatToAxisAngleVec(qDelta, axisAng);
    rotErr = axisAng.length();
    if (posErr < IK_TOLERANCE && rotErr < IK_ROT_TOLERANCE) break;
    const err = [ex, ey, ez, axisAng.x, axisAng.y, axisAng.z];
    const J = ik6Jacobian(robot, rootGroup, joints);
    const delta = dls6Update(J, err);
    let n = 0;
    for (let i = 0; i < 6; i++) n += delta[i] * delta[i];
    n = Math.sqrt(n);
    if (n > IK_STEP_CLAMP) {
      const s = IK_STEP_CLAMP / n;
      for (let i = 0; i < 6; i++) delta[i] *= s;
    }
    for (let i = 0; i < 6; i++) {
      const [lo, hi] = JOINT_LIMITS[i];
      joints[i] = Math.max(lo, Math.min(hi, joints[i] + delta[i]));
    }
  }
  applyJoints6(robot, joints);
  rootGroup.updateMatrixWorld(true);
  const collisions = checkCobotCollisions(robot, obstacles);
  return {
    joints, positionError: posErr, rotationError: rotErr,
    collisions, iterations: iter,
    converged: posErr < IK_TOLERANCE && rotErr < IK_ROT_TOLERANCE,
  };
}

// Better criterion for 6D candidates: clean wins, then lower combined error.
function isBetterIK6(
  a: { collisions: string[]; positionError: number; rotationError: number },
  b: { collisions: string[]; positionError: number; rotationError: number } | null,
): boolean {
  if (!b) return true;
  if (a.collisions.length !== b.collisions.length) return a.collisions.length < b.collisions.length;
  // Combined error: pos in m + rot in rad * 0.1 (so 1 cm ≈ 0.1 rad of weight)
  const ea = a.positionError + a.rotationError * 0.1;
  const eb = b.positionError + b.rotationError * 0.1;
  return ea < eb;
}

function solveIK6D(
  robot: URDFRobot, rootGroup: THREE.Object3D,
  targetPos: [number, number, number],
  targetQuat: THREE.Quaternion,
  initialJoints: number[],
  obstacles: ReturnType<typeof collisionAABBs>,
): IK6Result {
  let best: (ReturnType<typeof solveIK6DOnce> & { attempts: number }) | null = null;
  for (let attempt = 1; attempt <= IK_MAX_ATTEMPTS; attempt++) {
    let start: number[];
    if (attempt === 1) {
      start = [...initialJoints];
    } else {
      const perturb = IK_PERTURB_MAX * (attempt / IK_MAX_ATTEMPTS);
      start = initialJoints.map((j, i) => {
        const [lo, hi] = JOINT_LIMITS[i];
        return Math.max(lo, Math.min(hi, j + (Math.random() - 0.5) * 2 * perturb));
      });
    }
    const r = solveIK6DOnce(robot, rootGroup, targetPos, targetQuat, start, obstacles);
    if (r.converged && r.collisions.length === 0) {
      return { ...r, joints: r.joints as IK6Result['joints'], attempts: attempt };
    }
    if (r.positionError < IK_ACCEPT_TOL && r.rotationError < IK_ROT_ACCEPT_TOL && r.collisions.length === 0) {
      return { ...r, joints: r.joints as IK6Result['joints'], attempts: attempt };
    }
    if (isBetterIK6(r, best)) {
      best = { ...r, attempts: attempt };
    }
  }
  return { ...best!, joints: best!.joints as IK6Result['joints'] };
}

function solveIK(
  robot: URDFRobot, rootGroup: THREE.Object3D,
  targetWorld: [number, number, number],
  initialJoints: number[],
  obstacles: ReturnType<typeof collisionAABBs>,
): IKResult {
  let best: (ReturnType<typeof solveIKOnce> & { attempts: number }) | null = null;
  for (let attempt = 1; attempt <= IK_MAX_ATTEMPTS; attempt++) {
    let start: number[];
    if (attempt === 1) {
      start = [...initialJoints];
    } else {
      // Grow the perturbation from small (attempt 2) to very large (final
      // attempts) so we both refine and aggressively explore.
      const perturb = IK_PERTURB_MAX * (attempt / IK_MAX_ATTEMPTS);
      start = initialJoints.map((j, i) => {
        const [lo, hi] = JOINT_LIMITS[i];
        return Math.max(lo, Math.min(hi, j + (Math.random() - 0.5) * 2 * perturb));
      });
    }
    const r = solveIKOnce(robot, rootGroup, targetWorld, start, obstacles);
    // Early-out on a clean solution that's also within strict tolerance.
    if (r.converged && r.collisions.length === 0) {
      return { ...r, joints: r.joints as IKResult['joints'], attempts: attempt };
    }
    // Also early-out if we're within "acceptable" tolerance AND clean — a few
    // mm of TCP error is fine if it means dodging an obstacle.
    if (r.positionError < IK_ACCEPT_TOL && r.collisions.length === 0) {
      return { ...r, joints: r.joints as IKResult['joints'], attempts: attempt };
    }
    if (isBetterIK(r, best)) {
      best = { ...r, attempts: attempt };
    }
  }
  return { ...best!, joints: best!.joints as IKResult['joints'] };
}

// ── V60 analytical FK ────────────────────────────────────────────────────────
// Computes the world pose of tcp_link for the V60 URDF chain.  Used at boot
// to capture the TCP world targets that the regenerated V26 POSE_LIB must
// reach.  Built in the same order as the V60 URDF joint chain, with
// COBOT_BASE prepended.  Static rpy=(0,0,0.05) of joint_2 is folded into
// the variable rotation (both around Z).
const _v60Tmp = new THREE.Matrix4();
function v60TcpWorldPose(j: number[]): { pos: THREE.Vector3; quat: THREE.Quaternion } {
  const m = new THREE.Matrix4();
  m.makeTranslation(COBOT_BASE[0], COBOT_BASE[1], COBOT_BASE[2]);
  m.multiply(_v60Tmp.makeRotationX(Math.PI / 2));
  // joint_1 (Y)
  m.multiply(_v60Tmp.makeTranslation(0.1623, 0.0867, 0.0645));
  m.multiply(_v60Tmp.makeRotationY(j[0]));
  // joint_2 (Z) + static rpy=(0,0,0.05) → both around Z, sum the angles
  m.multiply(_v60Tmp.makeTranslation(-0.0115, 0.0639, 0));
  m.multiply(_v60Tmp.makeRotationZ(0.05 + j[1]));
  // joint_3 (Z) — V60 parent chain: link2 → joint_3 (no elbow connector link)
  m.multiply(_v60Tmp.makeTranslation(-0.0015, 0.2450, 0.2258));
  m.multiply(_v60Tmp.makeRotationZ(j[2]));
  // joint_4 (Z)
  m.multiply(_v60Tmp.makeTranslation(-0.0060, 0.2295, 0.1244));
  m.multiply(_v60Tmp.makeRotationZ(j[3]));
  // joint_5 (Y)
  m.multiply(_v60Tmp.makeTranslation(-0.0010, 0.0465, -0.2300));
  m.multiply(_v60Tmp.makeRotationY(j[4]));
  // joint_6 (Z)
  m.multiply(_v60Tmp.makeTranslation(-0.0040, 0.0720, 0.0898));
  m.multiply(_v60Tmp.makeRotationZ(j[5]));
  // tool0
  m.multiply(_v60Tmp.makeTranslation(0, 0.068, 0));
  // tool0 → gripper_base
  m.multiply(_v60Tmp.makeTranslation(0, -0.07, 0.015));
  // appendage prismatic at 0 → identity
  // tcp_fixed_joint
  m.multiply(_v60Tmp.makeTranslation(0.000250, 0.060250, 0.076750));
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  m.decompose(pos, quat, scale);
  return { pos, quat };
}

// Re-IK every V60 pose against the loaded V26 URDF and return the new
// joint values.  Each pose is seeded with the V60 joints (close enough
// even though j3+ axes differ) so the solver usually converges in a few
// iterations.  Logs any pose that fails to converge cleanly.
function regeneratePoseLibForV26(
  v26Robot: URDFRobot, v26Group: THREE.Object3D,
  obstacles: ReturnType<typeof collisionAABBs>,
): { lib: Record<string, [number, number, number, number, number, number]>; warnings: string[] } {
  const lib: Record<string, [number, number, number, number, number, number]> = {};
  const warnings: string[] = [];
  for (const [name, jointsV60] of Object.entries(POSE_LIB_V60)) {
    const { pos, quat } = v60TcpWorldPose(jointsV60);
    const r = solveIK6D(
      v26Robot, v26Group,
      [pos.x, pos.y, pos.z], quat,
      [...jointsV60], obstacles,
    );
    lib[name] = r.joints;
    if (r.positionError > 0.005 || r.rotationError > 0.05) {
      warnings.push(`${name}: posErr=${(r.positionError * 1000).toFixed(1)}mm rotErr=${(r.rotationError * 180 / Math.PI).toFixed(1)}° collisions=${r.collisions.length}`);
    }
  }
  return { lib, warnings };
}

// ── Collision-zone overlay (toggle from HMI) ─────────────────────────────────
// Renders every COLLISION_BOX as a translucent coloured mesh + thin edge lines
// so the operator can visually identify the no-go zones the cobot must avoid.
function CollisionBoxes({ visible, zLift = 0 }: { visible: boolean; zLift?: number }) {
  if (!visible) return null;
  return (
    <group position={[0, 0, zLift]}>
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
export function Label({ x, y, z, text, color = '#9fb' }: { x: number; y: number; z: number; text: string; color?: string }) {
  return (
    // zIndexRange BAJO (drei por defecto usa ~16.7M y tapaba el Teach Pendant).
    // Con [15,0] los labels viven en z 0..15, por DEBAJO del panel (z 1000):
    // siguen visibles en la escena pero nunca se dibujan encima del pendant.
    <Html position={[x, y, z]} center zIndexRange={[15, 0]}>
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

// ── Teach Pendant (panel DEBUG) — estilo Universal Robots ────────────────────
// Reemplaza los controles de jog / SET JOINTS / MOVE LINEAR. TODO lo que se le
// MUESTRA al usuario está en GRADOS y mm; toda la lógica interna sigue en
// radianes y metros. Se refresca cada 100 ms leyendo los refs vivos del cobot.
// Reusa la plumbing de movimiento existente sin cambiarla: startJointMove (anima
// con el gating ±0.005 rad de ManualMover) y startLinearMove (buildLinearWaypoints).
// NO toca la FSM ni la cámara.
const TP_RAD2DEG = 180 / Math.PI;
const TP_DEG2RAD = Math.PI / 180;
// HOME del teach pendant, en GRADOS como pide el spec (se guarda en radianes).
const TEACH_HOME_DEG: [number, number, number, number, number, number] =
  [90.0, 0.0, 0.0, 90.0, -90.0, -89.9];

export interface TeachPose { name: string; joints: [number, number, number, number, number, number]; } // RAD

// Almacenamiento EN MEMORIA (no localStorage — no funciona en este entorno).
// Las poses viven en el useState del componente: se pierden al recargar, pero
// funcionan sin errores. HOME va precargado.
function initialTeachPoses(): TeachPose[] {
  return [{ name: 'HOME', joints: TEACH_HOME_DEG.map((d) => d * TP_DEG2RAD) as TeachPose['joints'] }];
}

const JOINT_AXES = ['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz'] as const;

export function TeachPendant({
  jointsRef, gripperWorldRef, tcpEulerRef, manualMovingRef,
  startJointMove, stopMove, jogCmdRef, jogVelocityRef, onClose,
  initialPoses, extraActions, onResetRx, realMode = false, commandPending = false,
  onJogStart, previewOnly = false, tcpBaseRef,
}: {
  jointsRef: React.MutableRefObject<[number, number, number, number, number, number]>;
  gripperWorldRef: React.MutableRefObject<[number, number, number]>;
  tcpEulerRef: React.MutableRefObject<[number, number, number]>;
  // TCP relativo a la base del cobot (mm + grados). Si se pasa, el panel muestra
  // estos valores (útiles para la vida real) en vez de los de world.
  tcpBaseRef?: React.MutableRefObject<TcpInBase | null>;
  manualMovingRef: React.MutableRefObject<boolean>;
  startJointMove: (target: number[]) => void;
  stopMove: () => void;
  // Comando de jog continuo compartido: lo lee un useFrame DENTRO del Canvas
  // (ManualJogger), así nada lo pisa en el mismo frame. null = nada presionado.
  jogCmdRef: React.MutableRefObject<{ kind: 'joint' | 'linear'; axis: number; dir: number } | null>;
  jogVelocityRef: React.MutableRefObject<number>;
  onClose: () => void;
  // Cobot en Vivo siembra la POSE LIBRARY real (deg→rad). Si se omite, usa el
  // default (solo HOME) → Celda 3D queda idéntica.
  initialPoses?: TeachPose[];
  // Acciones extra inyectadas al pie del panel (ej. "enviar pose al robot real"
  // en Cobot en Vivo). Recibe los joints actuales (RAD). null en Celda 3D.
  extraActions?: (jointsRad: [number, number, number, number, number, number]) => React.ReactNode;
  // "RX = 0" (modo LIN): lo dispara el padre poniendo un comando one-shot que
  // ManualJogger (dentro del Canvas) ejecuta por IK. Si se omite, el botón se oculta.
  onResetRx?: () => void;
  // realMode = robot real conectado → muestra "REAL MODE — speed capped" y
  // velocidades en mm/s (máx 200) y % (máx 30), nunca 3 m/s.
  realMode?: boolean;
  // commandPending = hay un comando real en vuelo hacia el cobot (move/joint).
  // Enciende el indicador "ROBOT REAL MOVIENDO" (Cobot en Vivo).
  commandPending?: boolean;
  // onJogStart = se llama al empezar un jog (Cobot en Vivo lo usa para pasar a
  // modo GHOST_PREVIEW y dejar de seguir la telemetría).
  onJogStart?: () => void;
  // previewOnly = el jog/GO solo mueven el FANTASMA (no hay envío real activo).
  // Muestra el aviso "Preview solamente — envío real desarmado".
  previewOnly?: boolean;
}) {
  const { t } = useLanguage();
  const [, force] = useState(0);
  const [mode, setMode] = useState<'joint' | 'linear'>('joint');
  const [velocity, setVelocity] = useState(() => jogVelocityRef.current);
  // Panel flotante: posición (null = default esquina inf-derecha) + minimizar.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [minimized, setMinimized] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [poseInput, setPoseInput] = useState<string[]>(
    () => jointsRef.current.map((r) => (r * TP_RAD2DEG).toFixed(1)));
  const poseDirty = useRef(false);
  const prevMoving = useRef(false);
  const [poses, setPoses] = useState<TeachPose[]>(() => initialPoses ?? initialTeachPoses());
  const [newName, setNewName] = useState('');

  // Tick 100 ms: refresca la UI con la pose real y auto-rellena los inputs de
  // pose (sección 4) salvo que se estén editando o el cobot se esté moviendo.
  useEffect(() => {
    const id = setInterval(() => {
      force((n) => n + 1);
      const mv = manualMovingRef.current;
      if (prevMoving.current && !mv) poseDirty.current = false;
      prevMoving.current = mv;
      if (!mv && !poseDirty.current) setPoseInput(jointsRef.current.map((r) => (r * TP_RAD2DEG).toFixed(1)));
    }, 100);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `moving` = deshabilita inputs SOLO durante un GO/pose ghost en curso (breve).
  // NO se pone por seguir al robot real → el preview nunca queda bloqueado.
  const moving = manualMovingRef.current;
  // Indicadores SEPARADOS (CAMBIO 7):
  //  · ghostMoving = el FANTASMA se mueve (jog presionado o GO ghost en curso).
  //  · robotMoving = hay un comando REAL en vuelo al cobot (commandPending).
  const ghostMoving = (jogCmdRef.current !== null) || manualMovingRef.current;
  const robotMoving = commandPending;
  const j = jointsRef.current;
  const g = gripperWorldRef.current;
  const eu = tcpEulerRef.current;
  // TCP relativo a la base del cobot (mm + grados) — fuente de verdad para el
  // panel cuando está disponible; si no, cae a world (compat). Refrescado por el
  // tick de 100 ms (force) igual que el resto del panel.
  const tcpB = tcpBaseRef?.current ?? null;

  // ── Movimiento continuo: presionar = empezar, soltar/salir = parar ──
  // Sólo fija el comando; el movimiento real lo aplica ManualJogger (useFrame).
  const holdStart = (kind: 'joint' | 'linear', axis: number, dir: number) => {
    if (manualMovingRef.current) return;   // hay un GO/pose en curso
    onJogStart?.();                        // Cobot en Vivo → pasa a GHOST_PREVIEW
    jogCmdRef.current = { kind, axis, dir };
  };
  const holdEnd = () => { jogCmdRef.current = null; };
  const closePanel = () => { holdEnd(); onClose(); };
  const toggleMinimized = () => { holdEnd(); setMinimized((m) => !m); };
  const startHeldButton = (
    e: React.PointerEvent<HTMLButtonElement>,
    kind: 'joint' | 'linear',
    axis: number,
    dir: number,
  ) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    holdStart(kind, axis, dir);
  };
  const endHeldButton = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    holdEnd();
  };

  useEffect(() => {
    // Cleanup global del jog continuo: cualquier "soltar"/salir limpia heldRef
    // para que el movimiento manual NUNCA quede pegado.
    const clearJog = () => { jogCmdRef.current = null; };
    window.addEventListener('pointerup', clearJog);
    window.addEventListener('pointercancel', clearJog);
    window.addEventListener('mouseup', clearJog);
    window.addEventListener('touchend', clearJog);
    window.addEventListener('touchcancel', clearJog);
    window.addEventListener('blur', clearJog);
    document.addEventListener('visibilitychange', clearJog);
    return () => {
      clearJog();
      window.removeEventListener('pointerup', clearJog);
      window.removeEventListener('pointercancel', clearJog);
      window.removeEventListener('mouseup', clearJog);
      window.removeEventListener('touchend', clearJog);
      window.removeEventListener('touchcancel', clearJog);
      window.removeEventListener('blur', clearJog);
      document.removeEventListener('visibilitychange', clearJog);
    };
  }, [jogCmdRef]);

  // ── Drag del panel por la barra de título ──
  const onDragStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = panelRef.current;
    if (!el) return;
    const parent = el.offsetParent as HTMLElement | null;
    const erect = el.getBoundingClientRect();
    const grabX = e.clientX - erect.left;
    const grabY = e.clientY - erect.top;
    const move = (ev: PointerEvent) => {
      const prect = parent ? parent.getBoundingClientRect() : ({ left: 0, top: 0 } as DOMRect);
      const maxX = Math.max(0, prect.width - el.offsetWidth);
      const maxY = Math.max(0, prect.height - el.offsetHeight);
      const nextX = Math.max(0, Math.min(maxX, ev.clientX - prect.left - grabX));
      const nextY = Math.max(0, Math.min(maxY, ev.clientY - prect.top - grabY));
      setPos({ x: nextX, y: nextY });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const goToPose = () => {
    if (moving) return;
    const v = poseInput.map((s) => parseFloat(s) * TP_DEG2RAD);
    if (v.some((n) => Number.isNaN(n))) return;
    poseDirty.current = false;
    startJointMove(v);
  };
  const savePose = () => {
    const name = newName.trim() || `pose${poses.length + 1}`;
    const next: TeachPose[] = [...poses, { name, joints: [...jointsRef.current] as TeachPose['joints'] }];
    setPoses(next); setNewName('');
  };
  const goPose = (p: TeachPose) => { if (!moving) startJointMove([...p.joints]); };
  const delPose = (i: number) => { setPoses(poses.filter((_, k) => k !== i)); };
  const renamePose = (i: number, name: string) => {
    setPoses(poses.map((p, k) => (k === i ? { ...p, name } : p)));
  };

  // ── estilos industriales compactos (gris claro, 280px, font 11px) ──
  const wrap: React.CSSProperties = {
    background: 'linear-gradient(180deg,#d6dae1 0%,#c2c7d0 100%)',
    border: '1px solid #878e9c', borderRadius: 8, padding: 8,
    fontFamily: '"JetBrains Mono","Fira Code","Courier New",monospace', color: '#1b1f27',
    fontSize: 11, boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    boxSizing: 'border-box', overflowX: 'hidden',
  };
  const sect: React.CSSProperties = {
    background: '#e8ebef', border: '1px solid #aab0bb', borderRadius: 5, padding: 4, marginBottom: 4,
  };
  const sTitle: React.CSSProperties = {
    fontSize: 9, fontWeight: 800, letterSpacing: 1, color: '#5a6270', marginBottom: 3, textTransform: 'uppercase',
  };
  const mono: React.CSSProperties = { fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' };
  const solid = (active: boolean, hue = '#2f5fbf'): React.CSSProperties => ({
    background: active ? hue : 'linear-gradient(180deg,#b9bfca 0%,#a3aab6 100%)',
    color: active ? '#fff' : '#2a3140', border: '1px solid ' + (active ? hue : '#8a91a0'),
    borderRadius: 4, padding: '4px 3px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
    fontFamily: 'inherit', letterSpacing: 0.3,
  });
  const arrowBtn = (dis: boolean): React.CSSProperties => ({
    background: dis ? '#aab0bb' : 'linear-gradient(180deg,#586273 0%,#3c4453 100%)',
    color: '#fff', border: '1px solid #2c3340', borderRadius: 4, width: 36, height: 36,
    fontSize: 13, fontWeight: 900, cursor: dis ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: dis ? 0.5 : 1,
    padding: 0, lineHeight: 1,
  });
  const numIn: React.CSSProperties = {
    width: '100%', background: '#fbfcfe', color: '#1b1f27', border: '1px solid #9aa1ad',
    borderRadius: 3, padding: '2px 4px', fontSize: 11, fontFamily: 'inherit', textAlign: 'right',
  };
  const tableRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, height: 24 };
  const titleBtn: React.CSSProperties = {
    background: '#b9bfca', color: '#2a3140', border: '1px solid #8a91a0', borderRadius: 3,
    width: 22, height: 18, fontSize: 11, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1, padding: 0,
  };
  // Columna del layout HORIZONTAL: cada "sección" es una columna lado a lado.
  const colBase: React.CSSProperties = {
    background: '#e8ebef', border: '1px solid #aab0bb', borderRadius: 5, padding: 5,
    display: 'flex', flexDirection: 'column', boxSizing: 'border-box', minHeight: 0,
  };
  // Flecha de jog COMPACTA (más chica que arrowBtn para la barra horizontal).
  const arrowSm = (dis: boolean): React.CSSProperties => ({
    background: dis ? '#aab0bb' : 'linear-gradient(180deg,#586273 0%,#3c4453 100%)',
    color: '#fff', border: '1px solid #2c3340', borderRadius: 4, width: 30, height: 22,
    fontSize: 11, fontWeight: 900, cursor: dis ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    opacity: dis ? 0.5 : 1, padding: 0, lineHeight: 1,
  });

  return (
    <div ref={panelRef} style={{
      // Layout HORIZONTAL: barra ancha y baja anclada abajo-izquierda del canvas.
      // zIndex 1000 + fondo opaco → tapa labels 3D (z ≤ 15) y overlays del canvas.
      ...wrap, position: 'absolute', width: 'min(96%, 820px)', zIndex: 1000, maxHeight: '56%',
      display: 'flex', flexDirection: 'column', pointerEvents: 'auto',
      ...(pos ? { left: pos.x, top: pos.y } : { left: 12, bottom: 12 }),
    }}>
      {/* Barra de título: arrastrar (drag) + STOP + minimizar + cerrar */}
      <div onPointerDown={onDragStart} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        cursor: 'move', userSelect: 'none', marginBottom: minimized ? 0 : 4, gap: 6,
      }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, color: '#2a3140' }}>🎮 TEACH PENDANT</span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button onPointerDown={(e) => e.stopPropagation()} onClick={stopMove} title="STOP de emergencia"
            style={{ ...titleBtn, width: 'auto', padding: '0 8px', background: 'radial-gradient(circle at 35% 30%,#ff5a5a,#bd1020 72%)', color: '#fff', border: '1px solid #7a0c14', fontSize: 9 }}>STOP</button>
          <button onPointerDown={(e) => e.stopPropagation()} onClick={toggleMinimized} title={minimized ? 'Expandir' : 'Minimizar'} style={titleBtn}>{minimized ? '▢' : '—'}</button>
          <button onPointerDown={(e) => e.stopPropagation()} onClick={closePanel} title="Cerrar" style={{ ...titleBtn, background: '#cf6b6b', borderColor: '#a04545', color: '#fff' }}>✕</button>
        </div>
      </div>

      {!minimized && (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'stretch', overflowY: 'auto', overflowX: 'hidden', minHeight: 0 }}>

        {/* COLUMNA 1 — Joints J1-J6 */}
        <div style={{ ...colBase, width: 152 }}>
          <div style={sTitle}>{t('cobot.lbl.tpSec1')}</div>
          {[0, 1, 2, 3, 4, 5].map((i) => {
            const v = j[i]; const [lo, hi] = JOINT_LIMITS[i];
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, height: 19 }}>
                <span style={{ ...mono, width: 18, fontWeight: 800, color: '#3a4150', fontSize: 9 }}>J{i + 1}</span>
                <input type="range" min={lo} max={hi} step={0.001} value={v} readOnly disabled
                  style={{ flex: 1, accentColor: '#2f5fbf', height: 10 }} />
                <span style={{ ...mono, width: 42, textAlign: 'right', fontWeight: 700, fontSize: 10 }}>
                  {(v * TP_RAD2DEG).toFixed(1)}
                </span>
              </div>
            );
          })}
        </div>

        {/* COLUMNA 2 — TCP + modo + velocidad */}
        <div style={{ ...colBase, width: 200 }}>
          <div style={sTitle} title="TCP relativo a la BASE del cobot (base_link) — X/Y/Z en mm, R/P/Yw en grados. NO es world.">
            {t('cobot.lbl.tpSec2')}{tcpB ? '' : t('cobot.lbl.tpSec2world')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1px 10px', ...mono, fontSize: 10 }}>
            <span>X <b>{(tcpB ? tcpB.xMm : g[0] * 1000).toFixed(0)}</b></span>
            <span>R <b>{(tcpB ? tcpB.rxDeg : eu[0] * TP_RAD2DEG).toFixed(1)}</b>°</span>
            <span>Y <b>{(tcpB ? tcpB.yMm : g[1] * 1000).toFixed(0)}</b></span>
            <span>P <b>{(tcpB ? tcpB.ryDeg : eu[1] * TP_RAD2DEG).toFixed(1)}</b>°</span>
            <span>Z <b>{(tcpB ? tcpB.zMm : g[2] * 1000).toFixed(0)}</b></span>
            <span>Yw <b>{(tcpB ? tcpB.rzDeg : eu[2] * TP_RAD2DEG).toFixed(1)}</b>°</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 6, marginBottom: 5 }}>
            <button onClick={() => { holdEnd(); setMode('joint'); }} style={solid(mode === 'joint')}>JOG</button>
            <button onClick={() => { holdEnd(); setMode('linear'); }} style={solid(mode === 'linear', '#b87333')}>LIN</button>
          </div>
          <div style={{ ...sTitle, marginBottom: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{t('cobot.lbl.velLabel')} {Math.round(velocity * 100)}%</span>
            {realMode && <span style={{ fontSize: 7.5, color: '#fff', background: '#bd1020', borderRadius: 3, padding: '1px 5px', letterSpacing: 0.3, fontWeight: 800 }}>REAL · CAP</span>}
          </div>
          <input type="range" min={0} max={1} step={0.01} value={velocity}
            onChange={(e) => { const v = parseFloat((e.target as HTMLInputElement).value); setVelocity(v); jogVelocityRef.current = v; }}
            style={{ width: '100%', height: 14, accentColor: mode === 'joint' ? '#2f5fbf' : '#b87333' }} />
          <div style={{ ...mono, fontSize: 8.5, color: realMode ? '#a8431a' : '#5a6270', marginTop: 2, lineHeight: 1.3 }}>
            {realMode
              ? (mode === 'joint'
                  ? t('cobot.lbl.velJointReal').replace('{v}', String(Math.round(velocity * JOINT_REAL_MAX_PERCENT))).replace('{max}', String(JOINT_REAL_MAX_PERCENT))
                  : t('cobot.lbl.velLinearReal').replace('{v}', String(Math.round(velocity * LINEAR_REAL_MAX_MPS * 1000))).replace('{max}', String(Math.round(LINEAR_REAL_MAX_MPS * 1000))))
              : (mode === 'joint'
                  ? t('cobot.lbl.velJointDemo').replace('{a}', String(Math.round(velocity * 120))).replace('{b}', String(Math.round(velocity * 180)))
                  : t('cobot.lbl.velLinearDemo').replace('{v}', (velocity * TCP_MAX_LINEAR_SPEED).toFixed(2)))}
          </div>
        </div>

        {/* COLUMNA 3 — Jog buttons (+ RX=0 en LIN) */}
        <div style={{ ...colBase, width: 150 }}>
          <div style={sTitle}>{mode === 'joint' ? t('cobot.lbl.tpSec3joint') : t('cobot.lbl.tpSec3tcp')}</div>
          {mode === 'joint' && [0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '22px 30px 30px', gap: 5, marginBottom: 3, alignItems: 'center' }}>
              <span style={{ ...mono, fontWeight: 800, color: '#3a4150', fontSize: 10 }}>J{i + 1}</span>
              <button disabled={moving} style={arrowSm(moving)}
                onPointerDown={(e) => startHeldButton(e, 'joint', i, -1)}
                onPointerUp={endHeldButton} onPointerCancel={endHeldButton}
                onLostPointerCapture={holdEnd}>◄</button>
              <button disabled={moving} style={arrowSm(moving)}
                onPointerDown={(e) => startHeldButton(e, 'joint', i, +1)}
                onPointerUp={endHeldButton} onPointerCancel={endHeldButton}
                onLostPointerCapture={holdEnd}>►</button>
            </div>
          ))}
          {mode === 'linear' && JOINT_AXES.map((lbl, ax) => {
            const vert = ax === 2;
            return (
              <div key={lbl} style={{ display: 'grid', gridTemplateColumns: '22px 30px 30px', gap: 5, marginBottom: 3, alignItems: 'center' }}>
                <span style={{ ...mono, fontWeight: 800, color: '#3a4150', fontSize: 10 }}>{lbl}</span>
                <button disabled={moving} style={arrowSm(moving)}
                  onPointerDown={(e) => startHeldButton(e, 'linear', ax, -1)}
                  onPointerUp={endHeldButton} onPointerCancel={endHeldButton}
                  onLostPointerCapture={holdEnd}>{vert ? '▼' : '◄'}</button>
                <button disabled={moving} style={arrowSm(moving)}
                  onPointerDown={(e) => startHeldButton(e, 'linear', ax, +1)}
                  onPointerUp={endHeldButton} onPointerCancel={endHeldButton}
                  onLostPointerCapture={holdEnd}>{vert ? '▲' : '►'}</button>
              </div>
            );
          })}
          {mode === 'linear' && onResetRx && (
            <button onClick={() => { if (!moving) onResetRx(); }} disabled={moving}
              title={t('cobot.lbl.tpRxReset')}
              style={{ ...solid(true, '#b87333'), padding: '6px 4px', marginTop: 4, opacity: moving ? 0.5 : 1, cursor: moving ? 'not-allowed' : 'pointer' }}>RX = 0</button>
          )}
          {ghostMoving && <div style={{ ...mono, fontSize: 9, color: '#2f5fbf', marginTop: 5, fontWeight: 700 }}>{t('cobot.lbl.previewMoving')}</div>}
          {robotMoving && <div style={{ ...mono, fontSize: 9, color: '#bd1020', marginTop: 3, fontWeight: 800 }}>{t('cobot.lbl.robotMoving')}</div>}
          {previewOnly && <div style={{ ...mono, fontSize: 8.5, color: '#8a7a4a', marginTop: 4, lineHeight: 1.3 }}>{t('cobot.lbl.previewOnly')}</div>}
        </div>

        {/* COLUMNA 4 — Poses / GO TO POSE */}
        <div style={{ ...colBase, width: 236 }}>
          <div style={sTitle}>{t('cobot.lbl.tpSec4')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 3 }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <span style={{ ...mono, fontSize: 8.5, color: '#5a6270', width: 14 }}>J{i + 1}</span>
                <input type="number" step={0.1} value={poseInput[i]} disabled={moving}
                  onChange={(e) => { poseDirty.current = true; const val = (e.target as HTMLInputElement).value; setPoseInput((f) => f.map((x, k) => (k === i ? val : x))); }}
                  style={{ ...numIn, fontSize: 10, opacity: moving ? 0.5 : 1 }} />
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 5 }}>
            <button onClick={goToPose} disabled={moving} style={{ ...solid(!moving), background: moving ? '#aab0bb' : '#2f5fbf', cursor: moving ? 'wait' : 'pointer', padding: '6px 4px' }}>GO TO POSE</button>
            <button onClick={savePose} style={{ ...solid(true, '#1aa044'), padding: '6px 4px' }}>SAVE</button>
          </div>
          <input type="text" value={newName} placeholder={t('cobot.lbl.poseName')}
            onChange={(e) => setNewName((e.target as HTMLInputElement).value)}
            style={{ ...numIn, textAlign: 'left', marginTop: 4, fontSize: 10 }} />
          <div style={{ ...sTitle, marginTop: 5 }}>{t('cobot.lbl.savedPoses')} ({poses.length})</div>
          {/* Scroll vertical SOLO de esta lista (no del canvas) */}
          <div style={{ overflowY: 'auto', overflowX: 'hidden', maxHeight: 116, minHeight: 0 }}>
            {poses.map((p, i) => (
              <div key={i} style={{ background: '#fbfcfe', border: '1px solid #c4c9d2', borderRadius: 4, padding: 4, marginBottom: 4 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 3, alignItems: 'center' }}>
                  <input type="text" value={p.name} onChange={(e) => renamePose(i, (e.target as HTMLInputElement).value)}
                    style={{ ...numIn, textAlign: 'left', fontWeight: 700, padding: '2px 4px', fontSize: 10 }} />
                  <button onClick={() => goPose(p)} disabled={moving} style={{ ...solid(!moving), background: moving ? '#aab0bb' : '#2f5fbf', padding: '4px 8px' }}>GO</button>
                  <button onClick={() => delPose(i)} style={{ ...solid(true, '#bd2030'), padding: '4px 6px' }}>DEL</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* COLUMNA 5 — Acciones extra (Cobot en Vivo, si aplica) */}
        {extraActions && (
          <div style={{ ...colBase, width: 210 }}>
            {extraActions(jointsRef.current)}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

// ── In-Canvas: aplica el jog CONTINUO del TeachPendant escribiendo jointsRef ──
// Corre como useFrame DENTRO del Canvas, así nada lo pisa en el mismo frame
// (el CellVisualBinder/SequencePlayer ceden cuando jogCmdRef está activo).
// Integración por TIEMPO (dt) escalada por los LÍMITES REALES del cobot:
//   joint  : Δθ  = frac · JOINT_MAX_SPEED[i] · dt   (rad)   — 100% = 120/180°/s
//   lineal : Δpos = frac · TCP_MAX_LINEAR_SPEED · dt (m)    — 100% = 3 m/s
//   rot    : Δang = frac · TCP_MAX_ROT_SPEED   · dt (rad)   — 100% = 180°/s
// X/Y/Z y Rx/Ry/Rz usan el MISMO solver 6-DOF (solveIK6DOnce, fija posición
// Y orientación). Rx→roll, Ry→pitch, Rz→yaw (rotación en ejes de mundo).
export function ManualJogger({
  jogCmdRef, velocityRef, jointsRef, robotRef, groupRef, manualMovingRef, obstacles, poseDirtyRef,
  alignCmdRef, realModeRef,
}: {
  jogCmdRef: React.MutableRefObject<{ kind: 'joint' | 'linear'; axis: number; dir: number } | null>;
  velocityRef: React.MutableRefObject<number>;
  jointsRef: React.MutableRefObject<[number, number, number, number, number, number]>;
  robotRef: React.MutableRefObject<URDFRobot | null>;
  groupRef: React.MutableRefObject<THREE.Group | null>;
  manualMovingRef: React.MutableRefObject<boolean>;
  obstacles: ReturnType<typeof collisionAABBs>;
  poseDirtyRef: React.MutableRefObject<boolean>;
  // Comando one-shot del TeachPendant: 'rx0' = poner RX(roll)=0 vía IK. null = nada.
  alignCmdRef?: React.MutableRefObject<'rx0' | null>;
  // true = robot REAL conectado → topes de velocidad seguros (lineal 0.20 m/s,
  // articular 30 %). false/undefined = DEMO → velocidades técnicas (3 m/s).
  realModeRef?: React.MutableRefObject<boolean>;
}) {
  const tmpPos = useMemo(() => new THREE.Vector3(), []);
  const tmpQuat = useMemo(() => new THREE.Quaternion(), []);
  const dq = useMemo(() => new THREE.Quaternion(), []);
  const axX = useMemo(() => new THREE.Vector3(1, 0, 0), []);
  const axY = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const axZ = useMemo(() => new THREE.Vector3(0, 0, 1), []);
  const lastWarn = useRef(0);
  const warnIkLimit = (rotErr: number) => {
    const t = performance.now();
    if (t - lastWarn.current < 1500) return;   // throttle 1.5 s
    lastWarn.current = t;
    console.warn(
      `[TeachPendant] Límite de IK: la orientación del TCP no se alcanzó del todo ` +
      `(error ${(rotErr * 180 / Math.PI).toFixed(1)}°). El jog continúa con el mejor ` +
      `esfuerzo; X/Y/Z no se ven afectados.`,
    );
  };
  useFrame((_, delta) => {
    // ── One-shot "RX = 0": pone roll(X) del TCP en 0 manteniendo X/Y/Z y RY/RZ.
    // seed = jointsRef.current; si el IK no converge, avisa y NO toca la pose.
    if (alignCmdRef?.current === 'rx0') {
      alignCmdRef.current = null;
      if (manualMovingRef.current) return;
      const robot = robotRef.current, group = groupRef.current;
      if (!robot || !group) return;
      const seed = [...jointsRef.current] as [number, number, number, number, number, number];
      applyJoints6(robot, seed);
      group.updateMatrixWorld(true);
      tcpPose(robot, group, tmpPos, tmpQuat);
      const euNow = new THREE.Euler().setFromQuaternion(tmpQuat, 'XYZ');
      // RX→0, conservando pitch(Y) y yaw(Z) y la posición.
      const targetQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, euNow.y, euNow.z, 'XYZ'));
      const targetPos: [number, number, number] = [tmpPos.x, tmpPos.y, tmpPos.z];
      const r = solveIK6DOnce(robot, group, targetPos, targetQuat, seed, obstacles);
      if (r.converged || (r.positionError < 0.01 && r.rotationError < 0.10)) {
        jointsRef.current = r.joints as typeof jointsRef.current;
        poseDirtyRef.current = true;
      } else {
        console.warn(
          `[TeachPendant] RX=0: el IK no convergió (pos ${(r.positionError * 1000).toFixed(1)} mm / ` +
          `rot ${(r.rotationError * 180 / Math.PI).toFixed(1)}°). Se mantiene la pose actual.`,
        );
      }
      return;
    }
    const cmd = jogCmdRef.current;
    if (!cmd || manualMovingRef.current) return;   // jog tiene prioridad; GO/pose lo bloquea
    const dt = Math.min(delta, 0.05);              // clamp anti lag-spike (≤ 50 ms)
    const v = velocityRef.current;                 // 0..1 = fracción del tope
    // Modo REAL (gateway conectado) → topes seguros; DEMO → velocidad técnica.
    const real = realModeRef?.current === true;
    const linMax = real ? LINEAR_REAL_MAX_MPS : TCP_MAX_LINEAR_SPEED;       // m/s
    const angScale = real ? JOINT_REAL_MAX_PERCENT / 100 : 1;              // 0.30 o 1
    if (cmd.kind === 'joint') {
      const i = cmd.axis;
      const [lo, hi] = JOINT_LIMITS[i];
      const step = cmd.dir * (v * angScale) * JOINT_MAX_SPEED[i] * dt;   // real: ≤30% del máx
      jointsRef.current[i] = Math.max(lo, Math.min(hi, jointsRef.current[i] + step));
      poseDirtyRef.current = true;
    } else {
      const robot = robotRef.current;
      const group = groupRef.current;
      if (!robot || !group) return;
      const seed = [...jointsRef.current] as [number, number, number, number, number, number];
      applyJoints6(robot, seed);
      group.updateMatrixWorld(true);
      tcpPose(robot, group, tmpPos, tmpQuat);     // seed = pose live (siempre)
      const axis = cmd.axis;
      const isRot = axis >= 3;
      const targetPos: [number, number, number] = [tmpPos.x, tmpPos.y, tmpPos.z];
      let targetQuat = tmpQuat;
      if (!isRot) {
        targetPos[axis] += cmd.dir * v * linMax * dt;     // m — real: ≤0.20 m/s
      } else {
        // Rx(3)→roll, Ry(4)→pitch, Rz(5)→yaw. Rotación en ejes de MUNDO:
        // dq · qActual aplica el incremento en el frame del mundo.
        const ax = axis === 3 ? axX : axis === 4 ? axY : axZ;
        const ang = cmd.dir * (v * angScale) * TCP_MAX_ROT_SPEED * dt;   // rad — real: ≤30%
        targetQuat = dq.setFromAxisAngle(ax, ang).multiply(tmpQuat);
      }
      const r = solveIK6DOnce(robot, group, targetPos, targetQuat, seed, obstacles);
      // Aceptación SEPARADA por tipo para no congelar la rotación:
      //  · Traslación: posErr pequeño (igual que antes).
      //  · Rotación: reorientar la muñeca puede derivar unos mm de posición; el
      //    IK no siempre converge del todo en un frame. Aceptamos el progreso
      //    incremental mientras el TCP no DERIVE (posErr < 2 cm) → la orientación
      //    se acumula frame a frame. Si no converge, avisamos pero NO paramos.
      const accept = isRot
        ? (r.converged || r.positionError < 0.02)
        : (r.converged || r.positionError < IK_ACCEPT_TOL);
      if (accept) {
        jointsRef.current = r.joints as typeof jointsRef.current;
        poseDirtyRef.current = true;
        if (isRot && !r.converged) warnIkLimit(r.rotationError);
      } else if (isRot) {
        warnIkLimit(r.rotationError);   // límite de IK: avisa, no rompe X/Y/Z
      }
    }
  });
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
  activePoseRef,
  poseDirtyRef,
  startLinearMove,
  startJointMove,
  stopMove,
  manualMovingRef,
  tcpEulerRef,
  playerRef,
  cafiStateRef,
  cafiColorRef,
  startCycle,
  playerPause,
  playerResume,
  playerReset,
  cafiGraspYawRef,
  setCafiGraspYaw,
  cafiGraspPitchRef,
  setCafiGraspPitch,
  cafiGraspRollRef,
  setCafiGraspRoll,
  cafiGraspOffsetXRef,
  setCafiGraspOffsetX,
  cafiGraspOffsetYRef,
  setCafiGraspOffsetY,
  cafiGraspOffsetZRef,
  setCafiGraspOffsetZ,
  ikResult,
  ikRunning,
  runRetarget,
  applyIkResult,
  discardIkResult,
  tcpPinned,
  pinnedTcpRef,
  togglePinTcp,
  poseRegenStatus,
  poseRegenWarnings,
  regeneratePoseLib,
  cellSim,
}: {
  setPose: (p: PoseName) => void;
  cellSim: UseCellSimulation;
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
  activePoseRef: React.MutableRefObject<PoseName>;
  poseDirtyRef: React.MutableRefObject<boolean>;
  startLinearMove: (x: number, y: number, z: number, roll: number, pitch: number, yaw: number) => void;
  startJointMove: (target: number[]) => void;
  stopMove: () => void;
  manualMovingRef: React.MutableRefObject<boolean>;
  tcpEulerRef: React.MutableRefObject<[number, number, number]>;
  playerRef: React.MutableRefObject<PlayerState>;
  cafiStateRef: React.MutableRefObject<CafiState>;
  cafiColorRef: React.MutableRefObject<CafiColor>;
  startCycle: (verdict: Verdict | 'auto') => void;
  playerPause: () => void;
  playerResume: () => void;
  playerReset: () => void;
  cafiGraspYawRef: React.MutableRefObject<number>;
  setCafiGraspYaw: (yaw: number) => void;
  cafiGraspPitchRef: React.MutableRefObject<number>;
  setCafiGraspPitch: (pitch: number) => void;
  cafiGraspRollRef: React.MutableRefObject<number>;
  setCafiGraspRoll: (roll: number) => void;
  cafiGraspOffsetXRef: React.MutableRefObject<number>;
  setCafiGraspOffsetX: (v: number) => void;
  cafiGraspOffsetYRef: React.MutableRefObject<number>;
  setCafiGraspOffsetY: (v: number) => void;
  cafiGraspOffsetZRef: React.MutableRefObject<number>;
  setCafiGraspOffsetZ: (v: number) => void;
  ikResult: IK6Result | null;
  ikRunning: boolean;
  runRetarget: () => void;
  applyIkResult: () => void;
  discardIkResult: () => void;
  tcpPinned: boolean;
  pinnedTcpRef: React.MutableRefObject<{
    pos: [number, number, number];
    quat: [number, number, number, number];
  } | null>;
  togglePinTcp: () => void;
  poseRegenStatus: 'idle' | 'running' | 'cached' | 'fresh' | 'failed' | 'baked';
  poseRegenWarnings: string[];
  regeneratePoseLib: () => void;
}) {
  const T = useTheme();
  const { t } = useLanguage();
  const [, force] = useState(0);
  // Tick 100 ms: refresca los readouts vivos del panel. Los controles manuales
  // (jog / pose / TCP) viven ahora en <TeachPendant>, que maneja sus campos.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const j = jointsRef.current;
  const g = gripperWorldRef.current;
  // Pose activa (punto de partida de la captura) + flag de "editada por jog".
  // Se leen en cada render; HMIPanel se refresca cada 100 ms por el interval.
  const activePose = activePoseRef.current;
  const poseDirty = poseDirtyRef.current;
  const manualMoving = manualMovingRef.current;
  const gripPct = (gripperLiveRef.current / GRIPPER_OPEN_M) * 100;
  const gripIsOpen = gripperRef.current > GRIPPER_OPEN_M / 2;
  const collisions = collisionsRef.current;
  // El modo activo lo posee la máquina de estados (fuente de verdad única).
  // La pestaña sólo refleja `snapshot.mode`; al hacer click se llama switchMode,
  // que además pausa la simulación HMI al entrar a DEBUG (separación de modos).
  const tab: 'hmi' | 'debug' = cellSim.snapshot.mode === 'DEBUG' ? 'debug' : 'hmi';
  return (
    <div style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, width: 300,
      background: T.topbar,
      borderLeft: `1px solid ${T.border}`, padding: 14, color: T.text,
      overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12,
      zIndex: 25,
    }}>
      {/* Tab bar.  HMI = automático ROS-like; DEBUG = manual/diagnóstico. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
        <button onClick={() => cellSim.switchMode('HMI')} style={tabBtnStyle(tab === 'hmi', T)}>
          HMI
        </button>
        <button onClick={() => cellSim.switchMode('DEBUG')} style={tabBtnStyle(tab === 'debug', T)}>
          DEBUG
        </button>
      </div>

      {tab === 'hmi' && <OperatorHMI sim={cellSim} />}

      {tab === 'debug' && <>

      {/* Aviso: en DEBUG la simulación automática de la HMI queda pausada. */}
      <div style={{
        border: '1px solid #4a3a1a', background: 'rgba(120,80,20,0.18)', borderRadius: 8,
        padding: '8px 10px', fontSize: 10, color: '#fbbf24', lineHeight: 1.4,
      }}>
        {t('cobot.lbl.dbgWarnPre')}<b>HMI</b>{t('cobot.lbl.dbgWarnMid')}<b>Reset → Start</b>{t('cobot.lbl.dbgWarnPost')}
      </div>

      {/* === Sequence player === */}
      <Section title="Cycle Sequence">
        {(() => {
          const p = playerRef.current;
          const seq = p.sequence;
          const step = seq[p.step];
          const total = seq.length;
          const progress = step && step.kind === 'pose'
            ? Math.min(1, p.t / Math.max(0.0001, moveDurationFor(p.startJoints, POSE_LIB[step.pose], step.speed)))
            : step && step.kind === 'disc' && step.duration > 0
              ? Math.min(1, p.t / step.duration)
              : step && step.kind === 'wait' && step.dwell > 0
                ? Math.min(1, p.t / step.dwell)
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
                    : step.kind === 'cafiColor'
                      ? `CAFI tint → ${step.color}`
                      : step.kind === 'disc'
                        ? `Disc → ${(step.target * 180 / Math.PI).toFixed(0)}°`
                        : 'Waiting…'))
              : '—';
          const verdictColour =
            cafiColorRef.current === 'accept' ? '#22c55e'
            : cafiColorRef.current === 'reject' ? '#ef4444'
            : '#788090';
          const verdictLabel =
            cafiColorRef.current === 'accept' ? 'PASS ✓'
            : cafiColorRef.current === 'reject' ? 'FAIL ✗'
            : '— pending';
          return (
            <>
              {/* Three START buttons that build a fresh verdict-specific cycle */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
                <button onClick={() => startCycle('auto')} style={{
                  ...btnStyle, padding: '8px 4px', fontSize: 10,
                  background: 'linear-gradient(180deg,#3b8bff 0%,#2563eb 100%)',
                }}>▶ 50/50</button>
                <button onClick={() => startCycle('accept')} style={{
                  ...btnStyle, padding: '8px 4px', fontSize: 10,
                  background: 'linear-gradient(180deg,#22cc55 0%,#15803d 100%)',
                }}>{t('cobot.lbl.dbgAccepted')}</button>
                <button onClick={() => startCycle('reject')} style={{
                  ...btnStyle, padding: '8px 4px', fontSize: 10,
                  background: 'linear-gradient(180deg,#ef4444 0%,#b91c1c 100%)',
                }}>{t('cobot.lbl.dbgRejected')}</button>
              </div>
              {/* Pause / Resume / Reset row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, marginTop: 4 }}>
                <button onClick={playerPause}
                  disabled={!p.playing}
                  style={{
                    ...btnStyle, padding: '6px 4px', fontSize: 10,
                    background: !p.playing
                      ? T.dark ? 'linear-gradient(180deg,#3a4f6a 0%,#2a3548 100%)' : T.borderSoft
                      : 'linear-gradient(180deg,#f47835 0%,#d96416 100%)',
                    cursor: !p.playing ? 'not-allowed' : 'pointer',
                  }}>⏸ PAUSE</button>
                <button onClick={playerResume}
                  disabled={p.playing || finished}
                  style={{
                    ...btnStyle, padding: '6px 4px', fontSize: 10,
                    background: (p.playing || finished)
                      ? T.dark ? 'linear-gradient(180deg,#3a4f6a 0%,#2a3548 100%)' : T.borderSoft
                      : 'linear-gradient(180deg,#3b8bff 0%,#2563eb 100%)',
                    cursor: (p.playing || finished) ? 'not-allowed' : 'pointer',
                  }}>▶ RESUME</button>
                <button onClick={playerReset} style={{
                  ...btnStyle, padding: '6px 4px', fontSize: 10,
                  background: 'linear-gradient(180deg,#475569 0%,#334155 100%)',
                }}>⏮ RESET</button>
              </div>
              <div style={{ ...statRow(T), marginTop: 8 }}>
                <span>verdict</span>
                <span style={{ color: verdictColour, fontWeight: 700 }}>{verdictLabel}</span>
              </div>
              <div style={{ ...statRow }}>
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
        {/* Indicador de POSE ACTIVA — desde dónde parte Santiago en cada captura.
            Azul = exactamente en la pose; ámbar = ya movió el cobot con jog. */}
        <div style={{
          marginBottom: 8, padding: '8px 10px', borderRadius: 6,
          background: poseDirty ? 'rgba(120,80,20,0.30)' : 'rgba(20,70,90,0.35)',
          border: '1px solid ' + (poseDirty ? '#fbbf2466' : '#33dffe66'),
        }}>
          <div style={{ fontSize: 9, letterSpacing: 1, color: '#7a8aa0', marginBottom: 3 }}>
            {t('cobot.lbl.poseActive')} {poseDirty && <span style={{ color: '#fbbf24' }}>{t('cobot.lbl.poseEdited')}</span>}
          </div>
          <div style={{
            fontSize: 13, fontWeight: 800, fontFamily: 'monospace',
            color: poseDirty ? '#fbbf24' : '#33dffe',
          }}>
            {activePose.replace('POSE_', '').replace(/_/g, ' ')}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          {([
            'HOME', 'SAFE_CONVEYOR',
            'PICK_CONVEYOR', 'SAFE_RIVET',
            'PLACE_RIVET', 'PICK_RIVET',
            'SAFE_CAMERA', 'PLACE_CAMERA',
            'PICK_CAMERA', 'SAFE_BINS',
            'ACCEPTED_PLACE', 'REJECTED_PLACE',
          ] as PoseName[]).map((p) => {
            const isActive = p === activePose;
            return (
              <button key={p} onClick={() => setPose(p)} style={{
                ...btnStyle,
                ...(isActive ? {
                  background: poseDirty
                    ? 'linear-gradient(180deg,#caa23a 0%,#9a7a20 100%)'
                    : 'linear-gradient(180deg,#33dffe 0%,#1ba0c0 100%)',
                  color: '#04121c', fontWeight: 700,
                  boxShadow: '0 0 0 1px ' + (poseDirty ? '#fbbf24' : '#33dffe'),
                } : {}),
              }}>
                {p.replace('POSE_', '').replace(/_/g, ' ')}
              </button>
            );
          })}
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
              : T.dark ? 'linear-gradient(180deg,#3a4f6a 0%,#2a3548 100%)' : T.borderSoft,
          }}>
          {showCollisions ? '◉ HIDE' : '◯ SHOW'} ({COLLISION_BOXES.length} boxes)
        </button>
        <div style={{ ...statRow(T), marginTop: 8 }}>
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

      {/* IK solver — retarget the current TCP world position with collision
          avoidance.  Useful when a pose collides and needs an alternative
          joint configuration that reaches the same TCP. */}
      <Section title="IK Solver (Retarget)">
        <button onClick={runRetarget} disabled={ikRunning}
          style={{
            ...btnStyle, fontSize: 11, padding: '8px 10px',
            background: ikRunning
              ? T.dark ? 'linear-gradient(180deg,#3a4f6a 0%,#2a3548 100%)' : T.borderSoft
              : 'linear-gradient(180deg,#b87333 0%,#8b5a25 100%)',
            cursor: ikRunning ? 'wait' : 'pointer',
          }}>
          {ikRunning ? '⏳ SOLVING…' : '🔧 RETARGET current pose'}
        </button>
        <div style={{ ...statRow(T), marginTop: 6, fontSize: 9, color: T.dim }}>
          Re-solves joints to keep TCP at the current world XYZ while
          avoiding collision boxes (DLS + random restarts).
        </div>
        {ikResult && (
          <div style={{
            marginTop: 8, padding: 8,
            background: ikResult.converged && ikResult.collisions.length === 0
              ? 'rgba(20,80,30,0.35)'
              : 'rgba(80,40,20,0.35)',
            border: '1px solid ' + (
              ikResult.converged && ikResult.collisions.length === 0
                ? '#22dd5566' : '#fbbf2466'
            ),
            borderRadius: 4,
          }}>
            <div style={statRow(T)}>
              <span>pos error</span>
              <span>{(ikResult.positionError * 1000).toFixed(2)} mm</span>
            </div>
            <div style={statRow(T)}>
              <span>rot error</span>
              <span>{(ikResult.rotationError * 180 / Math.PI).toFixed(2)}°</span>
            </div>
            <div style={statRow(T)}>
              <span>collisions</span>
              <span style={{ color: ikResult.collisions.length === 0 ? '#22dd55' : '#ff5566' }}>
                {ikResult.collisions.length === 0 ? '✓ clear' : `✗ ${ikResult.collisions.length}`}
              </span>
            </div>
            <div style={statRow(T)}>
              <span>iter / attempts</span>
              <span>{ikResult.iterations} / {ikResult.attempts}</span>
            </div>
            {ikResult.collisions.length > 0 && (
              <div style={{ fontSize: 9, color: '#ff8090', marginTop: 4, fontFamily: 'monospace' }}>
                {ikResult.collisions.join(', ')}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 8 }}>
              <button onClick={applyIkResult}
                style={{
                  ...btnStyle, fontSize: 10, padding: '6px 8px',
                  background: ikResult.converged
                    ? 'linear-gradient(180deg,#22cc55 0%,#1aa044 100%)'
                    : T.dark ? 'linear-gradient(180deg,#3a4f6a 0%,#2a3548 100%)' : T.borderSoft,
                }}>
                ✓ APPLY
              </button>
              <button onClick={discardIkResult}
                style={{ ...btnStyle, fontSize: 10, padding: '6px 8px', background: '#3a1018' }}>
                ✕ DISCARD
              </button>
            </div>
          </div>
        )}

        {/* V26 POSE_LIB regeneration status + manual trigger */}
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #1a2434' }}>
          <div style={statRow(T)}>
            <span>POSE_LIB (V26)</span>
            <span style={{
              color: poseRegenStatus === 'fresh' ? '#22dd55'
                : poseRegenStatus === 'cached' ? '#33dffe'
                : poseRegenStatus === 'running' ? '#fbbf24'
                : poseRegenStatus === 'failed' ? '#ff5566'
                : poseRegenStatus === 'baked' ? '#a3e635'
                : '#788090',
              fontWeight: 700,
            }}>
              {poseRegenStatus === 'fresh' ? '✓ fresh'
                : poseRegenStatus === 'cached' ? '◉ cached'
                : poseRegenStatus === 'running' ? '⏳ solving…'
                : poseRegenStatus === 'failed' ? '✗ failed'
                : poseRegenStatus === 'baked' ? '✓ baked defaults'
                : '— idle'}
            </span>
          </div>
          <button onClick={regeneratePoseLib}
            disabled={poseRegenStatus === 'running'}
            style={{
              ...btnStyle, fontSize: 10, padding: '6px 8px', marginTop: 4,
              background: poseRegenStatus === 'running'
                ? T.dark ? 'linear-gradient(180deg,#3a4f6a 0%,#2a3548 100%)' : T.borderSoft
                : 'linear-gradient(180deg,#3b8bff 0%,#2563eb 100%)',
              cursor: poseRegenStatus === 'running' ? 'wait' : 'pointer',
            }}>
            🔁 RE-IK all poses for V26
          </button>
          {poseRegenWarnings.length > 0 && (
            <div style={{
              marginTop: 6, padding: 6,
              background: 'rgba(80,40,20,0.35)', border: '1px solid #fbbf2444',
              borderRadius: 4, fontSize: 9, color: '#fbbf24',
              fontFamily: 'monospace', lineHeight: 1.4, maxHeight: 80, overflowY: 'auto',
            }}>
              <div style={{ marginBottom: 4, fontWeight: 700 }}>
                {poseRegenWarnings.length} pose(s) with residual:
              </div>
              {poseRegenWarnings.map((w, i) => <div key={i}>{w}</div>)}
            </div>
          )}
        </div>
      </Section>

      {/* Gripper manual override */}
      <Section title="Gripper">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          <button onClick={() => setGripper(true)}
            style={{ ...btnStyle, background: gripIsOpen
              ? 'linear-gradient(180deg,#22cc55 0%,#1aa044 100%)'
              : T.dark ? 'linear-gradient(180deg,#3a4f6a 0%,#2a3548 100%)' : T.borderSoft }}>
            OPEN
          </button>
          <button onClick={() => setGripper(false)}
            style={{ ...btnStyle, background: !gripIsOpen
              ? 'linear-gradient(180deg,#f47835 0%,#d96416 100%)'
              : T.dark ? 'linear-gradient(180deg,#3a4f6a 0%,#2a3548 100%)' : T.borderSoft }}>
            CLOSE
          </button>
        </div>
        <div style={statRow(T)}>
          <span>jaw</span>
          <span>{(gripperLiveRef.current * 1000).toFixed(1)} mm ({gripPct.toFixed(0)}%)</span>
        </div>
        {/* CAFI grasp orientation — spin the held workpiece around the
            gripper centre without moving the cobot.  Only takes effect
            when the CAFI is in_gripper. */}
        <div style={{ marginTop: 8 }}>
          <div style={statRow(T)}>
            <span>CAFI yaw (Z)</span>
            <span>{(cafiGraspYawRef.current * 180 / Math.PI).toFixed(1)}°</span>
          </div>
          <input type="range" min={-Math.PI} max={Math.PI} step={0.01}
            defaultValue={Math.PI / 2}
            onInput={(e) => setCafiGraspYaw(parseFloat((e.target as HTMLInputElement).value))}
            style={{ width: '100%' }} />
        </div>
        <div style={{ marginTop: 6 }}>
          <div style={statRow(T)}>
            <span>CAFI pitch (X)</span>
            <span>{(cafiGraspPitchRef.current * 180 / Math.PI).toFixed(1)}°</span>
          </div>
          <input type="range" min={-Math.PI} max={Math.PI} step={0.01}
            defaultValue={Math.PI}
            onInput={(e) => setCafiGraspPitch(parseFloat((e.target as HTMLInputElement).value))}
            style={{ width: '100%' }} />
        </div>
        <div style={{ marginTop: 6 }}>
          <div style={statRow(T)}>
            <span>CAFI roll (Y)</span>
            <span>{(cafiGraspRollRef.current * 180 / Math.PI).toFixed(1)}°</span>
          </div>
          <input type="range" min={-Math.PI} max={Math.PI} step={0.01}
            defaultValue={0}
            onInput={(e) => setCafiGraspRoll(parseFloat((e.target as HTMLInputElement).value))}
            style={{ width: '100%' }} />
        </div>

        {/* CAFI grasp offset (X/Y/Z in metres, in the gripper's local frame).
            Each axis has a slider for coarse adjustment + a numeric input
            for exact values.  Only takes effect in_gripper. */}
        <div style={{
          marginTop: 10, paddingTop: 8,
          borderTop: '1px solid #1a2434',
        }}>
          <div style={{ fontSize: 9, letterSpacing: 1, color: '#688', marginBottom: 6 }}>
            CAFI offset (m) · gripper local
          </div>
          <OffsetControl label="X" valueRef={cafiGraspOffsetXRef} setter={setCafiGraspOffsetX} />
          <OffsetControl label="Y" valueRef={cafiGraspOffsetYRef} setter={setCafiGraspOffsetY} />
          <OffsetControl label="Z" valueRef={cafiGraspOffsetZRef} setter={setCafiGraspOffsetZ} />
        </div>
      </Section>

      {/* Disc rotation */}
      <Section title="Turntable">
        <input type="range" min={-Math.PI} max={Math.PI} step={0.01}
          defaultValue={0}
          onInput={(e) => setDiscAngle(parseFloat((e.target as HTMLInputElement).value))}
          style={{ width: '100%' }} />
        <div style={statRow(T)}><span>angle</span><span>{(discAngleRef.current * 180 / Math.PI).toFixed(1)}°</span></div>
      </Section>

      {/* Telemetry */}
      <Section title="Telemetry (TCP world XYZ)">
        <div style={statRow(T)}><span>x</span><span>{g[0].toFixed(3)} m</span></div>
        <div style={statRow(T)}><span>y</span><span>{g[1].toFixed(3)} m</span></div>
        <div style={statRow(T)}><span>z</span><span>{g[2].toFixed(3)} m</span></div>
      </Section>

      {/* El TeachPendant vive como overlay flotante sobre el canvas 3D,
          no dentro de este panel lateral. */}

      </>}

      <div style={{ marginTop: 'auto', fontSize: 9, color: '#456', textAlign: 'center' }}>
        URDF loader · V60 meshes
      </div>
    </div>
  );
}

// Tab button styling — bordered top tabs, active = orange, inactive = dim.
const tabBtnStyle = (active: boolean, T: Theme): React.CSSProperties => ({
  background: active
    ? 'linear-gradient(180deg, #b87333 0%, #8b5a25 100%)'
    : T.dark ? 'linear-gradient(180deg, #1a2434 0%, #0c1828 100%)' : T.panel,
  color: active ? '#fff' : T.dim,
  borderTop: '1px solid ' + (active ? '#b87333' : T.border),
  borderLeft: '1px solid ' + (active ? '#b87333' : T.border),
  borderRight: '1px solid ' + (active ? '#b87333' : T.border),
  borderBottom: 'none',
  padding: '8px 4px', fontSize: 11, fontWeight: 700,
  letterSpacing: 1.5, cursor: 'pointer',
});

// Slider + numeric input that share a ref-backed value.  Both are CONTROLLED
// (value, not defaultValue) so dragging the slider updates the numeric input
// and vice versa.  The HMI's 100 ms tick re-renders this whole component so
// the displayed value always reflects valueRef.current.
function OffsetControl({ label, valueRef, setter }: {
  label: string;
  valueRef: React.MutableRefObject<number>;
  setter: (v: number) => void;
}) {
  const T = useTheme();
  const handle = (v: string) => {
    const n = parseFloat(v);
    if (Number.isFinite(n)) setter(n);
  };
  const v = valueRef.current;
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={statRow(T)}>
        <span>{label}</span>
        <span>{(v * 1000).toFixed(1)} mm</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 64px', gap: 4, alignItems: 'center' }}>
        <input type="range" min={-0.4} max={0.4} step={0.001}
          value={v}
          onChange={(e) => handle((e.target as HTMLInputElement).value)}
          style={{ width: '100%' }} />
        <input type="number" step={0.001}
          value={v.toFixed(4)}
          onChange={(e) => handle((e.target as HTMLInputElement).value)}
          style={{
            background: T.panel2, color: T.text,
            border: `1px solid ${T.border}`, borderRadius: 3,
            padding: '3px 4px', fontSize: 10, fontFamily: 'monospace',
            width: '100%',
          }} />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const T = useTheme();
  return (
    <div style={{
      background: T.dark ? 'rgba(20, 30, 48, 0.55)' : T.panel, border: `1px solid ${T.border}`,
      borderRadius: 6, padding: 10,
    }}>
      <div style={{
        fontSize: 9, letterSpacing: 2, color: T.dim,
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

function jogBtnStyle(T: Theme): React.CSSProperties {
  return {
    background: T.dark ? 'linear-gradient(180deg,#2a3548 0%,#1a2434 100%)' : T.panel,
    color: T.text, border: `1px solid ${T.border}`, borderRadius: 3,
    padding: '4px 2px', fontSize: 9, fontWeight: 600,
    cursor: 'pointer', letterSpacing: 0.2, fontFamily: 'monospace',
  };
}

function statRow(T: Theme): React.CSSProperties {
  return {
    display: 'flex', justifyContent: 'space-between',
    fontSize: 10, fontFamily: 'monospace', color: T.muted, padding: '2px 0',
  };
}

function numInputStyle(T: Theme): React.CSSProperties {
  return {
    width: 110, background: T.panel2, color: T.text,
    border: `1px solid ${T.border}`, borderRadius: 3, padding: '3px 6px',
    fontSize: 11, fontFamily: 'monospace', textAlign: 'right',
  };
}

// ── Root component ───────────────────────────────────────────────────────────
export default function CellViewer3D() {
  const T = useTheme();
  const jointsRef = useRef<[number, number, number, number, number, number]>([...POSE_LIB.HOME]);
  // Pose activa que el cobot "está ejecutando" en modo DEBUG: la última pose
  // seleccionada con setPose (botones Set Pose / load de Saved). Sirve de punto
  // de partida visible para Santiago al recapturar. `poseDirtyRef` marca que el
  // operador ya hizo jog desde esa pose (las articulaciones ya no coinciden).
  const activePoseRef = useRef<PoseName>('HOME');
  const poseDirtyRef = useRef<boolean>(false);
  const discAngleRef = useRef(0);
  // Simulación ROS-like de la celda COMPLETA (cola de CAFIs, sensor, robot,
  // mesa, remachado, visión, bins). La máquina de estados pura es la fuente de
  // verdad; en modo HMI escribe el ángulo del disco en discAngleRef y el binder
  // visual sigue al resto de la escena. En modo DEBUG la simulación se detiene y
  // los controles manuales son los dueños de los refs.
  // El cobot VISUAL es lento (0.008 rad/frame → ~7-10 s/tarea). La FSM por
  // defecto resuelve cada tarea del cobot en 1.6 s, así que el player visual
  // se "saltaría" tareas ya completadas (teletransporte). Alargamos SÓLO las
  // duraciones de tarea del cobot (config, NO la lógica FSM) para que la FSM no
  // adelante más de una tarea y el cobot ejecute la secuencia completa de cada
  // pick/place. El remachado sigue en 30 s. Tunable si se ve muy lento.
  // Duraciones de tarea del cobot ALTAS: en la escena 3D el cobot visual marca el
  // fin de cada tarea (lockstep, notifyCobotVisualDone en attach/detach) y la FSM
  // la completa con esa señal. El timer (120 s) es sólo un tope de seguridad por si
  // el binder nunca señala. Así la FSM NUNCA se adelanta al cobot visual → no se
  // saltan movimientos ni se teletransportan piezas. (rotate/riveting/etc. reales.)
  const cellSim = useCellSimulation(discAngleRef, {
    config: {
      pickConveyor: 120, placeOutside: 120, pickRiveted: 120,
      placeVision: 120, pickVision: 120, placeBin: 120, recoverySlow: 120,
    },
  });
  const gripperRef = useRef<number>(GRIPPER_OPEN_M);        // target
  const gripperLiveRef = useRef<number>(GRIPPER_OPEN_M);    // animated
  const gripperWorldRef = useRef<[number, number, number]>([0, 0, 0]);
  const tcpEulerRef = useRef<[number, number, number]>([0, 0, 0]); // orient TCP (XYZ) live
  const tcpBaseRef = useRef<TcpInBase | null>(null);               // TCP relativo a base del cobot (mm+°)
  // Movimiento manual del panel DEBUG (Linear TCP / Set Joints). `manualMoveRef`
  // es la polilínea de joints que anima ManualMover; `manualMovingRef` es true
  // mientras dura (el panel deshabilita inputs leyéndolo).
  const manualMoveRef = useRef<MoveState | null>(null);
  const manualMovingRef = useRef<boolean>(false);
  const collisionsRef = useRef<string[]>([]);
  const [showCollisions, setShowCollisions] = useState(false);
  // TeachPendant: panel FLOTANTE sobre el canvas (no divide el canvas). Abierto
  // por defecto; el botón 🎮 lo reabre al cerrarlo.
  const [pendantOpen, setPendantOpen] = useState(true);
  // Comando de jog continuo (lo fija el TeachPendant, lo aplica ManualJogger en
  // un useFrame DENTRO del Canvas → nada pisa jointsRef en el mismo frame).
  const jogCmdRef = useRef<{ kind: 'joint' | 'linear'; axis: number; dir: number } | null>(null);
  const jogVelocityRef = useRef(0.3);
  const tcpAlignCmdRef = useRef<'rx0' | null>(null);   // one-shot "RX=0" del TeachPendant
  const cafiStateRef = useRef<CafiState>('conveyor');
  const cafiColorRef = useRef<CafiColor>('natural');
  // Calibración en vivo: offset +X (m) del pick del conveyor. El binder lo
  // aplica al TCP de POSE_PICK_CONVEYOR (re-IK) para alinear el gripper con el
  // CAFI sin recompilar. El ref lo lee el useFrame; el state, el slider.
  const pickOffsetXRef = useRef<number>(0);
  const [pickOffsetX, setPickOffsetX] = useState<number>(0);
  const cobotRobotRef = useRef<URDFRobot | null>(null);
  const cobotGroupRef = useRef<THREE.Group | null>(null);
  const turntableRobotRef = useRef<URDFRobot | null>(null);
  // CAFI que el cobot VISUAL carga ahora mismo (set/clear por el binder en los
  // pasos attach/detach del player). Lo lee el renderizador per-entidad para
  // decidir qué pieza sigue al gripper (las demás siguen su propio estado).
  const carriedCafiIdRef = useRef<number | null>(null);
  // Overlay debug de CAFIs (IDs/estado/markers), apagado por default (CAMBIO 8).
  const [showCafiDebug, setShowCafiDebug] = useState(false);
  // Cobot a su altura REAL (la mesa no sube); obstáculos en su sitio original.
  const obstacles = useMemo(() => collisionAABBs(), []);
  // Alineación de objetos a las poses reales (mismos offsets que Cobot en Vivo).
  const layout = useLayoutOffsets(true);
  const [ikResult, setIkResult] = useState<IK6Result | null>(null);
  const [ikRunning, setIkRunning] = useState(false);
  // Status of the V26 POSE_LIB shown in the DEBUG panel.  Baked = compile-time
  // defaults (the 19 poses pre-solved by scripts/regen-v26-poses.mjs); cached
  // = a user-triggered re-IK persisted in localStorage; fresh = re-IK just ran
  // this session.  The manual button still lets the operator re-solve.
  const [poseRegenStatus, setPoseRegenStatus] = useState<'idle' | 'running' | 'cached' | 'fresh' | 'failed' | 'baked'>('baked');
  const [poseRegenWarnings, setPoseRegenWarnings] = useState<string[]>([]);

  // Apply a pose-lib snapshot into the runtime POSE_LIB object.
  const applyPoseLibSnapshot = (snap: Record<string, [number, number, number, number, number, number]>) => {
    for (const name of Object.keys(POSE_LIB_V60)) {
      const v = snap[name];
      if (v) POSE_LIB[name as PoseName] = [...v] as [number, number, number, number, number, number];
    }
  };

  // RE-IK DESACTIVADO (2026-06-04): las poses ahora son la pose library REAL del
  // usuario (POSE_LIBRARY_DEG, joint-space puro). NO se recalcula IK ni se
  // sobrescribe POSE_LIB, para no alterar las poses calibradas en hardware.
  const regeneratePoseLib = () => {
    setPoseRegenStatus('baked');
    setPoseRegenWarnings([]);
    // eslint-disable-next-line no-console
    console.log('%c[POSE_LIB] RE-IK deshabilitado: poses reales del usuario (sin recalcular IK)',
      'color:#a3e635;font-weight:700');
  };

  // Boot-time: NO restaurar caché. La fuente única es la pose library baked del
  // usuario; una caché vieja (nombres V60) sólo podría corromper las poses.
  // (loadPoseLibV26FromCache / applyPoseLibSnapshot quedan disponibles pero sin uso.)
  // TCP pin: when active, jog moves are followed by a quick 6D IK solve that
  // pulls the TCP back to the captured world POSE (position + orientation).
  // Lets the operator explore valid configurations manually with the gripper
  // pose locked.
  interface PinnedPose {
    pos: [number, number, number];
    quat: [number, number, number, number];
  }
  const pinnedTcpRef = useRef<PinnedPose | null>(null);
  const [tcpPinned, setTcpPinned] = useState(false);

  const togglePinTcp = () => {
    if (tcpPinned) {
      pinnedTcpRef.current = null;
      setTcpPinned(false);
      return;
    }
    const robot = cobotRobotRef.current;
    const group = cobotGroupRef.current;
    if (!robot || !group) return;
    applyJoints6(robot, jointsRef.current);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    tcpPose(robot, group, pos, quat);
    pinnedTcpRef.current = {
      pos: [pos.x, pos.y, pos.z],
      quat: [quat.x, quat.y, quat.z, quat.w],
    };
    setTcpPinned(true);
  };

  // Retarget: take the current TCP world POSE (position + orientation) as
  // the 6D IK target and re-solve from the current joints with collision-
  // aware random restarts.  Pose preservation means we look for alternate
  // IK branches (elbow up/down, wrist flipped, etc.) — there's no null
  // space to slide through.
  const retargetTargetQuat = useMemo(() => new THREE.Quaternion(), []);
  const runRetarget = () => {
    const robot = cobotRobotRef.current;
    const group = cobotGroupRef.current;
    if (!robot || !group) return;
    setIkRunning(true);
    setTimeout(() => {
      try {
        const startJoints = [...jointsRef.current];
        applyJoints6(robot, startJoints);
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        tcpPose(robot, group, pos, quat);
        const target: [number, number, number] = [pos.x, pos.y, pos.z];
        retargetTargetQuat.copy(quat);
        const result = solveIK6D(robot, group, target, retargetTargetQuat, startJoints, obstacles);
        applyJoints6(robot, startJoints);
        group.updateMatrixWorld(true);
        setIkResult(result);
      } finally {
        setIkRunning(false);
      }
    }, 0);
  };

  const applyIkResult = () => {
    if (!ikResult) return;
    jointsRef.current = [...ikResult.joints] as typeof jointsRef.current;
    setIkResult(null);
  };

  const discardIkResult = () => setIkResult(null);
  // V53 calibrated grasp orientation — CAFI sits flat in the gripper at
  // yaw=+90°, pitch=180°, roll=0.  These are the "real" defaults; the
  // sliders are there for fine-tuning, not for finding the base pose.
  const cafiGraspYawRef = useRef<number>(Math.PI / 2);
  const cafiGraspPitchRef = useRef<number>(Math.PI);
  const cafiGraspRollRef = useRef<number>(0);
  const setCafiGraspYaw = (yaw: number) => { cafiGraspYawRef.current = yaw; };
  const setCafiGraspPitch = (pitch: number) => { cafiGraspPitchRef.current = pitch; };
  const setCafiGraspRoll = (roll: number) => { cafiGraspRollRef.current = roll; };

  // Grasp offset (CAFI mesh position relative to gripper cafi_lateral_target_frame).
  // Defaults: user-tuned golden values for the in_gripper grasp.
  const cafiGraspOffsetXRef = useRef<number>(CAFI_GRASP_OFFSET_GOLD[0]);
  const cafiGraspOffsetYRef = useRef<number>(CAFI_GRASP_OFFSET_GOLD[1]);
  const cafiGraspOffsetZRef = useRef<number>(CAFI_GRASP_OFFSET_GOLD[2]);
  const setCafiGraspOffsetX = (v: number) => { cafiGraspOffsetXRef.current = v; };
  const setCafiGraspOffsetY = (v: number) => { cafiGraspOffsetYRef.current = v; };
  const setCafiGraspOffsetZ = (v: number) => { cafiGraspOffsetZRef.current = v; };
  const playerRef = useRef<PlayerState>({
    playing: false,
    step: 0,
    t: 0,
    startJoints: [...POSE_LIB.HOME] as PlayerState['startJoints'],
    startDisc: 0,
    sequence: buildSequence('accept'),
    verdict: 'accept',
  });
  const [, forcePlayerTick] = useState(0); // re-render HMI when player advances

  // Start a fresh cycle with the given verdict.  Resets all refs, builds the
  // verdict-specific sequence (accept → green tail, reject → red tail), and
  // sets the player playing.  Random verdict (50/50) → 'auto'.
  const startCycle = (verdict: Verdict | 'auto') => {
    const v: Verdict = verdict === 'auto'
      ? (Math.random() < 0.5 ? 'accept' : 'reject')
      : verdict;
    playerRef.current = {
      playing: true,
      step: 0,
      t: 0,
      startJoints: [...POSE_LIB.HOME] as PlayerState['startJoints'],
      startDisc: 0,
      sequence: buildSequence(v),
      verdict: v,
    };
    jointsRef.current = [...POSE_LIB.HOME] as typeof jointsRef.current;
    discAngleRef.current = 0;
    gripperRef.current = GRIPPER_OPEN_M;
    cafiStateRef.current = 'conveyor';
    cafiColorRef.current = 'natural';
    forcePlayerTick((n) => n + 1);
  };
  const playerPause = () => {
    playerRef.current.playing = false;
    forcePlayerTick((n) => n + 1);
  };
  const playerResume = () => {
    if (playerRef.current.step < playerRef.current.sequence.length) {
      playerRef.current.playing = true;
      forcePlayerTick((n) => n + 1);
    }
  };
  const playerReset = () => {
    playerRef.current = {
      playing: false,
      step: 0,
      t: 0,
      startJoints: [...POSE_LIB.HOME] as PlayerState['startJoints'],
      startDisc: 0,
      sequence: playerRef.current.sequence,
      verdict: playerRef.current.verdict,
    };
    jointsRef.current = [...POSE_LIB.HOME] as typeof jointsRef.current;
    discAngleRef.current = 0;
    gripperRef.current = GRIPPER_OPEN_M;
    cafiStateRef.current = 'conveyor';
    cafiColorRef.current = 'natural';
    forcePlayerTick((n) => n + 1);
  };

  const setPose = (p: PoseName) => {
    jointsRef.current = [...POSE_LIB[p]] as typeof jointsRef.current;
    // Auto-set the gripper open/closed state for this pose (default = abierto).
    gripperRef.current = (GRIPPER_OPEN_AT_POSE[p] ?? true) ? GRIPPER_OPEN_M : GRIPPER_CLOSED_M;
    // Indicador de captura: recordar desde qué pose parte el operador.
    activePoseRef.current = p;
    poseDirtyRef.current = false;
  };

  // ── Movimiento manual LINEAR (TCP en línea recta) — panel DEBUG ──────────────
  // Resuelve IK del TCP destino (pos + RPY mundo, Euler XYZ), construye la recta
  // con buildLinearWaypoints y la encola en manualMoveRef. ManualMover la anima
  // a 0.008 rad/frame. No toca la FSM.
  const startLinearMove = (x: number, y: number, z: number, roll: number, pitch: number, yaw: number) => {
    const robot = cobotRobotRef.current;
    const group = cobotGroupRef.current;
    if (!robot || !group || manualMovingRef.current) return;
    const start = [...jointsRef.current];
    // TCP actual (FK) para diagnóstico del mapeo de ejes.
    const startPos = new THREE.Vector3(); const startQuat = new THREE.Quaternion();
    applyJoints6(robot, start); tcpPose(robot, group, startPos, startQuat);
    const targetQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(roll, pitch, yaw, 'XYZ'));
    // 1) IK del TCP destino (seed = pose actual → intenta quedarse en la misma
    // rama). Si no converge en la rama actual, reintento robusto multi-seed
    // (random restart) por si hace falta reconfigurar la base (J1) o el codo.
    let ik: ReturnType<typeof solveIK6DOnce> = solveIK6DOnce(robot, group, [x, y, z], targetQuat, start, obstacles);
    if (!ik.converged) {
      const robust = solveIK6D(robot, group, [x, y, z], targetQuat, start, obstacles);
      if (robust.converged || robust.positionError < ik.positionError) ik = robust;
    }
    // TCP alcanzado por la solución IK (para verificar que X/Y/Z llegan).
    const achPos = new THREE.Vector3(); const achQuat = new THREE.Quaternion();
    applyJoints6(robot, ik.joints); tcpPose(robot, group, achPos, achQuat);
    applyJoints6(robot, jointsRef.current); group.updateMatrixWorld(true); // restaurar pose viva
    const f4 = (n: number) => n.toFixed(4);
    // eslint-disable-next-line no-console
    console.log(
      `[MOVE LINEAR] start=(${f4(startPos.x)}, ${f4(startPos.y)}, ${f4(startPos.z)}) ` +
      `target=(${f4(x)}, ${f4(y)}, ${f4(z)}) achieved=(${f4(achPos.x)}, ${f4(achPos.y)}, ${f4(achPos.z)}) ` +
      `converged=${ik.converged} posErr=${(ik.positionError * 1000).toFixed(1)}mm`,
    );
    if (!ik.converged) {
      // eslint-disable-next-line no-console
      console.warn(
        `%c[Linear TCP] IK destino no convergió (pos ${(ik.positionError * 1000).toFixed(1)}mm / rot ${(ik.rotationError * 180 / Math.PI).toFixed(1)}°). Movimiento cancelado.`,
        'color:#f59e0b;font-weight:700',
      );
      return;
    }
    // 2) Recta del TCP entre pose actual y destino (reusa buildLinearWaypoints).
    const wps = buildLinearWaypoints(robot, group, start, ik.joints, obstacles, LINEAR_IK_SAMPLES);
    applyJoints6(robot, jointsRef.current); group.updateMatrixWorld(true); // restaurar pose viva
    if (wps) {
      manualMoveRef.current = { poly: [start, ...wps], cursor: 0, rate: LINEAR_WP_PER_SEC, kind: 'linear' };
    } else {
      // eslint-disable-next-line no-console
      console.warn('%c[Linear TCP] la recta no convergió en IK → fallback a JOINT.', 'color:#f59e0b;font-weight:700');
      manualMoveRef.current = { poly: [start, ik.joints], cursor: 0, rate: 1e9, kind: 'linear' };
    }
    manualMovingRef.current = true;
    poseDirtyRef.current = true;
  };

  // ── Movimiento manual a JOINTS exactos (interpola JOINT) — panel DEBUG ───────
  // Encola [pose actual → joints destino] (clamp a límites). rate=1e9: el cursor
  // salta al final y el techo por-frame (0.008 rad) controla la velocidad.
  const startJointMove = (target: number[]) => {
    if (manualMovingRef.current) return;
    const start = [...jointsRef.current];
    const clamped = target.map((v, i) => {
      const [lo, hi] = JOINT_LIMITS[i];
      return Math.max(lo, Math.min(hi, v));
    });
    manualMoveRef.current = { poly: [start, clamped], cursor: 0, rate: 1e9, kind: 'joint' };
    manualMovingRef.current = true;
    poseDirtyRef.current = true;
  };
  // STOP de emergencia (TeachPendant): cancela el movimiento manual en curso.
  // El cobot queda en la pose interpolada actual (jointsRef no se altera) y los
  // controles se rehabilitan. NO toca la FSM.
  const stopMove = () => {
    manualMoveRef.current = null;
    manualMovingRef.current = false;
  };
  const setDiscAngle = (a: number) => { discAngleRef.current = a; };
  const setGripper = (open: boolean) => {
    gripperRef.current = open ? GRIPPER_OPEN_M : GRIPPER_CLOSED_M;
  };

  // Manual jog: nudge one joint by delta rad, clamped to the URDF limit.
  // If the TCP is pinned, follow the jog with a one-shot 6D IK pass that
  // pulls the TCP back to the captured pose (position + orientation).  The
  // rest of the chain absorbs the change — the operator perturbs one joint
  // at a time and watches valid alternate configurations emerge.
  const pinTargetQuat = useMemo(() => new THREE.Quaternion(), []);
  const jogJoint = (i: number, delta: number) => {
    const [lo, hi] = JOINT_LIMITS[i];
    const next = Math.max(lo, Math.min(hi, jointsRef.current[i] + delta));
    jointsRef.current[i] = next;
    // El operador movió articulaciones: ya no estamos exactamente en la pose.
    poseDirtyRef.current = true;
    const pin = pinnedTcpRef.current;
    if (pin && cobotRobotRef.current && cobotGroupRef.current) {
      pinTargetQuat.set(pin.quat[0], pin.quat[1], pin.quat[2], pin.quat[3]);
      const r = solveIK6DOnce(
        cobotRobotRef.current,
        cobotGroupRef.current,
        pin.pos,
        pinTargetQuat,
        [...jointsRef.current],
        obstacles,
      );
      jointsRef.current = r.joints as typeof jointsRef.current;
    }
  };

  // (Las "saved positions" viejas se eliminaron: el TeachPendant maneja sus
  //  propias poses en memoria.)

  return (
    <div style={{
      background: T.bg,
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Canvas
          shadows
          camera={{ position: [3.4, -2.0, 2.2], fov: 42, near: 0.05, far: 50, up: [0, 0, 1] }}
          style={{ background: T.bg }}
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
            <Cobot
              jointsRef={jointsRef}
              gripperRef={gripperRef}
              gripperLiveRef={gripperLiveRef}
              gripperWorldRef={gripperWorldRef}
              tcpEulerRef={tcpEulerRef}
              collisionsRef={collisionsRef}
              robotRef={cobotRobotRef}
              groupRef={cobotGroupRef}
              tcpBaseRef={tcpBaseRef}
            />
            <Turntable angleRef={discAngleRef} robotRef={turntableRobotRef} offset={layout.turntableOffset} zLift={BASE_TURNTABLE} />
            {/* CAFIs: en HMI, un renderizador PER-ENTIDAD (1 malla por pieza, sin
                duplicado/teletransporte). En DEBUG, la CafiMesh única la maneja el
                SequencePlayer. */}
            {cellSim.snapshot.mode === 'HMI' ? (
              <CafiEntities
                cafis={cellSim.snapshot.cafis}
                carriedCafiIdRef={carriedCafiIdRef}
                cobotRobotRef={cobotRobotRef}
                turntableRobotRef={turntableRobotRef}
                graspYawRef={cafiGraspYawRef}
                graspPitchRef={cafiGraspPitchRef}
                graspRollRef={cafiGraspRollRef}
                graspOffsetXRef={cafiGraspOffsetXRef}
                graspOffsetYRef={cafiGraspOffsetYRef}
                graspOffsetZRef={cafiGraspOffsetZRef}
                layout={layout}
                showDebug={showCafiDebug}
              />
            ) : (
              <CafiMesh
                stateRef={cafiStateRef}
                colorRef={cafiColorRef}
                cobotRobotRef={cobotRobotRef}
                turntableRobotRef={turntableRobotRef}
                graspYawRef={cafiGraspYawRef}
                graspPitchRef={cafiGraspPitchRef}
                graspRollRef={cafiGraspRollRef}
                graspOffsetXRef={cafiGraspOffsetXRef}
                graspOffsetYRef={cafiGraspOffsetYRef}
                graspOffsetZRef={cafiGraspOffsetZRef}
                layout={layout}
              />
            )}
          </Suspense>

          {/* Binder visual: en modo HMI hace que el cobot/gripper/CAFI sigan a
              la máquina de estados. En DEBUG retorna y manda el SequencePlayer. */}
          <CellVisualBinder
            machine={cellSim.machine}
            jointsRef={jointsRef}
            gripperRef={gripperRef}
            gripperLiveRef={gripperLiveRef}
            cafiStateRef={cafiStateRef}
            cafiColorRef={cafiColorRef}
            cobotRobotRef={cobotRobotRef}
            cobotGroupRef={cobotGroupRef}
            obstacles={obstacles}
            pickOffsetXRef={pickOffsetXRef}
            jogCmdRef={jogCmdRef}
            carriedCafiIdRef={carriedCafiIdRef}
          />

          <SequencePlayer
            playerRef={playerRef}
            jointsRef={jointsRef}
            discAngleRef={discAngleRef}
            gripperRef={gripperRef}
            cafiStateRef={cafiStateRef}
            cafiColorRef={cafiColorRef}
            jogCmdRef={jogCmdRef}
          />

          {/* Animador de los movimientos manuales del panel DEBUG. */}
          <ManualMover
            moveRef={manualMoveRef}
            movingRef={manualMovingRef}
            jointsRef={jointsRef}
          />

          {/* Jog continuo del TeachPendant (escribe jointsRef dentro del loop). */}
          <ManualJogger
            jogCmdRef={jogCmdRef}
            velocityRef={jogVelocityRef}
            jointsRef={jointsRef}
            robotRef={cobotRobotRef}
            groupRef={cobotGroupRef}
            manualMovingRef={manualMovingRef}
            obstacles={obstacles}
            poseDirtyRef={poseDirtyRef}
            alignCmdRef={tcpAlignCmdRef}
          />

          <CollisionBoxes visible={showCollisions} />

          {/* Labels (la mesa no sube → z originales). */}
          <Label x={1.152} y={0.940} z={1.10}  text="Lexium Cobot"    color="#60a5fa" />
          <Label x={1.534845 + layout.conveyorOffset[0]} y={1.420 + layout.conveyorOffset[1]} z={1.18} text="Conveyor 1"     color="#fbbf24" />
          <Label x={1.942345 + layout.conveyorOffset[0]} y={1.365 + layout.conveyorOffset[1]} z={1.34} text="Suministro CAFI" color="#fbbf24" />
          <Label x={0.754205 + layout.turntableOffset[0]} y={1.259061 + layout.turntableOffset[1]} z={1.25} text="Turntable"   color="#a78bfa" />
          <Label x={0.549205 + layout.turntableOffset[0]} y={1.259061 + layout.turntableOffset[1]} z={1.47} text="Riveting"    color="#fb923c" />
          <Label x={0.750 + layout.visionOffset[0]} y={0.804 + layout.visionOffset[1]} z={1.10}  text="Vision"          color="#a78bfa" />
          <Label x={0.750 + layout.visionOffset[0]} y={0.804 + layout.visionOffset[1]} z={1.62}  text="Cámara"          color="#e879f9" />
          <Label x={1.650 + layout.binAcceptOffset[0]} y={0.720 + layout.binAcceptOffset[1]} z={1.18}  text="Aceptado"        color="#22dd55" />
          <Label x={1.330 + layout.binRejectOffset[0]} y={0.700 + layout.binRejectOffset[1]} z={1.18}  text="Rechazado"       color="#ff5566" />
          <Label x={0.442 + layout.turntableOffset[0]} y={0.430 + layout.turntableOffset[1]} z={1.60}  text="HMI"             color="#38bdf8" />
          <Label x={1.150 + layout.turntableOffset[0]} y={0.980 + layout.turntableOffset[1]} z={0.80}  text="Controlador · PLC" color="#9fb3c8" />
        </Canvas>

        {/* Calibración en vivo del pick del conveyor (offset +X) — overlay. */}
        <div style={{
          position: 'absolute', left: 12, bottom: 12, zIndex: 20,
          background: T.dark ? 'rgba(7,17,30,0.88)' : 'rgba(255,255,255,0.92)', border: `1px solid ${T.border}`,
          borderRadius: 8, padding: '10px 12px', width: 250,
          fontFamily: 'monospace', color: T.text,
        }}>
          <div style={{ fontSize: 11, color: '#7fd1ff', marginBottom: 6, letterSpacing: '0.04em' }}>
            CALIBRACIÓN · Pick conveyor (offset X)
          </div>
          <input
            type="range" min={-0.2} max={0.2} step={0.01} value={pickOffsetX}
            onChange={(e) => {
              const v = parseFloat((e.target as HTMLInputElement).value);
              setPickOffsetX(v);
              pickOffsetXRef.current = v;
            }}
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 4 }}>
            <span>{pickOffsetX >= 0 ? '+' : ''}{Math.round(pickOffsetX * 1000)} mm</span>
            <button
              onClick={() => { setPickOffsetX(0); pickOffsetXRef.current = 0; }}
              style={{
                background: '#13283c', color: '#9cf', border: '1px solid #28526f',
                borderRadius: 4, fontSize: 10, cursor: 'pointer', padding: '1px 6px',
              }}
            >reset</button>
          </div>
        </div>

        {/* Debug CAFIs (CAMBIO 8): toggle + lista por entidad (id/estado/verdict),
            resalta activeCafiId y el que va en el gripper. Apagado por default. */}
        <div style={{
          position: 'absolute', left: 12, top: 12, zIndex: 20,
          background: T.dark ? 'rgba(7,17,30,0.88)' : 'rgba(255,255,255,0.92)', border: `1px solid ${T.border}`,
          borderRadius: 8, padding: '8px 10px', width: 210,
          fontFamily: 'monospace', color: T.text,
        }}>
          <button
            onClick={() => setShowCafiDebug((s) => !s)}
            style={{
              width: '100%', background: showCafiDebug ? '#0e2c3a' : '#13283c',
              color: showCafiDebug ? '#00e5ff' : '#9cf',
              border: `1px solid ${showCafiDebug ? '#00e5ff66' : '#28526f'}`,
              borderRadius: 4, fontSize: 10, cursor: 'pointer', padding: '3px 6px',
              letterSpacing: '0.04em',
            }}
          >{showCafiDebug ? '◉ CAFI DEBUG' : '◯ CAFI DEBUG'}</button>
          {showCafiDebug && (
            <div style={{ marginTop: 6, fontSize: 10, lineHeight: 1.5 }}>
              <div style={{ color: '#7fd1ff' }}>activeCafiId: {String(cellSim.snapshot.activeCafiId)}</div>
              {cellSim.snapshot.cafis.length === 0 && <div style={{ color: '#678' }}>— sin CAFIs —</div>}
              {cellSim.snapshot.cafis.map((c) => {
                const carried = carriedCafiIdRef.current === c.id;
                const active = cellSim.snapshot.activeCafiId === c.id;
                const vcol = c.verdict === 'PASS' ? '#22c55e' : c.verdict === 'FAIL' ? '#ef4444' : '#d97340';
                return (
                  <div key={c.id} style={{ color: active ? '#00e5ff' : '#aac', whiteSpace: 'nowrap' }}>
                    <span style={{ color: vcol }}>#{c.id}</span>{' '}
                    {c.state}{c.fixtureId ? `·${c.fixtureId}` : ''}{carried ? ' ✋' : ''}
                  </div>
                );
              })}
            </div>
          )}
        </div>

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
          activePoseRef={activePoseRef}
          poseDirtyRef={poseDirtyRef}
          startLinearMove={startLinearMove}
          startJointMove={startJointMove}
          stopMove={stopMove}
          manualMovingRef={manualMovingRef}
          tcpEulerRef={tcpEulerRef}
          playerRef={playerRef}
          cafiStateRef={cafiStateRef}
          cafiColorRef={cafiColorRef}
          startCycle={startCycle}
          playerPause={playerPause}
          playerResume={playerResume}
          playerReset={playerReset}
          cafiGraspYawRef={cafiGraspYawRef}
          setCafiGraspYaw={setCafiGraspYaw}
          cafiGraspPitchRef={cafiGraspPitchRef}
          setCafiGraspPitch={setCafiGraspPitch}
          cafiGraspRollRef={cafiGraspRollRef}
          setCafiGraspRoll={setCafiGraspRoll}
          cafiGraspOffsetXRef={cafiGraspOffsetXRef}
          setCafiGraspOffsetX={setCafiGraspOffsetX}
          cafiGraspOffsetYRef={cafiGraspOffsetYRef}
          setCafiGraspOffsetY={setCafiGraspOffsetY}
          cafiGraspOffsetZRef={cafiGraspOffsetZRef}
          setCafiGraspOffsetZ={setCafiGraspOffsetZ}
          ikResult={ikResult}
          ikRunning={ikRunning}
          runRetarget={runRetarget}
          applyIkResult={applyIkResult}
          discardIkResult={discardIkResult}
          tcpPinned={tcpPinned}
          pinnedTcpRef={pinnedTcpRef}
          togglePinTcp={togglePinTcp}
          poseRegenStatus={poseRegenStatus}
          poseRegenWarnings={poseRegenWarnings}
          regeneratePoseLib={regeneratePoseLib}
          cellSim={cellSim}
        />

        {/* TeachPendant FLOTANTE y draggable sobre el canvas (z alto). El canvas
            ocupa SIEMPRE el 100%; el pendant flota encima. Botón 🎮 reabre. */}
        {pendantOpen ? (
          <TeachPendant
            jointsRef={jointsRef} gripperWorldRef={gripperWorldRef} tcpEulerRef={tcpEulerRef}
            tcpBaseRef={tcpBaseRef}
            manualMovingRef={manualMovingRef} startJointMove={startJointMove} stopMove={stopMove}
            jogCmdRef={jogCmdRef} jogVelocityRef={jogVelocityRef} onClose={() => setPendantOpen(false)}
            onResetRx={() => { tcpAlignCmdRef.current = 'rx0'; }} />
        ) : (
          <button onClick={() => setPendantOpen(true)} title="Abrir Teach Pendant" style={{
            position: 'absolute', top: 12, right: 12, zIndex: 1000,
            width: 40, height: 40, borderRadius: 10, cursor: 'pointer',
            background: 'linear-gradient(180deg,#b87333 0%,#8b5a25 100%)',
            border: '1px solid #d99a5b', color: '#fff', fontSize: 18,
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
          }}>🎮</button>
        )}
      </div>
    </div>
  );
}

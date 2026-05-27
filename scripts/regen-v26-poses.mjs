// scripts/regen-v26-poses.mjs
//
// One-off offline regeneration of the cobot POSE_LIB for the V26 URDF.
//   - V60 TCP world poses are computed by an analytical FK of the V60
//     chain (same numbers as the URDF).
//   - V26 inverse kinematics is solved numerically (damped least squares
//     on a 6×6 finite-difference Jacobian with random restart on
//     non-convergence) so the resulting joints place the V26 cobot's TCP
//     at the V60 target pose.
//   - Output: a TypeScript snippet that can be pasted into
//     components/CellViewer3D.tsx as POSE_LIB_V26.
//
// Run:
//   node scripts/regen-v26-poses.mjs

import * as THREE from 'three';

const PI = Math.PI;

// === V60 joint values (TCP source of truth) ===
const POSE_LIB_V60 = {
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

const JOINT_LIMITS = [
  [-3.14159, +3.14159],
  [-2.61799, +2.61799],
  [-2.61799, +2.61799],
  [-3.14159, +3.14159],
  [-2.09440, +2.09440],
  [-3.14159, +3.14159],
];

const COBOT_BASE = [1.152, 1.049, 1.000];

// === V60 forward kinematics — TCP world transform ===
function v60Fk(j) {
  const m = new THREE.Matrix4();
  const t = new THREE.Matrix4();
  m.makeTranslation(COBOT_BASE[0], COBOT_BASE[1], COBOT_BASE[2]);
  m.multiply(t.makeRotationX(PI / 2));                                 // wrapper
  m.multiply(t.makeTranslation(0.1623, 0.0867, 0.0645));                // joint_1 origin
  m.multiply(t.makeRotationY(j[0]));                                    // joint_1 axis Y
  m.multiply(t.makeTranslation(-0.0115, 0.0639, 0));                    // joint_2 origin
  m.multiply(t.makeRotationZ(0.05 + j[1]));                             // rpy(0,0,0.05) + joint_2 axis Z
  m.multiply(t.makeTranslation(-0.0015, 0.2450, 0.2258));               // joint_3 origin (V60: from link2)
  m.multiply(t.makeRotationZ(j[2]));                                    // joint_3 axis Z
  m.multiply(t.makeTranslation(-0.0060, 0.2295, 0.1244));               // joint_4 origin
  m.multiply(t.makeRotationZ(j[3]));                                    // joint_4 axis Z
  m.multiply(t.makeTranslation(-0.0010, 0.0465, -0.2300));              // joint_5 origin
  m.multiply(t.makeRotationY(j[4]));                                    // joint_5 axis Y
  m.multiply(t.makeTranslation(-0.0040, 0.0720, 0.0898));               // joint_6 origin
  m.multiply(t.makeRotationZ(j[5]));                                    // joint_6 axis Z
  m.multiply(t.makeTranslation(0, 0.068, 0));                           // joint_tool0
  m.multiply(t.makeTranslation(0, -0.07, 0.015));                       // tool0 → gripper_base
  m.multiply(t.makeTranslation(0.000250, 0.060250, 0.076750));          // tcp_link
  return m;
}

// === V26 forward kinematics — same chain except joint_3 hangs from a
// fixed link rotated Ry(π) ===
function v26Fk(j) {
  const m = new THREE.Matrix4();
  const t = new THREE.Matrix4();
  m.makeTranslation(COBOT_BASE[0], COBOT_BASE[1], COBOT_BASE[2]);
  m.multiply(t.makeRotationX(PI / 2));
  m.multiply(t.makeTranslation(0.1623, 0.0867, 0.0645));
  m.multiply(t.makeRotationY(j[0]));
  m.multiply(t.makeTranslation(-0.0115, 0.0639, 0));
  m.multiply(t.makeRotationZ(0.05 + j[1]));
  // V26 only: extracted link_elbow_connector with Ry(π) flip
  m.multiply(t.makeTranslation(0.001060, 0.243625, 0.119967));
  m.multiply(t.makeRotationY(PI));
  // joint_3 in V26 hangs from link_elbow_connector
  m.multiply(t.makeTranslation(0.002560, 0.001375, 0.113592));
  m.multiply(t.makeRotationZ(j[2]));
  m.multiply(t.makeTranslation(-0.0060, 0.2295, 0.1244));
  m.multiply(t.makeRotationZ(j[3]));
  m.multiply(t.makeTranslation(-0.0010, 0.0465, -0.2300));
  m.multiply(t.makeRotationY(j[4]));
  m.multiply(t.makeTranslation(-0.0040, 0.0720, 0.0898));
  m.multiply(t.makeRotationZ(j[5]));
  m.multiply(t.makeTranslation(0, 0.068, 0));
  m.multiply(t.makeTranslation(0, -0.07, 0.015));
  m.multiply(t.makeTranslation(0.000250, 0.060250, 0.076750));
  return m;
}

function decompose(m) {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  m.decompose(pos, quat, scale);
  return { pos, quat };
}

function quatToAxisAngleVec(q) {
  let qw = q.w, qx = q.x, qy = q.y, qz = q.z;
  if (qw < 0) { qw = -qw; qx = -qx; qy = -qy; qz = -qz; }
  const xyzLen = Math.sqrt(qx * qx + qy * qy + qz * qz);
  if (xyzLen < 1e-12) return new THREE.Vector3(0, 0, 0);
  const angle = 2 * Math.atan2(xyzLen, qw);
  const k = angle / xyzLen;
  return new THREE.Vector3(qx * k, qy * k, qz * k);
}

// === IK solver (6D pose, DLS, random restart) ===
const EPS = 1e-4;
const LAMBDA = 0.05;
const STEP_CLAMP = 0.3;
const MAX_ITER = 400;
const TOL_POS = 0.0005;     // 0.5 mm — tighter than the browser for offline solve
const TOL_ROT = 0.003;      // ~0.17°
const ACCEPT_POS = 0.003;   // 3 mm — clean accept
const ACCEPT_ROT = 0.015;   // ~0.86°
const MAX_ATTEMPTS = 80;
const PERTURB_MAX = 2.2;

function v26TcpPose(j) { return decompose(v26Fk(j)); }

function jacobian(j) {
  const J = [[0,0,0,0,0,0], [0,0,0,0,0,0], [0,0,0,0,0,0],
             [0,0,0,0,0,0], [0,0,0,0,0,0], [0,0,0,0,0,0]];
  for (let i = 0; i < 6; i++) {
    const orig = j[i];
    j[i] = orig + EPS;
    const p = v26TcpPose(j);
    j[i] = orig - EPS;
    const n = v26TcpPose(j);
    j[i] = orig;
    const inv2 = 1 / (2 * EPS);
    J[0][i] = (p.pos.x - n.pos.x) * inv2;
    J[1][i] = (p.pos.y - n.pos.y) * inv2;
    J[2][i] = (p.pos.z - n.pos.z) * inv2;
    const qD = p.quat.clone().multiply(n.quat.clone().invert());
    const aa = quatToAxisAngleVec(qD);
    J[3][i] = aa.x * inv2;
    J[4][i] = aa.y * inv2;
    J[5][i] = aa.z * inv2;
  }
  return J;
}

function invertNxN(m, n) {
  const a = [];
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
    if (pivot !== col) { const tmp = a[col]; a[col] = a[pivot]; a[pivot] = tmp; }
    const inv = 1 / a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] *= inv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map(row => row.slice(n));
}

function dls6Update(J, err) {
  const JJT = [[0,0,0,0,0,0], [0,0,0,0,0,0], [0,0,0,0,0,0],
               [0,0,0,0,0,0], [0,0,0,0,0,0], [0,0,0,0,0,0]];
  for (let i = 0; i < 6; i++) {
    for (let jj = 0; jj < 6; jj++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += J[i][k] * J[jj][k];
      JJT[i][jj] = s + (i === jj ? LAMBDA * LAMBDA : 0);
    }
  }
  const inv = invertNxN(JJT, 6);
  if (!inv) return [0,0,0,0,0,0];
  const tmp = [0,0,0,0,0,0];
  for (let i = 0; i < 6; i++) {
    let s = 0;
    for (let jj = 0; jj < 6; jj++) s += inv[i][jj] * err[jj];
    tmp[i] = s;
  }
  const delta = [0,0,0,0,0,0];
  for (let i = 0; i < 6; i++) {
    let s = 0;
    for (let jj = 0; jj < 6; jj++) s += J[jj][i] * tmp[jj];
    delta[i] = s;
  }
  return delta;
}

function solveOnce(targetPos, targetQuat, initial) {
  const j = [...initial];
  let posErr = Infinity, rotErr = Infinity, iter = 0;
  for (iter = 0; iter < MAX_ITER; iter++) {
    const { pos, quat } = v26TcpPose(j);
    const ex = targetPos.x - pos.x;
    const ey = targetPos.y - pos.y;
    const ez = targetPos.z - pos.z;
    posErr = Math.sqrt(ex*ex + ey*ey + ez*ez);
    const qD = targetQuat.clone().multiply(quat.clone().invert());
    const aa = quatToAxisAngleVec(qD);
    rotErr = aa.length();
    if (posErr < TOL_POS && rotErr < TOL_ROT) break;
    const err = [ex, ey, ez, aa.x, aa.y, aa.z];
    const J = jacobian(j);
    const delta = dls6Update(J, err);
    let n = 0;
    for (let i = 0; i < 6; i++) n += delta[i] * delta[i];
    n = Math.sqrt(n);
    if (n > STEP_CLAMP) {
      const s = STEP_CLAMP / n;
      for (let i = 0; i < 6; i++) delta[i] *= s;
    }
    for (let i = 0; i < 6; i++) {
      const [lo, hi] = JOINT_LIMITS[i];
      j[i] = Math.max(lo, Math.min(hi, j[i] + delta[i]));
    }
  }
  return { j, posErr, rotErr, iter, converged: posErr < TOL_POS && rotErr < TOL_ROT };
}

function isBetter(a, b) {
  if (!b) return true;
  const ea = a.posErr + a.rotErr * 0.1;
  const eb = b.posErr + b.rotErr * 0.1;
  return ea < eb;
}

function solve(targetPos, targetQuat, initial) {
  let best = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let seed;
    if (attempt === 1) {
      seed = [...initial];
    } else {
      const p = PERTURB_MAX * (attempt / MAX_ATTEMPTS);
      seed = initial.map((v, i) => {
        const [lo, hi] = JOINT_LIMITS[i];
        return Math.max(lo, Math.min(hi, v + (Math.random() - 0.5) * 2 * p));
      });
    }
    const r = solveOnce(targetPos, targetQuat, seed);
    if (r.converged) return { ...r, attempts: attempt };
    if (r.posErr < ACCEPT_POS && r.rotErr < ACCEPT_ROT) return { ...r, attempts: attempt };
    if (isBetter(r, best)) best = { ...r, attempts: attempt };
  }
  return best;
}

// === Solve order (V53 trajectory order) so each pose seeds the next ===
// This keeps the solver inside the same IK branch through the cycle —
// otherwise adjacent poses can land in different branches and the
// trajectory between them is a huge unintentional joint swing.
const SOLVE_ORDER = [
  'POSE_HOME',
  'POSE_APPROACH_CONVEYOR',
  'POSE_PICK_CONVEYOR',
  'POSE_LIFT_CONVEYOR',
  'POSE_APPROACH_LOAD_FIXTURE',
  'POSE_PLACE_LOAD_FIXTURE',
  'POSE_RELEASE_LOAD_FIXTURE',
  'POSE_RETREAT_LOAD_FIXTURE',
  'POSE_APPROACH_PICK_RIVETED',
  'POSE_PICK_RIVETED',
  'POSE_LIFT_RIVETED',
  'POSE_APPROACH_VISION',
  'POSE_PLACE_VISION',
  'POSE_RELEASE_VISION',
  'POSE_RETREAT_VISION',
  'POSE_APPROACH_ACCEPT_BIN',
  'POSE_DROP_ACCEPT_BIN',
  'POSE_APPROACH_REJECT_BIN',
  'POSE_DROP_REJECT_BIN',
];

function jointVecKey(j) {
  return j.map(x => x.toFixed(6)).join(',');
}

// === Main ===
console.log(`// === V26 POSE_LIB (re-IK'd from V60 TCP targets, chain-seeded) ===`);
console.log(`// Generated by scripts/regen-v26-poses.mjs.  Do NOT edit by hand.`);
console.log(`const POSE_LIB_V26: Record<string, [number, number, number, number, number, number]> = {`);

const v26Results = {};
const v60Dedup = {};          // V60 joint-vec key → V26 solution (already solved)
let prevV26 = null;            // previous V26 solution, used as seed
const warnings = [];

function jointDistance(a, b) {
  let d = 0;
  for (let i = 0; i < 6; i++) {
    const x = b[i] - a[i];
    d += x * x;
  }
  return Math.sqrt(d);
}

// Try several seed strategies for the same target and pick the BEST result.
// Best = (converged ∧ closest to chain seed) over (just converged) over
// (least residual error).  Chain continuity beats raw tolerance once we
// have any clean solution.
function solveMulti(target, jointsV60, prevSeed) {
  const seeds = [];
  if (prevSeed) seeds.push({ s: [...prevSeed], label: 'chain' });
  const sFlipped = [...jointsV60];
  sFlipped[2] = -sFlipped[2];
  seeds.push({ s: sFlipped, label: 'v60-j3flip' });
  // Also try the raw V60 joints (sometimes the j3 flip is wrong sign for
  // the local branch the previous IK landed in).
  seeds.push({ s: [...jointsV60], label: 'v60-raw' });

  const candidates = [];
  for (const { s, label } of seeds) {
    const r = solve(target.pos, target.quat, s);
    candidates.push({ ...r, seedLabel: label });
  }

  // Rank: first by convergence (clean wins), then by distance to chain seed
  // (continuity), then by error.
  candidates.sort((a, b) => {
    const aClean = a.posErr < ACCEPT_POS && a.rotErr < ACCEPT_ROT ? 0 : 1;
    const bClean = b.posErr < ACCEPT_POS && b.rotErr < ACCEPT_ROT ? 0 : 1;
    if (aClean !== bClean) return aClean - bClean;
    if (prevSeed) {
      const da = jointDistance(a.j, prevSeed);
      const db = jointDistance(b.j, prevSeed);
      if (Math.abs(da - db) > 0.05) return da - db;
    }
    const ea = a.posErr + a.rotErr * 0.1;
    const eb = b.posErr + b.rotErr * 0.1;
    return ea - eb;
  });

  return candidates[0];
}

for (const name of SOLVE_ORDER) {
  const jointsV60 = POSE_LIB_V60[name];
  const v60Key = jointVecKey(jointsV60);

  // Dedup
  if (v60Dedup[v60Key]) {
    const reused = v60Dedup[v60Key];
    v26Results[name] = reused;
    prevV26 = reused;
    continue;
  }

  const target = decompose(v60Fk(jointsV60));
  const r = solveMulti(target, jointsV60, prevV26);
  v26Results[name] = r.j;
  v60Dedup[v60Key] = r.j;
  prevV26 = r.j;

  if (r.posErr > ACCEPT_POS || r.rotErr > ACCEPT_ROT) {
    warnings.push(`${name.padEnd(28)} posErr=${(r.posErr*1000).toFixed(2)}mm rotErr=${(r.rotErr*180/PI).toFixed(2)}° seed=${r.seedLabel} attempts=${r.attempts}`);
  }
}

// Emit in V60 original order so the snippet matches POSE_LIB_V60 visually.
for (const name of Object.keys(POSE_LIB_V60)) {
  const j = v26Results[name];
  const fmt = j.map(x => (x >= 0 ? '+' : '') + x.toFixed(6)).join(', ');
  const pad = name.padEnd(28);
  console.log(`  ${pad}: [${fmt}],`);
}
console.log(`};`);

if (warnings.length) {
  console.error(`\n// === ${warnings.length} POSE(S) WITH RESIDUAL ERROR ===`);
  for (const w of warnings) console.error('// ' + w);
} else {
  console.error(`\n// All ${Object.keys(POSE_LIB_V60).length} poses converged below ${ACCEPT_POS * 1000} mm / ${(ACCEPT_ROT * 180 / PI).toFixed(2)}°`);
}

// Also dump the maximum joint delta between consecutive poses in the cycle
// — if any > 1 rad we likely flipped branches.
console.error(`\n// === Max joint delta between consecutive cycle poses ===`);
for (let i = 1; i < SOLVE_ORDER.length; i++) {
  const a = v26Results[SOLVE_ORDER[i - 1]];
  const b = v26Results[SOLVE_ORDER[i]];
  let maxDelta = 0, maxJoint = -1;
  for (let k = 0; k < 6; k++) {
    const d = Math.abs(b[k] - a[k]);
    if (d > maxDelta) { maxDelta = d; maxJoint = k; }
  }
  const flag = maxDelta > 1.0 ? ' /* BRANCH SWITCH? */' : '';
  console.error(`// ${SOLVE_ORDER[i - 1].padEnd(28)} → ${SOLVE_ORDER[i].padEnd(28)} max Δj${maxJoint + 1}=${maxDelta.toFixed(3)} rad${flag}`);
}

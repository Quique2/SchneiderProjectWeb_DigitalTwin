// Subsystem ticks — port of the various ROS sim nodes into pure tick functions
// that mutate SimState in place. Called from useSimulation each frame.

import {
  BELT_SPEED, BELT_Y, BELT_TOP_Z, SPAWN_X, PICK_X, PICK_TOL_X,
  MIN_SEPARATION, RIVET_DURATION_S, INSPECT_DURATION_S, PASS_PROBABILITY,
  DISC_INDEX_DURATION_S, GRIPPER_OPEN_M, GRIPPER_CLOSE_M, GRIPPER_TRAVEL_S,
  LOAD_X, LOAD_Y, RIVET_X, RIVET_Y, CAFI_REST_Z, VISION_X, VISION_Y, VISION_TOP_Z,
  ACCEPT_X, ACCEPT_Y, REJECT_X, REJECT_Y, BIN_FLOOR_Z, CAFI_LZ,
  COBOT_X, COBOT_Y, COBOT_BASE_Z, COBOT_REACH,
} from './constants';
import {
  POSE_LIB, JOINT_VEL_MAX, SEG_DURATION_MIN, SEG_DURATION_MAX,
  GRIPPER_WAIT_S, J_LIMIT_LOW, J_LIMIT_HIGH,
  type JointAngles6,
} from './poses';
import type { SimState, CAFI, FixtureId } from './types';
import { inGripperCafi } from './store';

// =============================================================================
// CONVEYOR SIM — V51 schneider_conveyor_sim
// =============================================================================
export function conveyorTick(s: SimState, dt: number): void {
  // The belt is on only when cell is RUNNING and not paused/fault, and we
  // are NOT in PICK_CONV stage with a CAFI in tight window (belt stops to
  // let the cobot grab it). Belt also off when stopped.
  const wasRunning = s.fsm.cell === 'RUNNING';
  let beltOn = wasRunning && !s.hmi.stopped;

  // Stop the belt when a CAFI is already in the tight pick window and the
  // FSM is requesting the pick (so it doesn't slide while being grabbed).
  if (s.conveyor.part_ready_for_pick) beltOn = false;
  s.conveyor.motor_on = beltOn;

  // Move CAFIs along the belt (west = -X direction).
  if (beltOn) {
    for (const c of s.cafis) {
      if (c.location !== 'on_conveyor') continue;
      c.position[0] -= BELT_SPEED * dt;
      if (c.position[0] < PICK_X) c.position[0] = PICK_X;  // hard stop at pick
    }
  }

  // Update DI1 (part present at pick area, wide tolerance) and the V27 tight
  // pick-ready flag.
  let any_present = false;
  let any_ready = false;
  for (const c of s.cafis) {
    if (c.location !== 'on_conveyor') continue;
    if (Math.abs(c.position[0] - PICK_X) <= 0.110) any_present = true;
    if (Math.abs(c.position[0] - PICK_X) <= PICK_TOL_X) any_ready = true;
  }
  s.conveyor.part_present_pick = any_present;
  s.conveyor.part_ready_for_pick = any_ready;
  s.cafis.forEach((c) => {
    c.at_sensor = c.location === 'on_conveyor'
      && Math.abs(c.position[0] - PICK_X) <= PICK_TOL_X;
    c.ready_for_pick = c.at_sensor;
  });

  // Spawn allowed: only when cell is RUNNING, not stopped, and there is no
  // CAFI within MIN_SEPARATION of the next would-be CAFI at SPAWN_X.
  let spawn_ok = s.fsm.cell === 'RUNNING' && !s.hmi.stopped;
  for (const c of s.cafis) {
    if (c.location !== 'on_conveyor') continue;
    if (Math.abs(c.position[0] - SPAWN_X) < MIN_SEPARATION) {
      spawn_ok = false; break;
    }
  }
  // Allow spawn while IDLE too (so the first button press kicks things off).
  if (s.fsm.cell === 'IDLE') spawn_ok = true;
  s.conveyor.spawn_allowed = spawn_ok;

  // Accumulation FAULT
  for (let i = 0; i < s.cafis.length; i++) {
    if (s.cafis[i].location !== 'on_conveyor') continue;
    for (let j = i + 1; j < s.cafis.length; j++) {
      if (s.cafis[j].location !== 'on_conveyor') continue;
      const dx = Math.abs(s.cafis[i].position[0] - s.cafis[j].position[0]);
      if (dx < MIN_SEPARATION) {
        if (s.fsm.cell !== 'FAULT') {
          s.fsm.fault_reason = 'conveyor accumulation';
          s.fsm.cell = 'FAULT';
          s.fsm.stage = 'STOPPED';
          s.fsm.stage_t0 = s.sim_t;
        }
      }
    }
  }
}

// =============================================================================
// ROBOT CONTROLLER — port of robot_controller_node.py
// =============================================================================
function cosineInterp(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return 0.5 * (1.0 - Math.cos(Math.PI * c));
}

function clampJoints(q: number[]): JointAngles6 {
  return q.map((v, i) =>
    Math.max(J_LIMIT_LOW[i], Math.min(J_LIMIT_HIGH[i], v))
  ) as JointAngles6;
}

function shortestPath(qCur: JointAngles6, qTgt: JointAngles6): JointAngles6 {
  const out: number[] = [];
  for (let i = 0; i < 6; i++) {
    const cur = qCur[i], lo = J_LIMIT_LOW[i], hi = J_LIMIT_HIGH[i];
    let best = qTgt[i], bestD = Math.abs(qTgt[i] - cur);
    for (const k of [-1, +1]) {
      const cand = qTgt[i] + k * 2 * Math.PI;
      if (cand >= lo && cand <= hi) {
        const d = Math.abs(cand - cur);
        if (d < bestD) { best = cand; bestD = d; }
      }
    }
    out.push(Math.max(lo, Math.min(hi, best)));
  }
  return out as JointAngles6;
}

function segDuration(qFrom: JointAngles6, qTo: JointAngles6): number {
  let maxDelta = 0;
  for (let i = 0; i < 6; i++) maxDelta = Math.max(maxDelta, Math.abs(qTo[i] - qFrom[i]));
  const d = maxDelta / JOINT_VEL_MAX;
  return Math.max(SEG_DURATION_MIN, Math.min(SEG_DURATION_MAX, d));
}

function startSegment(s: SimState, poseName: string) {
  const target = POSE_LIB[poseName];
  if (!target) return;
  const q = shortestPath(s.robot.joints, target as JointAngles6);
  s.robot.seg_start_joints = [...s.robot.joints] as JointAngles6;
  s.robot.seg_target_joints = q;
  s.robot.seg_t0 = s.sim_t;
  s.robot.seg_duration = segDuration(s.robot.joints, q);
  s.robot.seg_active = true;
}

function startNextStep(s: SimState): void {
  if (s.robot.traj_queue.length === 0) {
    // Done with trajectory
    s.robot.busy = false;
    s.robot.motion_done = true;
    s.robot.seg_active = false;
    return;
  }
  const step = s.robot.traj_queue.shift()!;
  if (step === 'GRIPPER_CLOSE_AND_WAIT') {
    s.gripper.state = 'CLOSING';
    s.gripper.cmd_t0 = s.sim_t;
    s.gripper.release_done = false;
    s.gripper.grasp_confirmed = false;
    s.robot.waiting_for = 'grasp';
    s.robot.wait_t0 = s.sim_t;
    s.robot.seg_active = false;
  } else if (step === 'GRIPPER_OPEN_AND_WAIT') {
    s.gripper.state = 'OPENING';
    s.gripper.cmd_t0 = s.sim_t;
    s.gripper.grasp_confirmed = false;
    s.gripper.release_done = false;
    s.robot.waiting_for = 'release';
    s.robot.wait_t0 = s.sim_t;
    s.robot.seg_active = false;
  } else {
    startSegment(s, step);
  }
}

export function robotTick(s: SimState): void {
  // Boot first segment if queue has work but no segment yet.
  if (s.robot.busy && !s.robot.seg_active && s.robot.waiting_for === null) {
    startNextStep(s);
  }

  // Active motion segment — interpolate.
  if (s.robot.seg_active) {
    const t = (s.sim_t - s.robot.seg_t0) / s.robot.seg_duration;
    const u = cosineInterp(t);
    const newJ: number[] = [];
    for (let i = 0; i < 6; i++) {
      newJ.push(s.robot.seg_start_joints[i] + u * (s.robot.seg_target_joints[i] - s.robot.seg_start_joints[i]));
    }
    s.robot.joints = clampJoints(newJ);
    if (t >= 1) {
      s.robot.joints = clampJoints(s.robot.seg_target_joints);
      s.robot.seg_active = false;
      startNextStep(s);
    }
  }

  // Waiting for grasp/release
  if (s.robot.waiting_for === 'grasp') {
    if (s.gripper.grasp_confirmed) {
      s.robot.waiting_for = null;
      startNextStep(s);
    } else if (s.sim_t - s.robot.wait_t0 > GRIPPER_WAIT_S) {
      // Treat as done (don't FAULT here — FSM watchdog will catch).
      s.robot.waiting_for = null;
      startNextStep(s);
    }
  } else if (s.robot.waiting_for === 'release') {
    if (s.gripper.release_done) {
      s.robot.waiting_for = null;
      startNextStep(s);
    } else if (s.sim_t - s.robot.wait_t0 > GRIPPER_WAIT_S) {
      s.robot.waiting_for = null;
      startNextStep(s);
    }
  }
}

// =============================================================================
// GRIPPER SIM
// =============================================================================
export function gripperTick(s: SimState): void {
  const elapsed = s.sim_t - s.gripper.cmd_t0;
  const t = Math.min(1, elapsed / GRIPPER_TRAVEL_S);
  if (s.gripper.state === 'CLOSING') {
    s.gripper.jaw = GRIPPER_OPEN_M + (GRIPPER_CLOSE_M - GRIPPER_OPEN_M) * t;
    if (t >= 1) {
      s.gripper.state = 'CLOSED';
      // Grasp confirmed if a CAFI is near tool0
      const grabbed = checkCafiInGrasp(s);
      if (grabbed) {
        grabbed.location = 'in_gripper';
        s.gripper.grasp_confirmed = true;
      }
    }
  } else if (s.gripper.state === 'OPENING') {
    s.gripper.jaw = GRIPPER_CLOSE_M + (GRIPPER_OPEN_M - GRIPPER_CLOSE_M) * t;
    if (t >= 1) {
      s.gripper.state = 'OPEN';
      // Release: detach any CAFI currently in_gripper and place it where the
      // gripper currently is (the FSM/object_manager will snap it).
      const c = inGripperCafi(s);
      if (c) releaseCafi(s, c);
      s.gripper.release_done = true;
    }
  }
}

// Decide which CAFI (if any) is in the gripper's grasp volume given the
// current robot pose + cycle stage.
function checkCafiInGrasp(s: SimState): CAFI | null {
  // Heuristic: rely on the stage context — the FSM only issues a CLOSE
  // when it expects to grab a specific CAFI.
  const stage = s.fsm.stage;
  if (stage === 'PICK_CONV') {
    // Grab the CAFI that is at the conveyor pick window.
    for (const c of s.cafis) {
      if (c.location === 'on_conveyor' && c.ready_for_pick) return c;
    }
  } else if (stage === 'PICK_RIVETED') {
    const outerId = s.rotary.outer;
    for (const c of s.cafis) {
      if (c.location === ('in_fixture_' + outerId) as CAFI['location']
        && c.fixture_id === outerId && c.riveted) return c;
    }
  } else if (stage === 'PICK_VISION') {
    for (const c of s.cafis) if (c.location === 'at_vision') return c;
  }
  return null;
}

// Snap the released CAFI to the appropriate destination based on stage.
function releaseCafi(s: SimState, c: CAFI): void {
  const stage = s.fsm.stage;
  if (stage === 'PLACE_LOAD') {
    const outerId = s.rotary.outer;
    c.location = ('in_fixture_' + outerId) as CAFI['location'];
    c.fixture_id = outerId;
    c.position = [LOAD_X, LOAD_Y, CAFI_REST_Z];
    c.yaw = 0;
  } else if (stage === 'PLACE_VISION') {
    c.location = 'at_vision';
    c.position = [VISION_X, VISION_Y, VISION_TOP_Z + CAFI_LZ / 2];
    c.yaw = 0;
  } else if (stage === 'PLACE_BIN') {
    if (c.verdict === 'PASS') {
      c.location = 'in_bin_accept';
      c.position = [ACCEPT_X, ACCEPT_Y, BIN_FLOOR_Z + CAFI_LZ / 2];
    } else {
      c.location = 'in_bin_reject';
      c.position = [REJECT_X, REJECT_Y, BIN_FLOOR_Z + CAFI_LZ / 2];
    }
  }
}

// =============================================================================
// ROTARY FIXTURE SIM
// =============================================================================
export function rotaryTick(s: SimState): void {
  // Indexing animation
  if (s.rotary.state === 'INDEXING') {
    const t = Math.min(1, (s.sim_t - s.rotary.index_t0) / DISC_INDEX_DURATION_S);
    const u = 0.5 * (1.0 - Math.cos(Math.PI * t));    // cosine ease
    s.rotary.angle = s.rotary.index_start_angle
      + u * (s.rotary.index_target_angle - s.rotary.index_start_angle);
    if (t >= 1) {
      s.rotary.angle = s.rotary.index_target_angle;
      s.rotary.state = 'IDLE';
      s.rotary.index_done_flag = true;
      // Swap outer/inner mapping AND move CAFIs to their new station.
      swapStations(s);
    }
  }

  // Rivet timer (runs in parallel with whatever else is happening).
  if (s.rotary.rivet_active) {
    if (s.sim_t - s.rotary.rivet_t0 >= RIVET_DURATION_S) {
      s.rotary.rivet_active = false;
      s.rotary.rivet_done_flag = true;
      // Mark inner CAFI as riveted.
      const innerId = s.rotary.inner;
      for (const c of s.cafis) {
        if (c.location === ('in_fixture_' + innerId) as CAFI['location']
          && c.fixture_id === innerId) {
          c.riveted = true;
          break;
        }
      }
    }
  }
}

function swapStations(s: SimState): void {
  const oldOuter = s.rotary.outer;
  s.rotary.outer = s.rotary.inner;
  s.rotary.inner = oldOuter;
  // Reposition CAFIs to follow their fixture
  for (const c of s.cafis) {
    if (c.fixture_id === s.rotary.outer) {
      c.location = ('in_fixture_' + s.rotary.outer) as CAFI['location'];
      c.position = [LOAD_X, LOAD_Y, CAFI_REST_Z];
    } else if (c.fixture_id === s.rotary.inner) {
      c.location = ('in_fixture_' + s.rotary.inner) as CAFI['location'];
      c.position = [RIVET_X, RIVET_Y, CAFI_REST_Z];
    }
  }
}

// =============================================================================
// VISION SIM
// =============================================================================
export function visionTick(s: SimState): void {
  // Update presence based on CAFIs at vision station
  let presence = false;
  for (const c of s.cafis) {
    if (c.location === 'at_vision') { presence = true; break; }
  }
  s.vision.presence = presence;

  // If camera is active, after INSPECT_DURATION_S produce a verdict.
  if (s.vision.camera_active) {
    if (s.sim_t - s.vision.camera_trigger_t0 >= INSPECT_DURATION_S) {
      const verdict = Math.random() < PASS_PROBABILITY ? 'PASS' : 'FAIL';
      s.vision.last_result = verdict;
      s.vision.camera_active = false;
      // Tag the CAFI at vision with the verdict
      for (const c of s.cafis) {
        if (c.location === 'at_vision') c.verdict = verdict;
      }
    }
  }
}

// =============================================================================
// OBJECT MANAGER — position CAFI while in_gripper
//
// The cobot's FK has a small consistent offset (URDF axes are Z-up vs
// Three.js Y-up). Rather than chase that, we snap the in_gripper CAFI to
// the EXPECTED stage target position, interpolating smoothly from the
// previous source. The user never sees the cobot's gripper FK error.
// =============================================================================
function stageTargetForCafi(s: SimState, c: CAFI): [number, number, number] | null {
  const stage = s.fsm.stage;
  // PICK_CONV — the gripper is closing on a CAFI sitting at the conveyor pick
  if (stage === 'PICK_CONV') return [PICK_X, BELT_Y, BELT_TOP_Z + CAFI_LZ / 2 + 0.030];
  // PLACE_LOAD / SEAT — heading to LOAD fixture; final CAFI position
  if (stage === 'PLACE_LOAD' || stage === 'SEAT') return [LOAD_X, LOAD_Y, CAFI_REST_Z];
  // PICK_RIVETED — lifting the riveted CAFI from LOAD
  if (stage === 'PICK_RIVETED') return [LOAD_X, LOAD_Y, CAFI_REST_Z + 0.080];
  // PLACE_VISION / INSPECT — heading to vision station
  if (stage === 'PLACE_VISION' || stage === 'INSPECT') return [VISION_X, VISION_Y, VISION_TOP_Z + CAFI_LZ / 2];
  // PICK_VISION — lifting from vision
  if (stage === 'PICK_VISION') return [VISION_X, VISION_Y, VISION_TOP_Z + CAFI_LZ / 2 + 0.080];
  // PLACE_BIN — drop to accept or reject bin
  if (stage === 'PLACE_BIN') {
    if (c.verdict === 'PASS') return [ACCEPT_X, ACCEPT_Y, BIN_FLOOR_Z + 0.100];
    return [REJECT_X, REJECT_Y, BIN_FLOOR_Z + 0.100];
  }
  return null;
}

// Smoothly interpolate position from the CAFI's current spot to the target
// (5 m/s, capped). This gives a visible "lift + carry + drop" motion that
// follows the cobot's trajectory even though we don't trust the FK.
function lerpCafiTo(c: CAFI, target: [number, number, number], dt: number): void {
  const SPEED = 1.5; // m/s
  for (let i = 0; i < 3; i++) {
    const d = target[i] - c.position[i];
    const step = Math.sign(d) * Math.min(Math.abs(d), SPEED * dt);
    c.position[i] += step;
  }
}

export function objectManagerTick(s: SimState, _gripperWorldXYZ: [number, number, number], dt = 0.02): void {
  for (const c of s.cafis) {
    if (c.location !== 'in_gripper') continue;
    const target = stageTargetForCafi(s, c);
    if (target) lerpCafiTo(c, target, dt);
  }
}

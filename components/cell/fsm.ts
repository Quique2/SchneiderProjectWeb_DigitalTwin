// Cell FSM — direct port of schneider_state_manager.state_manager_node.py V35.
// Pure function: given current SimState, mutates it in place (one tick).

import type { SimState, CAFI } from './types';
import {
  WD_PICK_S, WD_PLACE_S, WD_SEAT_S, WD_INDEX_S, WD_RIVET_S, WD_INSPECT_S,
  DISC_INDEX_RAD,
} from './constants';
import {
  cafiOnConveyorAtPick, outerCafi, innerCafi, visionCafi, inGripperCafi,
} from './store';

// Robot trajectory dispatcher signals — set on the robot directly.
// (In ROS these were /robot/request_* topics; here we just push trajectories.)
import {
  TRAJ_PICK_CONV, TRAJ_PLACE_OUTER, TRAJ_PICK_RIVETED,
  TRAJ_PLACE_VISION, TRAJ_PICK_VISION,
  TRAJ_PLACE_ACCEPT, TRAJ_PLACE_REJECT, TRAJ_HOME,
} from './poses';
import type { RobotTaskName } from './types';

function enqueueRobot(s: SimState, task: RobotTaskName, steps: string[]) {
  s.robot.current_task = task;
  s.robot.traj_queue = [...steps];
  s.robot.busy = true;
  s.robot.motion_done = false;
  s.gripper.grasp_confirmed = false;
  s.gripper.release_done = false;
  s.robot.seg_active = false;     // force next step start
}

function setStage(s: SimState, stage: SimState['fsm']['stage']) {
  if (s.fsm.stage !== stage) {
    s.fsm.stage = stage;
    s.fsm.stage_t0 = s.sim_t;
    // Clear volatile flags on stage entry
    s.rotary.index_done_flag = false;
    s.rotary.rivet_done_flag = false;
    s.robot.motion_done = false;
  }
}

function enterFault(s: SimState, reason: string) {
  s.fsm.fault_reason = reason;
  s.fsm.cell = 'FAULT';
  setStage(s, 'STOPPED');
}

function stageElapsed(s: SimState): number {
  return s.sim_t - s.fsm.stage_t0;
}

// Dispatch index command — kick off a disc rotation animation.
function startIndex(s: SimState, deltaRad: number) {
  s.rotary.state = 'INDEXING';
  s.rotary.index_start_angle = s.rotary.angle;
  s.rotary.index_target_angle = s.rotary.angle + deltaRad;
  s.rotary.index_t0 = s.sim_t;
  s.rotary.index_done_flag = false;
}

// Dispatch seat command — clamp solenoid on outer fixture.
function seatOuter(s: SimState) {
  if (s.rotary.outer === 'A') s.rotary.solenoid_left_outer = true;
  // (visualization only — confirmation comes from the CAFI being present)
}
function unseatOuter(s: SimState) {
  s.rotary.solenoid_left_outer = false;
}

// Dispatch rivet command — start 30 s rivet timer on the inner fixture.
function startRivet(s: SimState) {
  s.rotary.rivet_active = true;
  s.rotary.rivet_t0 = s.sim_t;
  s.rotary.rivet_done_flag = false;
}

// Dispatch camera trigger.
function triggerCamera(s: SimState) {
  s.vision.camera_trigger_t0 = s.sim_t;
  s.vision.camera_active = true;
}

// =============================================================================
// FSM TICK — exact mirror of state_manager_node.py V35 .tick()
// =============================================================================
export function fsmTick(s: SimState): void {
  if (s.fsm.cell !== 'RUNNING') return;

  const stage = s.fsm.stage;
  const outer = outerCafi(s);
  const inner = innerCafi(s);
  const at_vis = visionCafi(s);

  // ─── IDLE: dispatcher por prioridad ──────────────────────────────────────
  if (stage === 'IDLE') {
    const outer_unrivet = outer && !outer.riveted;
    const outer_rivet   = outer && outer.riveted;
    const inner_unrivet = inner && !inner.riveted;
    const inner_rivet   = inner && inner.riveted;
    const conv = cafiOnConveyorAtPick(s);

    // P1 — CAFI en vision con verdict -> PICK_VISION
    if (at_vis && (at_vis.verdict === 'PASS' || at_vis.verdict === 'FAIL')) {
      setStage(s, 'PICK_VISION');
      enqueueRobot(s, 'pick_vision', TRAJ_PICK_VISION);
      return;
    }
    // P2 — outer riveted -> PICK_RIVETED -> VISION
    if (outer_rivet) {
      setStage(s, 'PICK_RIVETED');
      enqueueRobot(s, 'pick_riveted', TRAJ_PICK_RIVETED);
      return;
    }
    // P3 — inner riveted + outer vacio -> INDEX_BACK
    if (inner_rivet && !outer) {
      setStage(s, 'INDEX_DISC_BACK');
      startIndex(s, -DISC_INDEX_RAD);
      return;
    }
    // P4 — inner riveted + outer unriveted -> INDEX swap +180
    if (inner_rivet && outer_unrivet) {
      setStage(s, 'INDEX_DISC');
      startIndex(s, +DISC_INDEX_RAD);
      return;
    }
    // P5 — outer unriveted + inner vacio -> INDEX +180 + rivet
    if (outer_unrivet && !inner) {
      setStage(s, 'INDEX_DISC');
      startIndex(s, +DISC_INDEX_RAD);
      return;
    }
    // P6 — outer empty + CAFI on conveyor ready -> PICK_CONV
    if (conv && !outer) {
      setStage(s, 'PICK_CONV');
      enqueueRobot(s, 'pick_conv', TRAJ_PICK_CONV);
      return;
    }
    // Sin trabajo -> RETURN_HOME
    if (s.robot.current_task !== 'idle' && s.robot.current_task !== 'home') {
      setStage(s, 'RETURN_HOME');
      enqueueRobot(s, 'home', TRAJ_HOME);
      return;
    }
    return;
  }

  // ─── PICK_CONV ───────────────────────────────────────────────────────────
  if (stage === 'PICK_CONV') {
    if (stageElapsed(s) > WD_PICK_S) { enterFault(s, 'watchdog PICK_CONV'); return; }
    if (s.robot.motion_done && s.gripper.grasp_confirmed) {
      setStage(s, 'PLACE_LOAD');
      enqueueRobot(s, 'place_outer', TRAJ_PLACE_OUTER);
    }
    return;
  }

  // ─── PLACE_LOAD ──────────────────────────────────────────────────────────
  if (stage === 'PLACE_LOAD') {
    if (stageElapsed(s) > WD_PLACE_S) { enterFault(s, 'watchdog PLACE_LOAD'); return; }
    const placed = !!outer;
    if (s.robot.motion_done && !s.gripper.grasp_confirmed && placed) {
      setStage(s, 'SEAT');
      seatOuter(s);
    }
    return;
  }

  // ─── SEAT ────────────────────────────────────────────────────────────────
  if (stage === 'SEAT') {
    if (stageElapsed(s) > WD_SEAT_S) { enterFault(s, 'watchdog SEAT'); return; }
    // Seat is "instant" in our sim — solenoid clamps the CAFI immediately.
    if (stageElapsed(s) > 0.6) {
      unseatOuter(s);
      setStage(s, 'IDLE');
    }
    return;
  }

  // ─── INDEX_DISC ──────────────────────────────────────────────────────────
  if (stage === 'INDEX_DISC') {
    if (stageElapsed(s) > WD_INDEX_S) { enterFault(s, 'watchdog INDEX'); return; }
    if (s.rotary.index_done_flag) {
      startRivet(s);
      setStage(s, 'IDLE');
    }
    return;
  }

  // ─── INDEX_DISC_BACK ─────────────────────────────────────────────────────
  if (stage === 'INDEX_DISC_BACK') {
    if (stageElapsed(s) > WD_INDEX_S) { enterFault(s, 'watchdog INDEX_BACK'); return; }
    if (s.rotary.index_done_flag) {
      setStage(s, 'IDLE');
    }
    return;
  }

  // ─── RIVETING ────────────────────────────────────────────────────────────
  if (stage === 'RIVETING') {
    if (stageElapsed(s) > WD_RIVET_S) { enterFault(s, 'watchdog RIVET'); return; }
    if (s.rotary.rivet_done_flag) {
      setStage(s, 'IDLE');
    }
    return;
  }

  // ─── PICK_RIVETED ────────────────────────────────────────────────────────
  if (stage === 'PICK_RIVETED') {
    if (stageElapsed(s) > WD_PICK_S) { enterFault(s, 'watchdog PICK_RIVETED'); return; }
    if (s.robot.motion_done && s.gripper.grasp_confirmed) {
      setStage(s, 'PLACE_VISION');
      enqueueRobot(s, 'place_vision', TRAJ_PLACE_VISION);
    }
    return;
  }

  // ─── PLACE_VISION ────────────────────────────────────────────────────────
  if (stage === 'PLACE_VISION') {
    if (stageElapsed(s) > WD_PLACE_S) { enterFault(s, 'watchdog PLACE_VISION'); return; }
    const placed_vis = s.vision.presence || !!at_vis;
    if (s.robot.motion_done && !s.gripper.grasp_confirmed && placed_vis) {
      setStage(s, 'INSPECT');
      triggerCamera(s);
    }
    return;
  }

  // ─── INSPECT ─────────────────────────────────────────────────────────────
  if (stage === 'INSPECT') {
    if (stageElapsed(s) > WD_INSPECT_S) { enterFault(s, 'watchdog INSPECT'); return; }
    if (s.vision.last_result === 'PASS' || s.vision.last_result === 'FAIL') {
      setStage(s, 'IDLE');
    }
    return;
  }

  // ─── PICK_VISION ─────────────────────────────────────────────────────────
  if (stage === 'PICK_VISION') {
    if (stageElapsed(s) > WD_PICK_S) { enterFault(s, 'watchdog PICK_VISION'); return; }
    if (s.robot.motion_done && s.gripper.grasp_confirmed) {
      // Look up verdict from the CAFI now in gripper (or fallback to camera result)
      let verdict: CAFI['verdict'] = '';
      const inGrip = inGripperCafi(s);
      if (inGrip && inGrip.verdict) verdict = inGrip.verdict;
      else verdict = s.vision.last_result;

      setStage(s, 'PLACE_BIN');
      if (verdict === 'PASS') {
        enqueueRobot(s, 'place_accept', TRAJ_PLACE_ACCEPT);
      } else {
        enqueueRobot(s, 'place_reject', TRAJ_PLACE_REJECT);
      }
    }
    return;
  }

  // ─── PLACE_BIN ───────────────────────────────────────────────────────────
  if (stage === 'PLACE_BIN') {
    if (stageElapsed(s) > WD_PLACE_S * 2) { enterFault(s, 'watchdog PLACE_BIN'); return; }
    if (s.robot.motion_done && !s.gripper.grasp_confirmed) {
      s.vision.last_result = '';   // reset verdict so dispatcher doesn't loop
      setStage(s, 'IDLE');
    }
    return;
  }

  // ─── RETURN_HOME ─────────────────────────────────────────────────────────
  if (stage === 'RETURN_HOME') {
    if (s.robot.motion_done) {
      setStage(s, 'IDLE');
    }
    return;
  }
}

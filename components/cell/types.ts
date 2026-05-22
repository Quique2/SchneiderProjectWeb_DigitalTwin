// Cell simulation type definitions — mirror schneider_state_manager FSM.

import type { JointAngles6, TrajStep } from './poses';

// ── Cell state (matches /cell/state) ─────────────────────────────────────────
export type CellState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'FAULT';

// ── Cycle stage (matches /cell/cycle_stage) ──────────────────────────────────
export type CycleStage =
  | 'IDLE'
  | 'PICK_CONV'
  | 'PLACE_LOAD'
  | 'SEAT'
  | 'INDEX_DISC'
  | 'RIVETING'
  | 'INDEX_DISC_BACK'
  | 'PICK_RIVETED'
  | 'PLACE_VISION'
  | 'INSPECT'
  | 'PICK_VISION'
  | 'PLACE_BIN'
  | 'RETURN_HOME'
  | 'STOPPED';

// ── CAFI (workpiece) lifecycle ────────────────────────────────────────────────
export type CafiLocation =
  | 'on_conveyor'      // belt is carrying it
  | 'in_gripper'       // attached to cobot tool0
  | 'in_fixture_A'     // on rotary fixture A
  | 'in_fixture_B'     // on rotary fixture B
  | 'at_vision'        // on vision fixture
  | 'in_bin_accept'
  | 'in_bin_reject';

export type CafiVerdict = '' | 'PASS' | 'FAIL';
export type FixtureId = 'A' | 'B';

export interface CAFI {
  id: string;
  location: CafiLocation;
  position: [number, number, number]; // world XYZ in ROS frame (X east, Y north, Z up)
  yaw: number;                         // rotation around world Z
  at_sensor: boolean;                  // is the conveyor sensor seeing it?
  ready_for_pick: boolean;             // tight pick window (±20 mm)
  fixture_id: FixtureId | null;        // which fixture it is mounted on (if any)
  riveted: boolean;
  verdict: CafiVerdict;
}

// ── Robot controller state ────────────────────────────────────────────────────
export type RobotTaskName =
  | 'idle'
  | 'home'
  | 'pick_conv'
  | 'place_outer'
  | 'pick_riveted'
  | 'place_vision'
  | 'pick_vision'
  | 'place_accept'
  | 'place_reject';

export interface RobotState {
  joints: JointAngles6;
  motion_done: boolean;
  busy: boolean;
  current_task: RobotTaskName;
  traj_queue: TrajStep[];
  seg_start_joints: JointAngles6;
  seg_target_joints: JointAngles6;
  seg_t0: number;       // sim time when segment started
  seg_duration: number; // s
  seg_active: boolean;
  waiting_for: null | 'grasp' | 'release';
  wait_t0: number;
}

// ── Gripper ───────────────────────────────────────────────────────────────────
export type GripperState = 'OPEN' | 'CLOSED' | 'CLOSING' | 'OPENING';

export interface GripperSim {
  state: GripperState;
  jaw: number;                 // current jaw aperture in m (0..0.028)
  grasp_confirmed: boolean;
  release_done: boolean;
  cmd_t0: number;              // time the last open/close cmd was issued
}

// ── Rotary fixture ────────────────────────────────────────────────────────────
export type DiscState = 'IDLE' | 'INDEXING';

export interface RotarySim {
  state: DiscState;
  angle: number;               // current disc rotation around Z (rad)
  index_start_angle: number;
  index_target_angle: number;
  index_t0: number;
  index_done_flag: boolean;
  outer: FixtureId;            // which fixture is currently at LOAD (south)
  inner: FixtureId;            // which fixture is currently at RIVET (north)
  solenoid_left_outer: boolean;
  solenoid_left_inner: boolean;
  rivet_active: boolean;
  rivet_t0: number;
  rivet_done_flag: boolean;
}

// ── Conveyor ──────────────────────────────────────────────────────────────────
export interface ConveyorSim {
  motor_on: boolean;            // belt running
  spawn_allowed: boolean;       // CAFI may be spawned at SPAWN_X
  part_present_pick: boolean;   // DI1 — any CAFI inside wide tolerance
  part_ready_for_pick: boolean; // tight ±20 mm window at PICK_X
}

// ── Vision ────────────────────────────────────────────────────────────────────
export interface VisionSim {
  presence: boolean;            // CAFI sitting on vision fixture
  camera_trigger_t0: number;    // time of last trigger (-1 if none)
  camera_active: boolean;       // pulse while inspecting
  last_result: CafiVerdict;
}

// ── HMI input / lamps ─────────────────────────────────────────────────────────
export interface HmiState {
  stopped: boolean;             // STOP/RESUME toggle
  spawn_btn_enabled: boolean;
  collapsed: boolean;           // panel collapsed UI state
}

// ── FSM watchdog tracking ─────────────────────────────────────────────────────
export interface FsmState {
  cell: CellState;
  stage: CycleStage;
  stage_t0: number;             // sim time when entered current stage
  fault_reason: string;
}

// ── Full simulation snapshot ──────────────────────────────────────────────────
export interface SimState {
  sim_t: number;                // simulation time in seconds
  fsm: FsmState;
  robot: RobotState;
  gripper: GripperSim;
  rotary: RotarySim;
  conveyor: ConveyorSim;
  vision: VisionSim;
  hmi: HmiState;
  cafis: CAFI[];
  next_cafi_id: number;
}

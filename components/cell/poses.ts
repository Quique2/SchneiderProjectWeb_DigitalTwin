// Pose library from resolved_poses.py — V51 (Schneider Project Simulation).
// Each pose is 6 joint angles [j1, j2, j3, j4, j5, j6] in radians.
// j1=Y(azimuth), j2=Z(shoulder)+0.05 static yaw, j3=Z(elbow),
// j4=Z(wrist1), j5=Y(wrist2 pitch), j6=Z(tool spin).

export type JointAngles6 = [number, number, number, number, number, number];

export const POSE_LIB: Record<string, JointAngles6> = {
  POSE_HOME:                  [+0.000000, +0.000000, +0.000000, +1.570796, -1.570796, +0.000000],
  POSE_APPROACH_CONVEYOR:     [-1.683778, +1.496127, -1.595100, +1.614122, -1.620474, -1.683917],
  POSE_PICK_CONVEYOR:         [-1.683776, +2.000212, -1.975846, +1.490785, -1.620475, -1.683915],
  POSE_LIFT_CONVEYOR:         [-1.683780, +1.373415, -1.461953, +1.603686, -1.620473, -1.683920],
  POSE_APPROACH_LOAD_FIXTURE: [-0.627113, +1.614539, -1.134426, +0.653542, -0.903494, -1.230410],
  POSE_PLACE_LOAD_FIXTURE:    [-0.414319, +1.266768, -0.228331, +0.528116, -1.590914, -0.413858],
  POSE_RELEASE_LOAD_FIXTURE:  [-0.415856, +1.157750, -0.083948, +0.491674, -1.590800, -0.415362],
  POSE_RETREAT_LOAD_FIXTURE:  [-0.415216, +1.039639, -0.153599, +0.461583, -1.589277, -0.415743],
  POSE_APPROACH_PICK_RIVETED: [-0.414473, +1.041802, -0.157701, +0.462859, -1.591709, -0.416576],
  POSE_PICK_RIVETED:          [-0.414319, +1.266766, -0.228329, +0.528115, -1.590914, -0.413858],
  POSE_LIFT_RIVETED:          [-0.414418, +1.083893, -0.326813, +0.493951, -1.591213, -0.414648],
  POSE_APPROACH_VISION:       [+0.110638, +1.121293, -0.023231, +0.470580, -1.565045, +0.110383],
  POSE_PLACE_VISION:          [+0.113212, +1.676994, -0.659509, +0.552976, -1.565147, +0.113070],
  POSE_RELEASE_VISION:        [+0.113215, +1.582386, -0.589477, +0.577552, -1.565147, +0.113073],
  POSE_RETREAT_VISION:        [+0.110636, +1.125023, -0.030940, +0.474562, -1.565045, +0.110381],
  POSE_APPROACH_ACCEPT_BIN:   [+2.209657, +1.753535, -1.620040, +1.357474, -1.530664, +2.210256],
  POSE_DROP_ACCEPT_BIN:       [+2.209750, +0.480417, +1.809828, -0.799259, -1.530674, +2.210355],
  POSE_APPROACH_REJECT_BIN:   [+1.225784, -0.442571, +2.178226, -0.197937, -1.523750, +1.225390],
  POSE_DROP_REJECT_BIN:       [+1.225773, -0.031858, +2.523346, -0.953769, -1.523749, +1.225378],
};

// Trajectories — mix of pose names + gripper commands (from robot_controller_node.py).
export type TrajStep = string; // "POSE_*" or "GRIPPER_CLOSE_AND_WAIT" / "GRIPPER_OPEN_AND_WAIT"

export const TRAJ_PICK_CONV: TrajStep[] = [
  'POSE_APPROACH_CONVEYOR',
  'POSE_PICK_CONVEYOR',
  'GRIPPER_CLOSE_AND_WAIT',
  'POSE_LIFT_CONVEYOR',
];

export const TRAJ_PLACE_OUTER: TrajStep[] = [
  'POSE_APPROACH_LOAD_FIXTURE',
  'POSE_RELEASE_LOAD_FIXTURE',
  'GRIPPER_OPEN_AND_WAIT',
  'POSE_RETREAT_LOAD_FIXTURE',
  'POSE_HOME',
];

export const TRAJ_PICK_RIVETED: TrajStep[] = [
  'POSE_APPROACH_PICK_RIVETED',
  'POSE_PICK_RIVETED',
  'GRIPPER_CLOSE_AND_WAIT',
  'POSE_LIFT_RIVETED',
];

export const TRAJ_PLACE_VISION: TrajStep[] = [
  'POSE_APPROACH_VISION',
  'POSE_RELEASE_VISION',
  'GRIPPER_OPEN_AND_WAIT',
  'POSE_RETREAT_VISION',
  'POSE_HOME',
];

export const TRAJ_PICK_VISION: TrajStep[] = [
  'POSE_APPROACH_VISION',
  'POSE_PLACE_VISION',
  'GRIPPER_CLOSE_AND_WAIT',
  'POSE_RETREAT_VISION',
];

export const TRAJ_PLACE_ACCEPT: TrajStep[] = [
  'POSE_APPROACH_ACCEPT_BIN',
  'POSE_DROP_ACCEPT_BIN',
  'GRIPPER_OPEN_AND_WAIT',
  'POSE_APPROACH_ACCEPT_BIN',
  'POSE_HOME',
];

export const TRAJ_PLACE_REJECT: TrajStep[] = [
  'POSE_APPROACH_REJECT_BIN',
  'POSE_DROP_REJECT_BIN',
  'GRIPPER_OPEN_AND_WAIT',
  'POSE_APPROACH_REJECT_BIN',
  'POSE_HOME',
];

export const TRAJ_HOME: TrajStep[] = ['POSE_HOME'];

// Joint limits from Cobot_URDFBUENO canonical URDF.
export const J_LIMIT_LOW:  JointAngles6 = [-3.14159, -2.61799, -2.61799, -3.14159, -2.09440, -3.14159];
export const J_LIMIT_HIGH: JointAngles6 = [+3.14159, +2.61799, +2.61799, +3.14159, +2.09440, +3.14159];

// Motion timing (from robot_controller_node.py V42).
export const JOINT_VEL_MAX    = 0.9;   // rad/s cap per joint
export const SEG_DURATION_MIN = 1.5;   // s
export const SEG_DURATION_MAX = 6.0;   // s
export const GRIPPER_WAIT_S   = 4.0;   // s
export const HOLD_AT_PICK_S   = 0.4;   // s

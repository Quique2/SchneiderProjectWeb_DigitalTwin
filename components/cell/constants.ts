// V51 cell geometry constants — mirror schneider_cell.urdf.xacro and
// schneider_object_manager (constants section).

// ── Mesa / table ─────────────────────────────────────────────────────────────
export const MESA_TOP_Z = 1.000;

// ── Conveyor ──────────────────────────────────────────────────────────────────
export const BELT_TOP_Z     = 1.070;
export const BELT_Y         = 1.365;
export const SPAWN_X        = 1.620;   // east end
export const PICK_X         = 1.235;   // west pick
export const PICK_TOL_X     = 0.020;   // tight pick window (±20 mm)
export const BELT_SPEED     = 0.10;    // m/s
export const MIN_SEPARATION = 0.250;   // accumulation FAULT below this
export const SPAWN_GUARD_R  = 0.150;   // no spawn if any CAFI inside

// ── Rotary disc ───────────────────────────────────────────────────────────────
export const DISC_CENTER_X = 0.692;
export const DISC_CENTER_Y = 1.259;
export const DISC_TOP_Z    = 1.081;
export const MOUNT_RADIUS  = 0.150;
export const FIXTURE_TOP_Z = 1.111;
export const CAFI_REST_Z   = 1.123;

// LOAD fixture (south, cobot side) / RIVET fixture (north, under cabin)
export const LOAD_X  = DISC_CENTER_X;
export const LOAD_Y  = DISC_CENTER_Y - MOUNT_RADIUS;  // (0.692, 1.109)
export const RIVET_X = DISC_CENTER_X;
export const RIVET_Y = DISC_CENTER_Y + MOUNT_RADIUS;  // (0.692, 1.409)

// ── Vision zone ───────────────────────────────────────────────────────────────
export const VISION_X     = 0.750;
export const VISION_Y     = 0.804;
export const VISION_TOP_Z = 1.015;

// ── Bins ──────────────────────────────────────────────────────────────────────
export const ACCEPT_X = 1.650;
export const ACCEPT_Y = 0.720;
export const REJECT_X = 1.330;
export const REJECT_Y = 0.700;
export const BIN_FLOOR_Z = 1.005;

// ── Cobot ─────────────────────────────────────────────────────────────────────
export const COBOT_X     = 1.152;
export const COBOT_Y     = 1.049;
export const COBOT_BASE_Z = 1.000;
export const COBOT_YAW    = 0.0;
export const COBOT_REACH  = 0.626;     // L03S max reach in m

// ── CAFI ──────────────────────────────────────────────────────────────────────
export const CAFI_LX = 0.123;
export const CAFI_LY = 0.088;
export const CAFI_LZ = 0.025;

// ── Timing (cell_params.yaml + state_manager_node.py V35) ────────────────────
export const RIVET_DURATION_S   = 30.0;
export const INSPECT_DURATION_S = 1.6;
export const PASS_PROBABILITY   = 0.70;

// Watchdogs
export const WD_PICK_S    = 18.0;
export const WD_PLACE_S   = 18.0;
export const WD_SEAT_S    = 6.0;
export const WD_INDEX_S   = 6.0;
export const WD_RIVET_S   = 40.0;
export const WD_INSPECT_S = 6.0;

// Disc indexing
export const DISC_INDEX_RAD = Math.PI;        // 180°
export const DISC_INDEX_DURATION_S = 2.5;     // visible indexing time

// Gripper
export const GRIPPER_OPEN_M  = 0.028;          // jaw opening (URDF max)
export const GRIPPER_CLOSE_M = 0.000;
export const GRIPPER_TRAVEL_S = 0.6;           // close/open animation duration

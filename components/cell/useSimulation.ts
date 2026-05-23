// Top-level simulation hook. Runs at 50 Hz (sim time + ROS tick rate),
// drives all subsystems and the FSM. Mutates the shared store in place.

import { useEffect, useRef } from 'react';
import { useSimStore, spawnCafi } from './store';
import { conveyorTick, robotTick, gripperTick, rotaryTick, visionTick, objectManagerTick } from './subsystems';
import { fsmTick } from './fsm';
import { POSE_LIB } from './poses';
import { PICK_X, BELT_Y, BELT_TOP_Z, CAFI_LZ } from './constants';

const TICK_HZ = 50;
const TICK_DT = 1.0 / TICK_HZ;

// Gripper world position is computed by the 3D scene (CobotChain has the
// transforms). We accept it as a callback so the sim can attach CAFIs.
export function useSimulation(getGripperWorldXYZ: () => [number, number, number] | null) {
  const store = useSimStore();
  const lastT = useRef<number>(performance.now() / 1000);
  const accum = useRef<number>(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const now = performance.now() / 1000;
      const elapsed = now - lastT.current;
      lastT.current = now;
      accum.current += elapsed;
      while (accum.current >= TICK_DT) {
        accum.current -= TICK_DT;
        const s = store.get();
        s.sim_t += TICK_DT;
        // Subsystems
        conveyorTick(s, TICK_DT);
        robotTick(s);
        gripperTick(s);
        rotaryTick(s);
        visionTick(s);
        const grip = getGripperWorldXYZ();
        if (grip) {
          s.gripper_world = grip;
          objectManagerTick(s, grip);
        }
        // FSM last (it reads everything)
        fsmTick(s);
      }
      store.notify();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [store, getGripperWorldXYZ]);
}

// Operator action helpers
export function useSimActions() {
  const store = useSimStore();
  return {
    spawnCafi: () => {
      const s = store.get();
      // Mirror state_manager._cb_op_spawn — IDLE -> RUNNING then spawn.
      if (s.fsm.cell === 'IDLE') {
        s.fsm.cell = 'RUNNING';
        s.fsm.stage = 'IDLE';
        s.fsm.stage_t0 = s.sim_t;
        s.fsm.fault_reason = '';
        store.notify();
      }
      if (s.fsm.cell === 'RUNNING' || s.fsm.cell === 'IDLE') {
        spawnCafi(store);
      }
    },
    toggleStop: () => {
      const s = store.get();
      s.hmi.stopped = !s.hmi.stopped;
      if (s.hmi.stopped) {
        if (s.fsm.cell === 'RUNNING') {
          s.fsm.cell = 'PAUSED';
          s.fsm.stage = 'STOPPED';
          s.fsm.stage_t0 = s.sim_t;
        }
      } else {
        if (s.fsm.cell === 'PAUSED' || s.fsm.cell === 'FAULT') {
          s.fsm.fault_reason = '';
          s.fsm.cell = 'RUNNING';
          s.fsm.stage = 'IDLE';
          s.fsm.stage_t0 = s.sim_t;
        }
      }
      store.notify();
    },
    reset: () => store.reset(),
    toggleCollapsed: () => {
      const s = store.get();
      s.hmi.collapsed = !s.hmi.collapsed;
      store.notify();
    },
    // DEBUG: snap robot to any named pose without trajectory. Pauses the FSM
    // so nothing cycles. Use with the gripper X/Y/Z telemetry to compare
    // landed positions vs expected V51 targets.
    debugSnapToPose: (poseName: keyof typeof POSE_LIB) => {
      store.reset();
      const s = store.get();
      s.fsm.cell = 'PAUSED';
      s.fsm.stage = 'STOPPED';
      s.fsm.stage_t0 = s.sim_t;
      s.hmi.stopped = true;
      const pose = POSE_LIB[poseName];
      if (!pose) return;
      s.robot.joints = [pose[0], pose[1], pose[2], pose[3], pose[4], pose[5]] as
        [number, number, number, number, number, number];
      s.robot.seg_start_joints = [...s.robot.joints] as typeof s.robot.seg_start_joints;
      s.robot.seg_target_joints = [...s.robot.joints] as typeof s.robot.seg_target_joints;
      s.robot.traj_queue = [];
      s.robot.seg_active = false;
      s.robot.waiting_for = null;
      s.robot.motion_done = true;
      s.robot.busy = false;
      s.robot.current_task = 'idle';
      // For PICK_CONVEYOR, also drop a CAFI at the pick window so we can
      // see the expected target visually.
      if (poseName === 'POSE_PICK_CONVEYOR') {
        const cafi = spawnCafi(store);
        if (cafi) {
          cafi.position = [PICK_X, BELT_Y, BELT_TOP_Z + CAFI_LZ / 2];
          cafi.at_sensor = true;
          cafi.ready_for_pick = true;
        }
      }
      store.notify();
    },
  };
}

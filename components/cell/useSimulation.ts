// Top-level simulation hook. Runs at 50 Hz (sim time + ROS tick rate),
// drives all subsystems and the FSM. Mutates the shared store in place.

import { useEffect, useRef } from 'react';
import { useSimStore, spawnCafi } from './store';
import { conveyorTick, robotTick, gripperTick, rotaryTick, visionTick, objectManagerTick } from './subsystems';
import { fsmTick } from './fsm';

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
        if (grip) objectManagerTick(s, grip);
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
  };
}

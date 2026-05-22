// Central simulation store — single source of truth for the cell sim.
// Mirrors the ROS topic graph as a flat in-memory state with React Context
// access. The reducer is dispatch-based; the sim hook drives ticks at 50 Hz.

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { POSE_LIB } from './poses';
import type { SimState, CAFI, FixtureId } from './types';
import {
  BELT_TOP_Z, BELT_Y, SPAWN_X, CAFI_LZ,
} from './constants';

// ── Initial state ────────────────────────────────────────────────────────────
function initSimState(): SimState {
  return {
    sim_t: 0,
    fsm: {
      cell: 'IDLE',
      stage: 'IDLE',
      stage_t0: 0,
      fault_reason: '',
    },
    robot: {
      joints: [...POSE_LIB.POSE_HOME] as [number, number, number, number, number, number],
      motion_done: true,
      busy: false,
      current_task: 'idle',
      traj_queue: [],
      seg_start_joints: [...POSE_LIB.POSE_HOME] as [number, number, number, number, number, number],
      seg_target_joints: [...POSE_LIB.POSE_HOME] as [number, number, number, number, number, number],
      seg_t0: 0,
      seg_duration: 1.5,
      seg_active: false,
      waiting_for: null,
      wait_t0: 0,
    },
    gripper: {
      state: 'OPEN',
      jaw: 0.028,
      grasp_confirmed: false,
      release_done: true,
      cmd_t0: 0,
    },
    rotary: {
      state: 'IDLE',
      angle: 0,
      index_start_angle: 0,
      index_target_angle: 0,
      index_t0: 0,
      index_done_flag: false,
      outer: 'A',
      inner: 'B',
      solenoid_left_outer: false,
      solenoid_left_inner: false,
      rivet_active: false,
      rivet_t0: 0,
      rivet_done_flag: false,
    },
    conveyor: {
      motor_on: false,
      spawn_allowed: false,
      part_present_pick: false,
      part_ready_for_pick: false,
    },
    vision: {
      presence: false,
      camera_trigger_t0: -1,
      camera_active: false,
      last_result: '',
    },
    hmi: {
      stopped: false,
      spawn_btn_enabled: true,
      collapsed: false,
    },
    cafis: [],
    next_cafi_id: 1,
  };
}

// ── Mutable store (single instance, ref-based) ───────────────────────────────
// We use a ref-based store so the 50 Hz tick can mutate without re-rendering
// React every frame. A separate "frame counter" state is bumped for UI sync.
class SimStore {
  state: SimState = initSimState();
  listeners = new Set<() => void>();

  get(): SimState { return this.state; }

  // Replace whole state (used by reducer-like updates).
  set(updater: (s: SimState) => void) {
    updater(this.state);
    this.notify();
  }

  // Optimised: caller already mutated state, just notify.
  notify() { this.listeners.forEach((fn) => fn()); }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  reset() {
    this.state = initSimState();
    this.notify();
  }
}

const StoreContext = createContext<SimStore | null>(null);

export function SimStoreProvider({ children }: { children: React.ReactNode }) {
  const storeRef = useRef<SimStore | null>(null);
  if (!storeRef.current) storeRef.current = new SimStore();
  return (
    <StoreContext.Provider value={storeRef.current}>
      {children}
    </StoreContext.Provider>
  );
}

export function useSimStore(): SimStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error('useSimStore must be used inside SimStoreProvider');
  return s;
}

// Reactively subscribe to store updates. Component re-renders whenever
// the store calls notify(). The HMI panel uses this; the 3D viewer
// reads directly from store.get() on each frame via useFrame.
export function useSimSnapshot(): SimState {
  const store = useSimStore();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  return store.get();
}

// ── CAFI spawn helper ────────────────────────────────────────────────────────
export function spawnCafi(store: SimStore): CAFI | null {
  const s = store.state;
  // Spawn guard: no CAFI within SPAWN_GUARD_R of SPAWN_X
  for (const c of s.cafis) {
    if (c.location === 'on_conveyor' && Math.abs(c.position[0] - SPAWN_X) < 0.150) {
      return null;
    }
  }
  const id = `cafi_${s.next_cafi_id}`;
  s.next_cafi_id += 1;
  const cafi: CAFI = {
    id,
    location: 'on_conveyor',
    position: [SPAWN_X, BELT_Y, BELT_TOP_Z + CAFI_LZ / 2],
    yaw: 0,
    at_sensor: false,
    ready_for_pick: false,
    fixture_id: null,
    riveted: false,
    verdict: '',
  };
  s.cafis = [...s.cafis, cafi];
  store.notify();
  return cafi;
}

// ── Helpers to query/find CAFIs (mirror state_manager helpers) ───────────────
export function cafiOnConveyorAtPick(s: SimState): CAFI | null {
  if (!s.conveyor.part_ready_for_pick) return null;
  for (const c of s.cafis) {
    if (c.location === 'on_conveyor' && c.at_sensor) return c;
  }
  return null;
}

export function outerCafi(s: SimState): CAFI | null {
  const outer = s.rotary.outer;
  for (const c of s.cafis) {
    if (c.location === ('in_fixture_' + outer) as CAFI['location']
        && c.fixture_id === outer) return c;
  }
  return null;
}

export function innerCafi(s: SimState): CAFI | null {
  const inner = s.rotary.inner;
  for (const c of s.cafis) {
    if (c.location === ('in_fixture_' + inner) as CAFI['location']
        && c.fixture_id === inner) return c;
  }
  return null;
}

export function visionCafi(s: SimState): CAFI | null {
  for (const c of s.cafis) {
    if (c.location === 'at_vision') return c;
  }
  return null;
}

export function inGripperCafi(s: SimState): CAFI | null {
  for (const c of s.cafis) {
    if (c.location === 'in_gripper') return c;
  }
  return null;
}

// Swap fixture id<->station mapping (called after a 180° index).
export function swapFixtures(s: SimState) {
  const o = s.rotary.outer;
  s.rotary.outer = s.rotary.inner;
  s.rotary.inner = o;
  // Move any CAFI from one station to the other
  for (const c of s.cafis) {
    if (c.location === 'in_fixture_A') c.location = 'in_fixture_B';
    else if (c.location === 'in_fixture_B') c.location = 'in_fixture_A';
  }
}

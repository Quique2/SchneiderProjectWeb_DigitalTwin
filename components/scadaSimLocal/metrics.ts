import type { RunModel } from './runTypes';

export interface ActivationTotals {
  sensors: number;
  actuators: number;
  operator: number;
  grandTotal: number;
}

export function activationTotals(run: RunModel | null | undefined): ActivationTotals {
  if (!run) return { sensors: 0, actuators: 0, operator: 0, grandTotal: 0 };
  const s = run.sensors;
  const a = run.actuators;
  const o = run.operator;

  const sensors =
    s.conveyorPhotoeye +
    s.fixture1Present +
    s.fixture2Present +
    s.limitHome +
    s.limitWork +
    s.visionPresent +
    s.cameraTrigger +
    s.cameraPass +
    s.cameraFail +
    s.cameraNoRead;

  // Count only rising-edge activations. ON-time fields such as conveyorOnMs,
  // tableMovingMs and rivetActiveMs are durations and must not be added here.
  const actuators =
    a.gripperClose +
    a.gripperOpen +
    a.conveyorStarts +
    a.tableTurns +
    a.rivetCycles;

  const operator =
    o.start +
    o.stop +
    o.resume +
    o.restart +
    o.confirmClean +
    o.finalize +
    o.manualReject +
    o.manualReusable +
    o.manualReview;

  return { sensors, actuators, operator, grandTotal: sensors + actuators + operator };
}

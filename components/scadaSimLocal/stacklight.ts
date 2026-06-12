import type { CellSnapshot } from '../cellStateTypes';
import type { RunModel } from './runTypes';

export type StacklightState = 'GREEN' | 'YELLOW' | 'RED' | 'OFF';
export type StacklightSourceState = 'WAITING' | 'CONNECTED' | 'LOST';

export function deriveStacklight(
  sourceState: StacklightSourceState,
  snapshot: CellSnapshot | null | undefined,
  run: RunModel | null | undefined,
): StacklightState {
  if (sourceState === 'LOST') return 'RED';
  if (!snapshot) return 'OFF';
  if (snapshot.fault || snapshot.cell === 'FAULT') return 'RED';
  if (run && run.status !== 'ACTIVE' && run.status.startsWith('ABORT')) return 'RED';
  if (snapshot.cell === 'RUNNING') return 'GREEN';
  if (snapshot.cell === 'PAUSED' || snapshot.cell === 'RESTARTING' || snapshot.cell === 'CLEANING_REQUIRED') return 'YELLOW';
  return 'OFF';
}

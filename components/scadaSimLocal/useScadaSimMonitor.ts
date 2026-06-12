// useScadaSimMonitor.ts - SCADA SIM monitor hook.
//
// It listens to Celda 3D snapshots, runs the observer aggregator, persists runs,
// and sends Phase 2B command requests through BroadcastChannel. It never mutates
// the FSM directly.

import { useEffect, useReducer, useRef } from 'react';
import type { CellSnapshot } from '../cellStateTypes';
import { createScadaSimBus, type ScadaSimBus, type ScadaSimBusMessage, type ScadaSimCommand } from './bus';
import { RunAggregator } from './runAggregator';
import { LocalRunStorageAdapter, type RunStorageAdapter } from './runStorage';
import { exportRunCsv, exportRunJson } from './exportRun';
import type { ScadaLanguage } from './i18n';
import type { RunModel } from './runTypes';

const SOURCE_LOST_MS = 2500;
const TICK_MS = 500;
const COMMAND_ACK_TIMEOUT_MS = 2500;

export type SourceState = 'WAITING' | 'CONNECTED' | 'LOST';
export type ScadaCommandState = 'idle' | 'waiting_ack' | 'applied' | 'error' | 'no_source' | 'timeout';

export interface ScadaCommandFeedback {
  state: ScadaCommandState;
  command?: ScadaSimCommand['type'];
  requestId?: string;
  message?: string;
  updatedAtMs?: number;
}

export interface ScadaSimMonitor {
  mode: 'MONITOR';
  sourceState: SourceState;
  ageS: number | null;
  lastSnapshot: CellSnapshot | null;
  currentRun: RunModel | null;
  history: RunModel[];
  commandFeedback: ScadaCommandFeedback;
  requestCommand: (command: ScadaSimCommand) => void;
  refreshHistory: () => void;
  exportCsv: (run: RunModel, language?: ScadaLanguage) => void;
  exportJson: (run: RunModel, language?: ScadaLanguage) => void;
}

function now(): number { return Date.now(); }

function computeSourceState(ever: boolean, lastRecvMs: number, atMs: number): SourceState {
  if (!ever) return 'WAITING';
  return atMs - lastRecvMs > SOURCE_LOST_MS ? 'LOST' : 'CONNECTED';
}

const idleCommand: ScadaCommandFeedback = { state: 'idle' };

export function useScadaSimMonitor(): ScadaSimMonitor {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const busRef = useRef<ScadaSimBus | null>(null);
  const storeRef = useRef<RunStorageAdapter | null>(null);
  const aggRef = useRef<RunAggregator | null>(null);
  const lastSnapRef = useRef<CellSnapshot | null>(null);
  const lastRecvRef = useRef<number>(0);
  const everRef = useRef<boolean>(false);
  const historyRef = useRef<RunModel[]>([]);
  const commandRef = useRef<ScadaCommandFeedback>(idleCommand);
  const commandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCommandTimer = () => {
    if (commandTimerRef.current) clearTimeout(commandTimerRef.current);
    commandTimerRef.current = null;
  };

  if (!storeRef.current) storeRef.current = new LocalRunStorageAdapter();
  if (!aggRef.current) {
    const store = storeRef.current;
    aggRef.current = new RunAggregator({
      allocRunNumber: () => store.allocRunNumber(),
      onRunEnded: (run) => {
        store.saveRun(run);
        store.clearCurrentRun();
        historyRef.current = store.getRunHistory();
      },
    });
  }

  useEffect(() => {
    const store = storeRef.current!;
    const agg = aggRef.current!;
    historyRef.current = store.getRunHistory();

    const ingest = (s: CellSnapshot) => {
      lastSnapRef.current = s;
      lastRecvRef.current = now();
      everRef.current = true;
      agg.ingest(s, now());
      const run = agg.getCurrentRun();
      if (run && run.status === 'ACTIVE') store.updateCurrentRun(run);
      force();
    };

    const bus = createScadaSimBus();
    busRef.current = bus;

    const seed = bus.readLastFrame();
    if (seed && now() - seed.t < SOURCE_LOST_MS) ingest(seed.snapshot);

    const unsub = bus.subscribe((msg: ScadaSimBusMessage) => {
      if (msg.kind === 'snapshot') {
        ingest(msg.snapshot);
      } else if (msg.kind === 'operatorEvent') {
        agg.noteOperatorEvent(msg.event, now());
        const run = agg.getCurrentRun();
        if (run && run.status === 'ACTIVE') store.updateCurrentRun(run);
        force();
      } else if (msg.kind === 'commandAck') {
        const pending = commandRef.current;
        if (pending.requestId && pending.requestId === msg.requestId) {
          clearCommandTimer();
          commandRef.current = {
            state: msg.ok ? 'applied' : 'error',
            command: msg.command.type,
            requestId: msg.requestId,
            message: msg.error,
            updatedAtMs: now(),
          };
          force();
        }
      }
    });

    const tick = setInterval(() => {
      const lost = everRef.current && now() - lastRecvRef.current > SOURCE_LOST_MS;
      if (lost) {
        const run = agg.getCurrentRun();
        if (run && run.status === 'ACTIVE' && agg.hasCafisInProcess()) {
          agg.abortCurrentRun('ABORTED_SOURCE_LOST', now());
        }
      }
      force();
    }, TICK_MS);

    const onLeave = () => {
      const run = agg.getCurrentRun();
      if (run && run.status === 'ACTIVE' && agg.hasCafisInProcess()) {
        agg.abortCurrentRun('ABORTED_PAGE_CLOSED', now());
      }
    };
    window.addEventListener('beforeunload', onLeave);
    window.addEventListener('pagehide', onLeave);
    const onVis = () => { if (document.visibilityState === 'hidden') onLeave(); };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      clearInterval(tick);
      clearCommandTimer();
      unsub();
      bus.close();
      window.removeEventListener('beforeunload', onLeave);
      window.removeEventListener('pagehide', onLeave);
      document.removeEventListener('visibilitychange', onVis);
      busRef.current = null;
    };
  }, []);

  const at = now();
  const age = everRef.current ? Math.max(0, at - lastRecvRef.current) : null;
  const sourceState = computeSourceState(everRef.current, lastRecvRef.current, at);

  const requestCommand = (command: ScadaSimCommand) => {
    const source = computeSourceState(everRef.current, lastRecvRef.current, now());
    if (source !== 'CONNECTED') {
      clearCommandTimer();
      commandRef.current = { state: 'no_source', command: command.type, message: 'NO_SOURCE', updatedAtMs: now() };
      force();
      return;
    }
    const bus = busRef.current;
    if (!bus) {
      clearCommandTimer();
      commandRef.current = { state: 'error', command: command.type, message: 'NO_BUS', updatedAtMs: now() };
      force();
      return;
    }

    clearCommandTimer();
    const requestId = bus.sendCommand(command);
    commandRef.current = { state: 'waiting_ack', command: command.type, requestId, updatedAtMs: now() };
    commandTimerRef.current = setTimeout(() => {
      if (commandRef.current.requestId === requestId && commandRef.current.state === 'waiting_ack') {
        commandRef.current = { state: 'timeout', command: command.type, requestId, message: 'ACK_TIMEOUT', updatedAtMs: now() };
        force();
      }
    }, COMMAND_ACK_TIMEOUT_MS);
    force();
  };

  return {
    mode: 'MONITOR',
    sourceState,
    ageS: age == null ? null : Math.round(age / 100) / 10,
    lastSnapshot: lastSnapRef.current,
    currentRun: aggRef.current!.getCurrentRun(),
    history: historyRef.current,
    commandFeedback: commandRef.current,
    requestCommand,
    refreshHistory: () => { historyRef.current = storeRef.current!.getRunHistory(); force(); },
    exportCsv: (run, language = 'es') => exportRunCsv(run, language),
    exportJson: (run, language = 'es') => exportRunJson(run, language),
  };
}

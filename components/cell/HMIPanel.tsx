// HMI side panel — collapsible, mirrors schneider_hmi/hmi_node.py V25 layout.
// 2 operator buttons + 4 DI lamps + 8 DO lamps + cell/stage/verdict/fault labels.

import React from 'react';
import { useSimSnapshot } from './store';
import { useSimActions } from './useSimulation';
import type { CellState } from './types';

const COLOR_OFF = '#3a3f48';
const COLOR_ON = '#22dd55';
const COLOR_WARN = '#dd3344';
const COLOR_ACCENT = '#3b8bff';

const cellColor = (c: CellState): string => {
  if (c === 'FAULT') return '#ff5566';
  if (c === 'RUNNING') return '#22dd55';
  if (c === 'PAUSED') return '#ffa033';
  return '#a0b0c0';
};

function Lamp({ on, label, warn = false }: { on: boolean; label: string; warn?: boolean }) {
  const c = on ? (warn ? COLOR_WARN : COLOR_ON) : COLOR_OFF;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      minWidth: 64, gap: 4,
    }}>
      <div style={{
        width: 16, height: 16, borderRadius: '50%',
        background: c,
        boxShadow: on ? `0 0 8px ${c}, 0 0 16px ${c}55` : 'inset 0 0 4px #000',
        transition: 'all 0.15s ease',
      }} />
      <div style={{
        fontSize: 9, color: '#c0c8d8', textAlign: 'center', letterSpacing: 0.3,
        fontFamily: 'monospace', lineHeight: 1.2,
      }}>
        {label}
      </div>
    </div>
  );
}

function StatusPill({ text, color, bg = 'transparent', mono = true }: {
  text: string; color: string; bg?: string; mono?: boolean;
}) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '3px 10px',
      borderRadius: 4,
      background: bg,
      color,
      fontSize: 11,
      fontWeight: 700,
      fontFamily: mono ? 'monospace' : 'inherit',
      letterSpacing: 0.5,
      border: `1px solid ${color}55`,
    }}>
      {text}
    </span>
  );
}

export default function HMIPanel() {
  const s = useSimSnapshot();
  const { spawnCafi, toggleStop, reset, toggleCollapsed } = useSimActions();

  const cell = s.fsm.cell;
  const stage = s.fsm.stage;
  const verdict = s.vision.last_result;
  const fault = s.fsm.fault_reason;
  const collapsed = s.hmi.collapsed;

  const spawnEnabled =
    (cell === 'IDLE') ||
    (cell === 'RUNNING' && s.conveyor.spawn_allowed);

  if (collapsed) {
    return (
      <div style={{
        position: 'absolute', top: 14, right: 14, zIndex: 30,
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <button onClick={toggleCollapsed}
          title="Expandir HMI"
          style={collapsedBtnStyle}>
          ◀ HMI
        </button>
        <StatusPill text={cell} color={cellColor(cell)} bg="rgba(10,16,28,0.85)" />
        <StatusPill text={stage} color="#e2e8f0" bg="rgba(10,16,28,0.85)" />
      </div>
    );
  }

  return (
    <div style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, width: 320,
      background: 'linear-gradient(180deg, #0c1828 0%, #0a1422 100%)',
      borderLeft: '1px solid #1d2c44',
      boxShadow: '-4px 0 20px rgba(0,0,0,0.4)',
      padding: 14, color: '#dde4f0',
      overflowY: 'auto',
      display: 'flex', flexDirection: 'column', gap: 12,
      zIndex: 25,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '1px solid #1d2c44', paddingBottom: 10,
      }}>
        <div>
          <div style={{
            fontSize: 8, letterSpacing: 4, color: '#22c55e', textTransform: 'uppercase',
          }}>
            HMI — schneider_hmi V25
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>
            Schneider Riveting Cell
          </div>
        </div>
        <button onClick={toggleCollapsed}
          title="Colapsar panel"
          style={iconBtnStyle}>
          ▶
        </button>
      </div>

      {/* Operator buttons */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <button
          onClick={spawnCafi}
          disabled={!spawnEnabled}
          style={spawnEnabled ? primaryBtnStyle : disabledBtnStyle}
        >
          Colocar CAFI
        </button>
        <button onClick={toggleStop}
          style={s.hmi.stopped ? resumeBtnStyle : stopBtnStyle}>
          {s.hmi.stopped ? '▶ RESUME' : '⏸ STOP'}
        </button>
      </div>

      {/* Cell state row */}
      <div style={panelBoxStyle}>
        <div style={panelTitleStyle}>Cell State</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <StatusPill text={cell} color={cellColor(cell)} />
          <span style={{ fontSize: 10, color: '#788090' }}>stage</span>
          <StatusPill text={stage} color="#e2e8f0" />
          <span style={{ fontSize: 10, color: '#788090' }}>camera</span>
          <StatusPill
            text={verdict || '--'}
            color={
              verdict === 'PASS' ? '#22dd55'
                : verdict === 'FAIL' ? '#ff5566'
                : '#788090'
            } />
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: '#788090' }}>spawn</span>
          <StatusPill
            text={spawnEnabled ? (cell === 'IDLE' ? 'ARRANCAR' : 'ALLOWED') : 'BLOCKED'}
            color={spawnEnabled ? COLOR_ON : COLOR_WARN} />
        </div>
        {fault && (
          <div style={{
            marginTop: 8, padding: 6, background: '#3a1010',
            border: '1px solid #ff556644', borderRadius: 4,
            color: '#ff8090', fontSize: 11, fontFamily: 'monospace',
          }}>
            ⚠ FAULT: {fault}
          </div>
        )}
      </div>

      {/* DI lamps */}
      <div style={panelBoxStyle}>
        <div style={panelTitleStyle}>Digital Inputs (4)</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <Lamp on={s.conveyor.part_present_pick} label={'DI1\nConveyor'} />
          <Lamp on={!!s.cafis.find((c) => c.location === 'in_fixture_' + s.rotary.outer)}
                label={'DI2\nRemachado'} />
          <Lamp on={s.vision.presence} label={'DI3\nVision'} />
          <Lamp on={!s.robot.busy} label={'DI4\nCobot ready'} />
        </div>
      </div>

      {/* DO lamps */}
      <div style={panelBoxStyle}>
        <div style={panelTitleStyle}>Digital Outputs (8)</div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8,
        }}>
          <Lamp on={s.conveyor.motor_on} label={'DO1\nConv Motor'} />
          <Lamp on={s.rotary.state === 'INDEXING'} label={'DO2\nDisco'} />
          <Lamp on={s.rotary.rivet_active} label={'DO3\nRemachado'} warn />
          <Lamp on={s.vision.camera_active} label={'DO4\nCámara'} />
          <Lamp on={s.gripper.state === 'OPEN' || s.gripper.state === 'OPENING'}
                label={'DO5\nGrip Open'} />
          <Lamp on={s.gripper.state === 'CLOSED' || s.gripper.state === 'CLOSING'}
                label={'DO6\nGrip Close'} />
          <Lamp on={s.rotary.solenoid_left_outer || s.rotary.solenoid_left_inner}
                label={'DO7\nSol Left'} />
          <Lamp on={false} label={'DO8\n(reservado)'} />
        </div>
      </div>

      {/* Live stats */}
      <div style={panelBoxStyle}>
        <div style={panelTitleStyle}>Telemetría</div>
        <div style={statRowStyle}>
          <span>sim_t</span><span>{s.sim_t.toFixed(1)} s</span>
        </div>
        <div style={statRowStyle}>
          <span>cafis</span><span>{s.cafis.length}</span>
        </div>
        <div style={statRowStyle}>
          <span>outer / inner</span><span>{s.rotary.outer} / {s.rotary.inner}</span>
        </div>
        <div style={statRowStyle}>
          <span>robot task</span><span>{s.robot.current_task}</span>
        </div>
        {s.rotary.rivet_active && (
          <div style={statRowStyle}>
            <span>rivet timer</span>
            <span>{(30 - (s.sim_t - s.rotary.rivet_t0)).toFixed(1)} s</span>
          </div>
        )}
        <div style={{ ...statRowStyle, marginTop: 6, paddingTop: 4, borderTop: '1px solid #1a2434' }}>
          <span>gripper X</span><span>{s.gripper_world[0].toFixed(3)} m</span>
        </div>
        <div style={statRowStyle}>
          <span>gripper Y</span><span>{s.gripper_world[1].toFixed(3)} m</span>
        </div>
        <div style={statRowStyle}>
          <span>gripper Z</span><span>{s.gripper_world[2].toFixed(3)} m</span>
        </div>
      </div>

      {/* Reset */}
      <button onClick={reset} style={resetBtnStyle}>↻ Reset Cell</button>

      <div style={{ marginTop: 'auto', fontSize: 9, color: '#456', textAlign: 'center' }}>
        Port fiel de schneider_state_manager V35
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────
const panelBoxStyle: React.CSSProperties = {
  background: 'rgba(20, 30, 48, 0.55)',
  border: '1px solid #1d2c44',
  borderRadius: 6,
  padding: 10,
};

const panelTitleStyle: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: 2,
  color: '#688',
  textTransform: 'uppercase',
  marginBottom: 8,
  fontWeight: 600,
};

const primaryBtnStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, #3b8bff 0%, #2563eb 100%)',
  color: '#fff', border: 'none', borderRadius: 5,
  padding: '12px 8px', fontSize: 12, fontWeight: 700,
  cursor: 'pointer', letterSpacing: 0.5,
  boxShadow: '0 2px 8px rgba(59,139,255,0.3)',
};

const disabledBtnStyle: React.CSSProperties = {
  background: '#2a3548', color: '#556', border: 'none', borderRadius: 5,
  padding: '12px 8px', fontSize: 12, fontWeight: 700,
  cursor: 'not-allowed', letterSpacing: 0.5,
};

const stopBtnStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, #f47835 0%, #d96416 100%)',
  color: '#fff', border: 'none', borderRadius: 5,
  padding: '12px 8px', fontSize: 12, fontWeight: 700,
  cursor: 'pointer', letterSpacing: 0.5,
  boxShadow: '0 2px 8px rgba(244,120,53,0.3)',
};

const resumeBtnStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, #22cc55 0%, #1aa044 100%)',
  color: '#fff', border: 'none', borderRadius: 5,
  padding: '12px 8px', fontSize: 12, fontWeight: 700,
  cursor: 'pointer', letterSpacing: 0.5,
  boxShadow: '0 2px 8px rgba(34,204,85,0.3)',
};

const resetBtnStyle: React.CSSProperties = {
  background: 'transparent', color: '#9eb',
  border: '1px solid #2a4060', borderRadius: 4,
  padding: '8px', fontSize: 11, fontFamily: 'monospace',
  cursor: 'pointer', letterSpacing: 0.5,
};

const iconBtnStyle: React.CSSProperties = {
  background: 'transparent', color: '#688', border: '1px solid #2a4060',
  borderRadius: 4, padding: '4px 8px', cursor: 'pointer',
  fontSize: 11,
};

const collapsedBtnStyle: React.CSSProperties = {
  background: 'rgba(10,16,28,0.85)', color: '#9bf',
  border: '1px solid #2a4060', borderRadius: 4,
  padding: '8px 12px', fontSize: 11, fontWeight: 700,
  cursor: 'pointer', letterSpacing: 1, fontFamily: 'monospace',
};

const statRowStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between',
  fontSize: 10, fontFamily: 'monospace', color: '#abc',
  padding: '2px 0',
};

// ─────────────────────────────────────────────────────────────────────────────
// OperatorHMI.tsx — HMI de operador de la celda Schneider (modo automático).
//
// HMI "tonta": MUESTRA estado y MANDA eventos. Toda la lógica vive en la máquina
// de estados pura (`cellStateMachine.ts`), alineada con LOGICA_PLANTA_SCHNEIDER.md
// (6 estados de celda, 2 fixtures A/B, remachado 30 s, STOP→RESUME/RESTART→limpieza).
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import type { UseCellSimulation } from './useCellSimulation';

const COLOR_OFF = '#3a4a5e';
const COLOR_ON = '#22dd55';
const COLOR_WARN = '#ff5566';

// Colores de acento = color del cable en el diagrama de conexiones (solo
// consistencia visual; el diagrama no se toca).
const ACCENT_RASP_INPUT = '#A953A0'; // sensores de entrada (limit switches + fotoeléctricos)
const ACCENT_COBOT_OUT = '#FEEAB9';  // confirmaciones del cobot

function Lamp({ on, label, warn }: { on: boolean; label: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flex: '1 0 0', minWidth: 56 }}>
      <span style={{ fontSize: 16, lineHeight: 1, color: on ? (warn ? COLOR_WARN : COLOR_ON) : COLOR_OFF, textShadow: on ? `0 0 8px ${warn ? COLOR_WARN : COLOR_ON}` : 'none' }}>●</span>
      <span style={{ fontSize: 8.5, color: '#8fa3bd', textAlign: 'center', lineHeight: 1.15 }}>{label}</span>
    </div>
  );
}

function OpButton({ label, color, enabled, onClick }: { label: string; color: string; enabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      style={{
        flex: 1,
        padding: '9px 4px',
        borderRadius: 6,
        border: 'none',
        cursor: enabled ? 'pointer' : 'default',
        background: enabled ? color : '#3b4555',
        color: enabled ? '#fff' : '#7e8a9a',
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: 0.3,
        textTransform: 'uppercase',
        transition: 'background 0.15s',
      }}
    >
      {label}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid #1d2c44', background: 'rgba(20,30,48,0.45)', borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 8.5, letterSpacing: 1.6, color: '#5f7da3', textTransform: 'uppercase', fontWeight: 600, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function statRow(label: string, value: string, color = '#dde4f0') {
  return (
    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, padding: '2px 0' }}>
      <span style={{ color: '#7a8c9e' }}>{label}</span>
      <span style={{ color, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function Pill({ text, on, warn }: { text: string; on: boolean; warn?: boolean }) {
  return (
    <div style={{
      flex: 1, textAlign: 'center', padding: '4px 0', borderRadius: 5, fontSize: 9, fontWeight: 700,
      color: '#fff', background: on ? (warn ? COLOR_WARN : COLOR_ON) : COLOR_OFF,
    }}>
      {text}
    </div>
  );
}

/** Indicador de sensor: LED verde/gris + borde del color del cable del diagrama. */
function SensorDot({ on, label, accent }: { on: boolean; label: string; accent: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7,
      flex: '1 1 44%', minWidth: 118,
      border: `1px solid ${accent}`, borderRadius: 6, padding: '6px 9px',
      background: on ? `${accent}22` : 'rgba(255,255,255,0.02)',
      transition: 'background 0.15s',
    }}>
      <span style={{
        width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
        background: on ? COLOR_ON : COLOR_OFF,
        boxShadow: on ? `0 0 8px ${COLOR_ON}` : 'none',
        border: `1px solid ${on ? COLOR_ON : '#2a3950'}`,
      }} />
      <span style={{ fontSize: 9.5, color: '#cdd9ea', lineHeight: 1.15 }}>{label}</span>
    </div>
  );
}

export default function OperatorHMI({ sim }: { sim: UseCellSimulation }) {
  const s = sim.snapshot;
  const tt = s.turntable;

  // ── Habilitación de botones (matriz de operador) ───────────────────────────
  const startEnabled = s.mode === 'HMI' && s.cell === 'IDLE';
  const cafiEnabled = s.spawnAllowed;
  const stopEnabled = s.cell === 'RUNNING';
  const resumeEnabled = s.cell === 'PAUSED' && !s.fault;
  const restartEnabled = s.cell === 'PAUSED';
  const cleanEnabled = s.cell === 'CLEANING_REQUIRED';
  const resetEnabled = s.cell === 'FAULT';
  // FINALIZAR (≠ STOP): sólo en RUNNING y si no se está finalizando ya.
  const finalizeEnabled = s.cell === 'RUNNING' && !s.finalizing;

  // ── Sensores derivados del MISMO snapshot que controla la simulación ───────
  const sensors = {
    limitSwitchHome: tt.limitHome,
    limitSwitchWork: tt.limitWork,
    fixtureA: s.fixtureA.present,
    fixtureB: s.fixtureB.present,
    limitConveyor1: s.cafis.some((c) => c.state === 'DISPENSED' || c.state === 'ON_CONVEYOR_WAITING'),
    limitConveyor2: s.sensorOccupied,
    photoConveyor: s.di.conveyor,
    photoCamera: s.di.vision,
    cobotPickConfirm: s.do.gripClose,
    cobotPlaceConfirm: s.do.gripOpen,
  };

  const cellColor =
    s.cell === 'FAULT' ? COLOR_WARN
    : s.cell === 'RUNNING' ? COLOR_ON
    : s.cell === 'PAUSED' ? '#fbbf24'
    : s.cell === 'RESTARTING' ? '#8b5cf6'
    : s.cell === 'CLEANING_REQUIRED' ? '#ef4444'
    : '#cbd5e1';
  const verdictColor = s.verdict === 'PASS' ? COLOR_ON : s.verdict === 'FAIL' ? COLOR_WARN : '#5f7da3';

  const fixtureText = (f: typeof s.fixtureA): string =>
    `${f.cafiId != null ? `CAFI #${f.cafiId}` : 'vacío'} · ${f.role === 'OUTSIDE' ? 'externo' : 'remache'}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Header */}
      <div>
        <div style={{ fontSize: 9, letterSpacing: 2.5, color: '#22c55e', textTransform: 'uppercase', fontWeight: 600 }}>
          schneider_hmi · ROS-like
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#f1f5f9', letterSpacing: -0.2 }}>
          Operator HMI — Celda de Remachado
        </div>
      </div>

      {/* Operator buttons */}
      <div style={{ display: 'flex', gap: 6 }}>
        <OpButton label="Start" color="#22aa55" enabled={startEnabled} onClick={sim.start} />
        <OpButton label="Colocar CAFI" color="#3399ff" enabled={cafiEnabled} onClick={sim.placeCafi} />
        <OpButton label="Stop" color="#dd5500" enabled={stopEnabled} onClick={sim.stop} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <OpButton label="Resume" color="#2563eb" enabled={resumeEnabled} onClick={sim.resume} />
        <OpButton label="Restart" color="#d97706" enabled={restartEnabled} onClick={sim.restart} />
        <OpButton label="Confirmar limpieza" color="#16a34a" enabled={cleanEnabled} onClick={sim.confirmClean} />
        {resetEnabled && <OpButton label="Reset" color="#a23bff" enabled={resetEnabled} onClick={sim.reset} />}
      </div>
      {/* FINALIZAR: fin de operación normal (≠ STOP). Drena lo en proceso y manda
          el cobot a HOME (único camino normal a HOME). */}
      <div style={{ display: 'flex', gap: 6 }}>
        <OpButton label={s.finalizing ? 'Finalizando…' : 'Finalizar'} color="#0e7490" enabled={finalizeEnabled} onClick={sim.finalize} />
      </div>

      {/* Cell state */}
      <Section title="Cell State">
        {statRow('Celda', s.cell, cellColor)}
        {statRow('Cobot', s.cobotTask, '#a78bfa')}
        {statRow('Cámara (verdict)', s.verdict || '--', verdictColor)}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <Pill text={s.spawnAllowed ? 'SPAWN ALLOWED' : 'SPAWN BLOCKED'} on warn={!s.spawnAllowed} />
          {s.cobotInTableZone ? <Pill text="COBOT EN ZONA" on warn /> : null}
          {s.fault ? <Pill text={s.faultReason || 'FAULT'} on warn /> : null}
        </div>
        {!s.spawnAllowed && s.spawnBlockReason ? (
          <div style={{ fontSize: 9, color: '#9bb0c8', marginTop: 6, fontStyle: 'italic' }}>
            Motivo: {s.spawnBlockReason}
          </div>
        ) : null}
        {s.cell === 'CLEANING_REQUIRED' ? (
          <div style={{ fontSize: 9.5, color: '#fca5a5', marginTop: 6 }}>
            Retira los CAFIs atrapados y presiona "Confirmar limpieza".
          </div>
        ) : null}
      </Section>

      {/* Contadores / cola */}
      <Section title="Producción · Cola">
        {statRow('Aceptados', String(s.counts.accepted), COLOR_ON)}
        {statRow('Rechazados', String(s.counts.rejected), s.counts.rejected > 0 ? COLOR_WARN : '#dde4f0')}
        {statRow('En proceso', String(s.counts.inProcess))}
        {statRow('CAFIs esperando', `${s.waitingCount} / 2`, s.waitingCount >= 2 ? COLOR_WARN : '#dde4f0')}
        {statRow('Sensor banda', s.sensorOccupied ? `OCUPADO (#${s.sensorCafiId})` : 'libre', s.sensorOccupied ? '#fb923c' : COLOR_ON)}
      </Section>

      {/* Mesa rotatoria + fixtures */}
      <Section title="Mesa Rotatoria · Fixtures">
        {statRow('Posición', tt.state, tt.state === 'ERROR' ? COLOR_WARN : '#a78bfa')}
        {statRow('Ángulo', `${tt.angleDeg.toFixed(1)}°`)}
        {statRow('Fixture externo', s.outsideFixtureId)}
        {statRow('Fixture remache', s.rivetFixtureId)}
        {statRow('Fixture A', fixtureText(s.fixtureA), s.fixtureA.present ? '#fb923c' : '#7a8c9e')}
        {statRow('Fixture B', fixtureText(s.fixtureB), s.fixtureB.present ? '#fb923c' : '#7a8c9e')}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <Pill text="LIMIT HOME" on={tt.limitHome} />
          <Pill text="LIMIT WORK" on={tt.limitWork} />
        </div>
      </Section>

      {/* Remachado (30 s) */}
      <Section title="Remachado (30 s)">
        {statRow('Estado', s.riveting, s.riveting === 'ACTIVE' ? '#fb923c' : s.riveting === 'FAULT' ? COLOR_WARN : '#7a8c9e')}
        {statRow('Remache listo', s.rivetingDone ? 'SÍ' : 'no', s.rivetingDone ? COLOR_ON : '#7a8c9e')}
        {s.riveting === 'ACTIVE' && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 9, color: '#fb923c', marginBottom: 4 }}>
              {30 - s.rivetSecondsLeft}s / 30s
            </div>
            <div style={{ height: 6, background: '#1e1e2e', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${s.rivetProgress * 100}%`, background: 'linear-gradient(90deg,#dc2626,#f97316)', borderRadius: 3, transition: 'width 0.1s' }} />
            </div>
          </div>
        )}
      </Section>

      {/* Sensores — Mesa & Fixtures */}
      <Section title="Limit Switches · Mesa & Fixtures">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <SensorDot on={sensors.limitSwitchHome} label="Mesa · HOME (0°)"   accent={ACCENT_RASP_INPUT} />
          <SensorDot on={sensors.limitSwitchWork} label="Mesa · WORK (180°)" accent={ACCENT_RASP_INPUT} />
          <SensorDot on={sensors.fixtureA}        label="Fixture A presente" accent={ACCENT_RASP_INPUT} />
          <SensorDot on={sensors.fixtureB}        label="Fixture B presente" accent={ACCENT_RASP_INPUT} />
        </div>
      </Section>

      {/* Sensores — Conveyor & Visión */}
      <Section title="Limit Switches Conveyor · Fotoeléctricos">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <SensorDot on={sensors.limitConveyor1} label="Conveyor · INICIO"     accent={ACCENT_RASP_INPUT} />
          <SensorDot on={sensors.limitConveyor2} label="Conveyor · FIN"        accent={ACCENT_RASP_INPUT} />
          <SensorDot on={sensors.photoConveyor}  label="Fotoeléctrico conveyor" accent={ACCENT_RASP_INPUT} />
          <SensorDot on={sensors.photoCamera}    label="Fotoeléctrico cámara"   accent={ACCENT_RASP_INPUT} />
        </div>
      </Section>

      {/* Confirmaciones del cobot */}
      <Section title="Confirmaciones Cobot · Outputs Cobot">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <SensorDot on={sensors.cobotPickConfirm}  label="Pick confirm · grip cerrado"  accent={ACCENT_COBOT_OUT} />
          <SensorDot on={sensors.cobotPlaceConfirm} label="Place confirm · grip abierto" accent={ACCENT_COBOT_OUT} />
        </div>
      </Section>

      {/* Digital Inputs */}
      <Section title="Digital Inputs (4)">
        <div style={{ display: 'flex', gap: 4 }}>
          <Lamp on={s.di.conveyor} label="Conveyor" />
          <Lamp on={s.di.rivet} label="Remachado" />
          <Lamp on={s.di.vision} label="Visión" />
          <Lamp on={s.di.cobotReady} label="Cobot ready" />
        </div>
      </Section>

      {/* Digital Outputs */}
      <Section title="Digital Outputs (8)">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <Lamp on={s.do.convMotor} label="Conv Motor" />
          <Lamp on={s.do.disco} label="Disco" />
          <Lamp on={s.do.remachado} label="Remachado" warn />
          <Lamp on={s.do.camara} label="Cámara" />
          <Lamp on={s.do.gripOpen} label="Grip Open" />
          <Lamp on={s.do.gripClose} label="Grip Close" />
          <Lamp on={s.do.solLeft} label="Sol Left" />
          <Lamp on={s.do.reservado} label="Reservado" />
        </div>
      </Section>

      {/* Modo */}
      <div style={{ fontSize: 9, color: '#5f7da3', textAlign: 'center', letterSpacing: 0.5 }}>
        MODO HMI · simulación automática ROS-like
      </div>
    </div>
  );
}

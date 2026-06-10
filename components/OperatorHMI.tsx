// ─────────────────────────────────────────────────────────────────────────────
// OperatorHMI.tsx — HMI de operador de la celda Schneider (modo automático).
//
// HMI "tonta": MUESTRA estado y MANDA eventos. Toda la lógica vive en la máquina
// de estados pura (`cellStateMachine.ts`), alineada con LOGICA_PLANTA_SCHNEIDER.md
// (6 estados de celda, 2 fixtures A/B, remachado 30 s, STOP→RESUME/RESTART→limpieza).
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import type { UseCellSimulation } from './useCellSimulation';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

const COLOR_ON   = '#22dd55';
const COLOR_WARN = '#ff5566';

// Colores de acento = color del cable en el diagrama de conexiones (solo
// consistencia visual; el diagrama no se toca).
const ACCENT_RASP_INPUT = '#A953A0'; // sensores de entrada (limit switches + fotoeléctricos)
const ACCENT_COBOT_OUT  = '#d4a02a'; // confirmaciones del cobot (amarillo más visible en ambos modos)

function Lamp({ on, label, warn }: { on: boolean; label: string; warn?: boolean }) {
  const T = useTheme();
  const colorOff = T.dark ? '#3a4a5e' : T.borderSoft;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flex: '1 0 0', minWidth: 56 }}>
      <span style={{
        fontSize: 16, lineHeight: 1,
        color: on ? (warn ? COLOR_WARN : COLOR_ON) : colorOff,
        textShadow: on ? `0 0 8px ${warn ? COLOR_WARN : COLOR_ON}` : 'none',
      }}>●</span>
      <span style={{ fontSize: 8.5, color: T.muted, textAlign: 'center', lineHeight: 1.15 }}>{label}</span>
    </div>
  );
}

function OpButton({ label, color, enabled, onClick }: { label: string; color: string; enabled: boolean; onClick: () => void }) {
  const T = useTheme();
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
        background: enabled ? color : (T.dark ? '#3b4555' : T.borderSoft),
        color: enabled ? '#fff' : T.dim,
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
  const T = useTheme();
  return (
    <div style={{
      border: `1px solid ${T.border}`,
      background: T.dark ? 'rgba(20,30,48,0.45)' : T.panel,
      borderRadius: 8, padding: 10,
    }}>
      <div style={{
        fontSize: 8.5, letterSpacing: 1.6, color: T.dim,
        textTransform: 'uppercase', fontWeight: 600, marginBottom: 8,
      }}>{title}</div>
      {children}
    </div>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color?: string }) {
  const T = useTheme();
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, padding: '2px 0' }}>
      <span style={{ color: T.muted }}>{label}</span>
      <span style={{ color: color ?? T.text, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function Pill({ text, on, warn }: { text: string; on: boolean; warn?: boolean }) {
  const T = useTheme();
  const colorOff = T.dark ? '#3a4a5e' : T.borderSoft;
  return (
    <div style={{
      flex: 1, textAlign: 'center', padding: '4px 0', borderRadius: 5, fontSize: 9, fontWeight: 700,
      color: on ? '#fff' : T.muted,
      background: on ? (warn ? COLOR_WARN : COLOR_ON) : colorOff,
    }}>
      {text}
    </div>
  );
}

/** Indicador de sensor: LED verde/gris + borde del color del cable del diagrama. */
function SensorDot({ on, label, accent }: { on: boolean; label: string; accent: string }) {
  const T = useTheme();
  const colorOff = T.dark ? '#3a4a5e' : T.borderSoft;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7,
      flex: '1 1 44%', minWidth: 118,
      border: `1px solid ${accent}`,
      borderRadius: 6, padding: '6px 9px',
      background: on ? `${accent}22` : (T.dark ? 'rgba(255,255,255,0.02)' : T.panel2),
      transition: 'background 0.15s',
    }}>
      <span style={{
        width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
        background: on ? COLOR_ON : colorOff,
        boxShadow: on ? `0 0 8px ${COLOR_ON}` : 'none',
        border: `1px solid ${on ? COLOR_ON : T.border}`,
      }} />
      <span style={{ fontSize: 9.5, color: T.text, lineHeight: 1.15 }}>{label}</span>
    </div>
  );
}

export default function OperatorHMI({ sim }: { sim: UseCellSimulation }) {
  const T = useTheme();
  const { t } = useLanguage();
  const s = sim.snapshot;
  const tt = s.turntable;

  // ── Habilitación de botones (matriz de operador) ───────────────────────────
  const startEnabled    = s.mode === 'HMI' && s.cell === 'IDLE';
  const cafiEnabled     = s.spawnAllowed;
  const stopEnabled     = s.cell === 'RUNNING';
  const resumeEnabled   = s.cell === 'PAUSED' && !s.fault;
  const restartEnabled  = s.cell === 'PAUSED';
  const cleanEnabled    = s.cell === 'CLEANING_REQUIRED';
  const resetEnabled    = s.cell === 'FAULT';
  const finalizeEnabled = s.cell === 'RUNNING' && !s.finalizing;

  // ── Sensores derivados del MISMO snapshot que controla la simulación ───────
  const sensors = {
    limitSwitchHome:  tt.limitHome,
    limitSwitchWork:  tt.limitWork,
    fixtureA:         s.fixtureA.present,
    fixtureB:         s.fixtureB.present,
    limitConveyor1:   s.cafis.some((c) => c.state === 'DISPENSED' || c.state === 'ON_CONVEYOR_WAITING'),
    limitConveyor2:   s.sensorOccupied,
    photoConveyor:    s.di.conveyor,
    photoCamera:      s.di.vision,
    cobotPickConfirm: s.do.gripClose,
    cobotPlaceConfirm:s.do.gripOpen,
  };

  const cellColor =
    s.cell === 'FAULT'             ? COLOR_WARN
    : s.cell === 'RUNNING'         ? COLOR_ON
    : s.cell === 'PAUSED'          ? '#fbbf24'
    : s.cell === 'RESTARTING'      ? '#8b5cf6'
    : s.cell === 'CLEANING_REQUIRED' ? '#ef4444'
    : T.dim;

  const verdictColor = s.verdict === 'PASS' ? COLOR_ON : s.verdict === 'FAIL' ? COLOR_WARN : T.dim;

  const fixtureText = (f: typeof s.fixtureA): string =>
    `${f.cafiId != null ? `CAFI #${f.cafiId}` : t('hmi.lbl.empty')} · ${f.role === 'OUTSIDE' ? t('hmi.lbl.roleOutside') : t('hmi.lbl.roleRivet')}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Header */}
      <div>
        <div style={{ fontSize: 9, letterSpacing: 2.5, color: '#22c55e', textTransform: 'uppercase', fontWeight: 600 }}>
          {t('hmi.label')}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text, letterSpacing: -0.2 }}>
          {t('hmi.title')}
        </div>
      </div>

      {/* Operator buttons */}
      <div style={{ display: 'flex', gap: 6 }}>
        <OpButton label={t('hmi.btn.start')}    color="#22aa55" enabled={startEnabled} onClick={sim.start} />
        <OpButton label={t('hmi.btn.placeCafi')} color="#3399ff" enabled={cafiEnabled} onClick={sim.placeCafi} />
        <OpButton label={t('hmi.btn.stop')}     color="#dd5500" enabled={stopEnabled}  onClick={sim.stop} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <OpButton label={t('hmi.btn.resume')}  color="#2563eb" enabled={resumeEnabled}  onClick={sim.resume} />
        <OpButton label={t('hmi.btn.restart')} color="#d97706" enabled={restartEnabled} onClick={sim.restart} />
        <OpButton label={t('hmi.btn.clean')}   color="#16a34a" enabled={cleanEnabled}   onClick={sim.confirmClean} />
        {resetEnabled && <OpButton label={t('hmi.btn.reset')} color="#a23bff" enabled={resetEnabled} onClick={sim.reset} />}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <OpButton label={s.finalizing ? t('hmi.btn.finalizing') : t('hmi.btn.finalize')} color="#0e7490" enabled={finalizeEnabled} onClick={sim.finalize} />
      </div>

      {/* Cell state */}
      <Section title={t('hmi.sec.cellState')}>
        <StatRow label={t('hmi.lbl.cell')}   value={s.cell}            color={cellColor} />
        <StatRow label={t('hmi.lbl.cobot')}  value={s.cobotTask}       color="#a78bfa" />
        <StatRow label={t('hmi.lbl.camera')} value={s.verdict || '--'} color={verdictColor} />
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <Pill text={s.spawnAllowed ? t('hmi.pill.spawnAllowed') : t('hmi.pill.spawnBlocked')} on warn={!s.spawnAllowed} />
          {s.cobotInTableZone ? <Pill text={t('hmi.pill.cobotZone')} on warn /> : null}
          {s.fault ? <Pill text={s.faultReason || 'FAULT'} on warn /> : null}
        </div>
        {!s.spawnAllowed && s.spawnBlockReason ? (
          <div style={{ fontSize: 9, color: T.muted, marginTop: 6, fontStyle: 'italic' }}>
            {t('hmi.lbl.reason')}: {s.spawnBlockReason}
          </div>
        ) : null}
        {s.cell === 'CLEANING_REQUIRED' ? (
          <div style={{ fontSize: 9.5, color: '#fca5a5', marginTop: 6 }}>
            {t('hmi.lbl.cleanMsg')}
          </div>
        ) : null}
      </Section>

      {/* Contadores / cola */}
      <Section title={t('hmi.sec.production')}>
        <StatRow label={t('hmi.lbl.accepted')}    value={String(s.counts.accepted)} color={COLOR_ON} />
        <StatRow label={t('hmi.lbl.rejected')}    value={String(s.counts.rejected)} color={s.counts.rejected > 0 ? COLOR_WARN : T.text} />
        <StatRow label={t('hmi.lbl.inProcess')}   value={String(s.counts.inProcess)} />
        <StatRow label={t('hmi.lbl.cafiWaiting')} value={`${s.waitingCount} / 2`} color={s.waitingCount >= 2 ? COLOR_WARN : T.text} />
        <StatRow label={t('hmi.lbl.sensorBand')}  value={s.sensorOccupied ? `${t('hmi.lbl.occupied')} (#${s.sensorCafiId})` : t('hmi.lbl.free')} color={s.sensorOccupied ? '#fb923c' : COLOR_ON} />
      </Section>

      {/* Mesa rotatoria + fixtures */}
      <Section title={t('hmi.sec.turntable')}>
        <StatRow label={t('hmi.lbl.position')}     value={tt.state}                    color={tt.state === 'ERROR' ? COLOR_WARN : '#a78bfa'} />
        <StatRow label={t('hmi.lbl.angle')}        value={`${tt.angleDeg.toFixed(1)}°`} />
        <StatRow label={t('hmi.lbl.fixtureExt')}   value={s.outsideFixtureId} />
        <StatRow label={t('hmi.lbl.fixtureRivet')} value={s.rivetFixtureId} />
        <StatRow label={t('hmi.lbl.fixtureA')}     value={fixtureText(s.fixtureA)} color={s.fixtureA.present ? '#fb923c' : T.muted} />
        <StatRow label={t('hmi.lbl.fixtureB')}     value={fixtureText(s.fixtureB)} color={s.fixtureB.present ? '#fb923c' : T.muted} />
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <Pill text={t('hmi.pill.limitHome')} on={tt.limitHome} />
          <Pill text={t('hmi.pill.limitWork')} on={tt.limitWork} />
        </div>
      </Section>

      {/* Remachado (30 s) */}
      <Section title={t('hmi.sec.rivet')}>
        <StatRow label={t('hmi.lbl.rivetState')} value={s.riveting}             color={s.riveting === 'ACTIVE' ? '#fb923c' : s.riveting === 'FAULT' ? COLOR_WARN : T.muted} />
        <StatRow label={t('hmi.lbl.rivetDone')}  value={s.rivetingDone ? t('hmi.lbl.yes') : t('hmi.lbl.no')} color={s.rivetingDone ? COLOR_ON : T.muted} />
        {s.riveting === 'ACTIVE' && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 9, color: '#fb923c', marginBottom: 4 }}>
              {30 - s.rivetSecondsLeft}s / 30s
            </div>
            <div style={{ height: 6, background: T.dark ? '#1e1e2e' : T.borderSoft, borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${s.rivetProgress * 100}%`, background: 'linear-gradient(90deg,#dc2626,#f97316)', borderRadius: 3, transition: 'width 0.1s' }} />
            </div>
          </div>
        )}
      </Section>

      {/* Sensores — Mesa & Fixtures */}
      <Section title={t('hmi.sec.limitTable')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <SensorDot on={sensors.limitSwitchHome} label={t('hmi.sensor.mesaHome')}  accent={ACCENT_RASP_INPUT} />
          <SensorDot on={sensors.limitSwitchWork} label={t('hmi.sensor.mesaWork')}  accent={ACCENT_RASP_INPUT} />
          <SensorDot on={sensors.fixtureA}        label={t('hmi.sensor.fixtureA')}  accent={ACCENT_RASP_INPUT} />
          <SensorDot on={sensors.fixtureB}        label={t('hmi.sensor.fixtureB')}  accent={ACCENT_RASP_INPUT} />
        </div>
      </Section>

      {/* Sensores — Conveyor & Visión */}
      <Section title={t('hmi.sec.limitConv')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <SensorDot on={sensors.limitConveyor1} label={t('hmi.sensor.convStart')}   accent={ACCENT_RASP_INPUT} />
          <SensorDot on={sensors.limitConveyor2} label={t('hmi.sensor.convEnd')}     accent={ACCENT_RASP_INPUT} />
          <SensorDot on={sensors.photoConveyor}  label={t('hmi.sensor.photoConv')}   accent={ACCENT_RASP_INPUT} />
          <SensorDot on={sensors.photoCamera}    label={t('hmi.sensor.photoCamera')} accent={ACCENT_RASP_INPUT} />
        </div>
      </Section>

      {/* Confirmaciones del cobot */}
      <Section title={t('hmi.sec.cobotConf')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <SensorDot on={sensors.cobotPickConfirm}  label={t('hmi.sensor.pickConf')}  accent={ACCENT_COBOT_OUT} />
          <SensorDot on={sensors.cobotPlaceConfirm} label={t('hmi.sensor.placeConf')} accent={ACCENT_COBOT_OUT} />
        </div>
      </Section>

      {/* Digital Inputs */}
      <Section title={t('hmi.sec.di')}>
        <div style={{ display: 'flex', gap: 4 }}>
          <Lamp on={s.di.conveyor}   label={t('hmi.lamp.conveyor')} />
          <Lamp on={s.di.rivet}      label={t('hmi.lamp.rivet')} />
          <Lamp on={s.di.vision}     label={t('hmi.lamp.vision')} />
          <Lamp on={s.di.cobotReady} label={t('hmi.lamp.cobotReady')} />
        </div>
      </Section>

      {/* Digital Outputs */}
      <Section title={t('hmi.sec.doOut')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <Lamp on={s.do.convMotor} label={t('hmi.lamp.convMotor')} />
          <Lamp on={s.do.disco}     label={t('hmi.lamp.disco')} />
          <Lamp on={s.do.remachado} label={t('hmi.lamp.remachado')} warn />
          <Lamp on={s.do.camara}    label={t('hmi.lamp.camara')} />
          <Lamp on={s.do.gripOpen}  label={t('hmi.lamp.gripOpen')} />
          <Lamp on={s.do.gripClose} label={t('hmi.lamp.gripClose')} />
          <Lamp on={s.do.solLeft}   label={t('hmi.lamp.solLeft')} />
          <Lamp on={s.do.reservado} label={t('hmi.lamp.reservado')} />
        </div>
      </Section>

      {/* Modo */}
      <div style={{ fontSize: 9, color: T.dim, textAlign: 'center', letterSpacing: 0.5 }}>
        {t('hmi.modeLabel')}
      </div>
    </div>
  );
}

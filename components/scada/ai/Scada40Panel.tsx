// ─────────────────────────────────────────────────────────────────────────────
// Scada40Panel.tsx — Sección "SCADA 4.0 (AI)": SOP · Predictivo · Optimización ·
// Anomalías + alarmas agrupadas. Consume los 5 pilares ya derivados. Solo presenta;
// el botón "Confirmar acción" registra en un log (NO manda comandos al hardware).
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState } from 'react';
import { useScadaTheme } from '../shared/useScadaTheme';
import ScadaSectionCard from '../shared/ScadaSectionCard';
import { ScadaBadge, type BadgeTone } from '../shared/ScadaStatusBadge';
import type { ScadaTokens } from '../shared/scadaTheme';
import type { Pillars } from './pillars';
import type { PillarStatus } from './predictive';

const MONO = '"Space Mono","JetBrains Mono","IBM Plex Mono","Courier New",monospace';

function statusTone(s: PillarStatus): BadgeTone {
  return s === 'OK' ? 'success' : s === 'NO_PASS' ? 'danger' : s === 'WARNING' ? 'warning' : 'muted';
}
function statusText(s: PillarStatus): string { return s === 'NO_PASS' ? 'NO PASS' : s; }

export default function Scada40Panel({ pillars }: { pillars: Pillars }) {
  const { tokens: t } = useScadaTheme();
  const [log, setLog] = useState<string[]>([]);
  const confirm = (decision: string) => setLog((l) => [`${new Date().toLocaleTimeString()} · Operador confirmó: ${decision}`, ...l].slice(0, 8));

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, width: '100%' }}>
      <SopCard t={t} pillars={pillars} onConfirm={confirm} log={log} />
      <PredictiveCard t={t} pillars={pillars} />
      <OptimizationCard t={t} pillars={pillars} />
      <AnomalyCard t={t} pillars={pillars} />
    </div>
  );
}

function KV({ t, k, v, color }: { t: ScadaTokens; k: string; v: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: `1px solid ${t.borderSoft}` }}>
      <span style={{ fontSize: 12, color: t.muted }}>{k}</span>
      <span style={{ fontSize: 12.5, color: color || t.text, fontFamily: MONO, fontWeight: 700, textAlign: 'right' }}>{v}</span>
    </div>
  );
}

// ── Pilar 4: SOP / Operador ──
function SopCard({ t, pillars, onConfirm, log }: { t: ScadaTokens; pillars: Pillars; onConfirm: (d: string) => void; log: string[] }) {
  const sop = pillars.sop;
  const tone = sop.decision === 'CONTINUE' ? t.success : sop.decision === 'STOP' ? t.danger : t.warning;
  return (
    <ScadaSectionCard title="SOP / Operador (Pilar 4)" accent={tone}
      right={<ScadaBadge text={sop.decision} tone={sop.decision === 'CONTINUE' ? 'success' : sop.decision === 'STOP' ? 'danger' : 'warning'} />}>
      <div style={{ fontSize: 11, color: t.muted }}>Etapa: <b style={{ color: t.text }}>{sop.stage}</b></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
        {sop.sopSteps.map((s, i) => <div key={i} style={{ fontSize: 12.5, color: t.text }}>• {s}</div>)}
      </div>
      {sop.recovery.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: t.warning, fontWeight: 700 }}>Recuperación</div>
          {sop.recovery.map((r, i) => <div key={i} style={{ fontSize: 12, color: t.muted, marginTop: 2 }}>{i + 1}. {r}</div>)}
        </div>
      )}
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: t.text, flex: 1, minWidth: 160 }}>{sop.operatorPrompt}</span>
        <button onClick={() => onConfirm(sop.decision)} style={{
          background: tone, color: t.mode === 'light' ? '#fff' : '#06121f', border: 'none', borderRadius: 10,
          padding: '8px 16px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
        }}>Confirmar acción</button>
      </div>
      {log.length > 0 && (
        <div style={{ marginTop: 8, borderTop: `1px solid ${t.borderSoft}`, paddingTop: 6 }}>
          {log.map((l, i) => <div key={i} style={{ fontSize: 10, color: t.dim, fontFamily: MONO }}>{l}</div>)}
        </div>
      )}
    </ScadaSectionCard>
  );
}

// ── Pilar 2: Predictivo ──
function PredictiveCard({ t, pillars }: { t: ScadaTokens; pillars: Pillars }) {
  const p = pillars.predictive;
  const rulColor = p.rulPct === null ? t.dim : p.rulPct < 8 ? t.danger : p.rulPct < 25 ? t.warning : t.success;
  return (
    <ScadaSectionCard title="Predictivo (Pilar 2)" accent={t.accent} right={<ScadaBadge text={statusText(p.status)} tone={statusTone(p.status)} />}>
      {!p.available ? <div style={{ fontSize: 12.5, color: t.dim }}>N/D — sin ciclos/telemetría suficientes.</div> : (
        <>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: t.muted }}>
              <span>RUL (vida útil restante)</span><span style={{ color: rulColor, fontFamily: MONO, fontWeight: 700 }}>{p.rulPct === null ? 'N/D' : `${p.rulPct}%`}</span>
            </div>
            <div style={{ height: 8, background: t.surfaceSoft, borderRadius: 5, marginTop: 5, overflow: 'hidden', border: `1px solid ${t.border}` }}>
              <div style={{ height: '100%', width: `${p.rulPct ?? 0}%`, background: rulColor }} />
            </div>
          </div>
          <KV t={t} k="Ciclos remachado" v={p.rivetCycleCount ?? 'N/D'} />
          <KV t={t} k="Ciclos restantes" v={p.rulCyclesLeft ?? 'N/D'} />
          <KV t={t} k="Tendencia de carga" v={p.motorLoadTrend ?? 'N/D'} color={p.motorLoadTrend === 'RISING' ? t.warning : t.text} />
          <KV t={t} k="Vibración (proxy)" v={p.vibrationProxy === null ? 'N/D' : `${p.vibrationProxy} A`} color={p.vibrationProxy !== null && p.vibrationProxy > 0.6 ? t.warning : t.text} />
          <KV t={t} k="Estabilidad ciclo" v={p.cycleStability ?? 'N/D'} color={p.cycleStability === 'DEGRADING' ? t.warning : t.text} />
          <div style={{ fontSize: 11.5, color: t.muted, marginTop: 4 }}>{p.forecastMsg}</div>
        </>
      )}
    </ScadaSectionCard>
  );
}

// ── Pilar 3: Optimización ──
function OptimizationCard({ t, pillars }: { t: ScadaTokens; pillars: Pillars }) {
  const o = pillars.optimization;
  return (
    <ScadaSectionCard title="Optimización (Pilar 3)" accent={t.success} right={<ScadaBadge text="RECOMENDADO" tone="success" />}>
      {!o.available ? <div style={{ fontSize: 12.5, color: t.dim }}>N/D — sin datos de ciclo/cobot.</div> : (
        <>
          <KV t={t} k="Tiempo de ciclo" v={o.cycleTimeS === null ? 'N/D' : `${o.cycleTimeS}s`} />
          <KV t={t} k="Throughput" v={o.throughputPerHr === null ? 'N/D' : `${o.throughputPerHr}/h`} />
          <KV t={t} k="Idle (aprox.)" v={o.idleTimePct === null ? 'N/D' : `${o.idleTimePct}%`} color={o.idleTimePct !== null && o.idleTimePct > 35 ? t.warning : t.text} />
          <KV t={t} k="Energía / ciclo" v={o.energyPerCycleWh === null ? 'N/D' : `${o.energyPerCycleWh} Wh`} />
          <div style={{ marginTop: 8, borderTop: `1px solid ${t.borderSoft}`, paddingTop: 6 }}>
            <div style={{ fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: t.accent, fontWeight: 700, marginBottom: 4 }}>Setpoints recomendados</div>
            <KV t={t} k="Velocidad cobot" v={<span>{o.currentSpeedPct !== null ? `${o.currentSpeedPct}% → ` : ''}<b style={{ color: t.success }}>{o.setpoints.cobotSpeedPct}%</b></span>} />
            <KV t={t} k="Delay remachado" v={`${o.setpoints.rivetingDelayS}s`} />
            <KV t={t} k="Timing inspección" v={`${o.setpoints.inspectionTimingS}s`} />
          </div>
          {o.rationale.map((r, i) => <div key={i} style={{ fontSize: 11.5, color: t.muted, marginTop: 3 }}>• {r}</div>)}
        </>
      )}
    </ScadaSectionCard>
  );
}

// ── Pilar 1+5: Anomalía + Seguridad + alarmas agrupadas ──
function AnomalyCard({ t, pillars }: { t: ScadaTokens; pillars: Pillars }) {
  const a = pillars.anomaly;
  const sec = a.security;
  const flag = (label: string, on: boolean | null) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: t.muted }}>
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: on === true ? t.danger : on === false ? t.success : t.dim }} />{label}
    </span>
  );
  return (
    <ScadaSectionCard title="Anomalías & Seguridad (Pilar 1+5)" accent={t.danger} right={<ScadaBadge text={statusText(a.status)} tone={statusTone(a.status)} />}>
      <div style={{ fontSize: 12.5, color: t.text }}>{a.summary}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 4 }}>
        {flag('E-stop', sec.estop)}{flag('P-stop', sec.protectiveStop)}{flag('Colisión', sec.collision)}{flag('Motion err', sec.motionError)}
      </div>
      <KV t={t} k="Trayectoria cobot" v={sec.trajectory} color={sec.trajectory === 'NOMINAL' ? t.success : sec.trajectory === 'UNKNOWN' ? t.dim : t.danger} />
      {a.anomalies.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: t.warning, fontWeight: 700 }}>Anomalías (baseline)</div>
          {a.anomalies.map((an) => (
            <div key={an.metric} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: t.text, marginTop: 2 }}>
              <span>{an.metric}</span>
              <span style={{ fontFamily: MONO, color: an.severity === 'CRITICAL' ? t.danger : t.warning }}>z={an.z} (val {an.value} vs {an.baseline})</span>
            </div>
          ))}
        </div>
      )}
      {pillars.alarmGroups.length > 0 && (
        <div style={{ marginTop: 6, borderTop: `1px solid ${t.borderSoft}`, paddingTop: 6 }}>
          <div style={{ fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: t.muted, fontWeight: 700, marginBottom: 3 }}>Alarmas agrupadas</div>
          {pillars.alarmGroups.map((g) => (
            <div key={g.station} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginTop: 2 }}>
              <span style={{ color: t.text }}>{g.station} <span style={{ color: t.dim }}>({g.count})</span></span>
              <span style={{ color: g.worst.severity === 'CRITICAL' ? t.danger : g.worst.severity === 'ALARM' ? t.alarm : t.warning, fontFamily: MONO }}>{g.worst.severity}</span>
            </div>
          ))}
        </div>
      )}
      {a.status === 'OK' && a.anomalies.length === 0 && pillars.alarmGroups.length === 0 && (
        <div style={{ fontSize: 11.5, color: t.dim, marginTop: 4 }}>Sin anomalías ni alarmas activas.</div>
      )}
    </ScadaSectionCard>
  );
}

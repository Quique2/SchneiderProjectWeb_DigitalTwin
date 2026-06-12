// ─────────────────────────────────────────────────────────────────────────────
// CafiWindows.tsx — "Ventanas" por CAFI: aparecen al detectarse cada pieza y
// muestran su etapa por número ("Remachando CAFI 1", "CAFI 2 esperando"), progreso
// y tiempo de ciclo (conveyor→bin). Compartido por SCADA real y SCADA SIM.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { useScadaTheme } from '../shared/useScadaTheme';
import { useScadaT } from '../scadaI18n';
import type { ScadaTokens } from '../shared/scadaTheme';
import { CAFI_CAPACITY, type CafiTrack, type CafiStage } from './cafiTracker';

const MONO = '"Space Mono","JetBrains Mono","IBM Plex Mono","Courier New",monospace';

function stageColor(stage: CafiStage, t: ScadaTokens): string {
  switch (stage) {
    case 'WAITING': return t.sim;
    case 'PICK': case 'FIXTURE': return t.accent;
    case 'RIVETING': case 'INSPECTION': return t.warning;
    case 'RESULT_PASS': case 'DONE_ACCEPT': return t.success;
    case 'RESULT_FAIL': case 'DONE_REJECT': return t.danger;
    default: return t.muted;
  }
}

export interface CafiWindowsProps {
  cafis: CafiTrack[];
  total: number; accepted: number; rejected: number; inProcess: number;
  mode: 'real' | 'simulation';
  overCapacity?: boolean;
  onConfirmCollection?: () => void;
}

export default function CafiWindows({ cafis, total, accepted, rejected, inProcess, mode, overCapacity, onConfirmCollection }: CafiWindowsProps) {
  const { tokens: t } = useScadaTheme();
  const tr = useScadaT();
  const ordered = [...cafis].sort((a, b) => b.id - a.id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
      {overCapacity && (
        <div style={{ background: `${t.danger}16`, border: `1px solid ${t.danger}66`, borderLeft: `6px solid ${t.danger}`, borderRadius: 14, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 24 }}>⚠️</span>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: t.danger }}>{tr('cafiOvercapacityTitle')}</div>
            <div style={{ fontSize: 12.5, color: t.text, marginTop: 2 }}>
              {tr('cafiOvercapacityMsg').replace('{n}', String(inProcess)).replace('{max}', String(CAFI_CAPACITY)).split(tr('cafiOvercapacityBold')).map((part, i, arr) =>
                i < arr.length - 1 ? <React.Fragment key={i}>{part}<b>{tr('cafiOvercapacityBold')}</b></React.Fragment> : <React.Fragment key={i}>{part}</React.Fragment>
              )}
            </div>
          </div>
          {onConfirmCollection && (
            <button onClick={onConfirmCollection} style={{
              background: t.danger, color: '#fff', border: 'none', borderRadius: 10, padding: '10px 18px',
              fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
            }}>{tr('cafiConfirmCollection')}</button>
          )}
        </div>
      )}

      {/* Contadores */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        <Counter t={t} label={tr('cafiTotal')} value={String(total)} color={t.text} />
        <Counter t={t} label={tr('cafiInProcess').replace('{max}', String(CAFI_CAPACITY))} value={`${inProcess} / ${CAFI_CAPACITY}`} color={overCapacity ? t.danger : t.accent} />
        <Counter t={t} label={tr('cafiAccepted')} value={String(accepted)} color={t.success} />
        <Counter t={t} label={tr('cafiRejected')} value={String(rejected)} color={t.danger} />
      </div>

      {ordered.length === 0 ? (
        <div style={{ background: t.surface, border: `1px dashed ${t.border}`, borderRadius: 16, padding: '34px 24px', textAlign: 'center', color: t.muted }}>
          <div style={{ fontSize: 30, marginBottom: 8 }}>📦</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: t.text }}>{tr('cafiEmptyTitle')}</div>
          <div style={{ fontSize: 12.5, marginTop: 4 }}>
            {tr('cafiEmptySubReal')}
            {mode === 'simulation' ? ' ' + tr('cafiEmptySubSim') : ''}
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', gap: 14 }}>
          {ordered.map((c) => <CafiWindow key={c.id} c={c} t={t} />)}
        </div>
      )}
    </div>
  );
}

function Counter({ t, label, value, color }: { t: ScadaTokens; label: string; value: string; color: string }) {
  return (
    <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, padding: '13px 15px', boxShadow: t.shadow }}>
      <div style={{ fontSize: 9.5, letterSpacing: 1, textTransform: 'uppercase', color: t.muted, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, fontFamily: MONO, color, marginTop: 4, lineHeight: 1 }}>{value}</div>
    </div>
  );
}

function CafiWindow({ c, t }: { c: CafiTrack; t: ScadaTokens }) {
  const tr = useScadaT();
  const color = stageColor(c.stage, t);
  const done = !c.active;
  const pct = Math.round((c.step / 10) * 100);
  const timeTxt = c.cycleTimeS !== null
    ? `${c.cycleTimeS}s (${tr('cafiCycleUnit')})`
    : c.cycleStartS !== null ? `${c.elapsedS}s` : tr('cafiOnConveyor');

  return (
    <div style={{
      background: t.surface, border: `1px solid ${t.border}`, borderLeft: `5px solid ${color}`,
      borderRadius: 16, padding: '14px 16px', boxShadow: t.shadow, opacity: done ? 0.82 : 1,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 34, height: 34, borderRadius: 10, background: `${color}22`, color, border: `1px solid ${color}66`,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 800, fontSize: 14,
        }}>#{c.id}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14.5, fontWeight: 800, color, lineHeight: 1.2 }}>{c.label}</div>
          <div style={{ fontSize: 10.5, color: t.muted, fontFamily: MONO }}>
            {c.active ? tr('cafiInProcessStatus') : tr('cafiCompletedStatus')} · {timeTxt}
          </div>
        </div>
        {c.verdict && (
          <span style={{ fontSize: 10, fontWeight: 800, fontFamily: MONO, color: c.verdict === 'PASS' ? t.success : t.danger, border: `1px solid ${(c.verdict === 'PASS' ? t.success : t.danger)}66`, borderRadius: 7, padding: '3px 8px' }}>
            {c.verdict === 'PASS' ? tr('cafiAcceptedStatus') : tr('cafiRejectedStatus')}
          </span>
        )}
      </div>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: t.muted, marginBottom: 3 }}>
          <span>{tr('cafiProgress')}</span><span style={{ fontFamily: MONO }}>{c.step}/10</span>
        </div>
        <div style={{ height: 7, background: t.surfaceSoft, borderRadius: 5, overflow: 'hidden', border: `1px solid ${t.border}` }}>
          <div style={{ height: '100%', width: `${pct}%`, background: color, transition: 'width 300ms' }} />
        </div>
      </div>
    </div>
  );
}

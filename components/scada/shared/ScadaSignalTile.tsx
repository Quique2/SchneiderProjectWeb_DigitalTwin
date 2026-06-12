// ─────────────────────────────────────────────────────────────────────────────
// ScadaSignalTile.tsx — Tile grande y legible de una señal de I/O (real o SIM).
// Muestra LED, label humano, key canónica (para debug) y estado + calidad.
// NO cambia nombres de señales: signalKey es la key canónica tal cual.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { useScadaTheme } from './useScadaTheme';

const MONO = '"Space Mono","JetBrains Mono","IBM Plex Mono","Courier New",monospace';

export type SignalQuality = 'real' | 'sim' | 'stale' | 'not_connected' | 'null';

export interface ScadaTileData {
  label: string;                                   // "Conveyor Photoeye"
  signalKey: string;                               // "conveyor_photoeye" (canónica)
  value: boolean | number | string | null;
  kind: 'input' | 'output' | 'legacy';
  quality: SignalQuality;
  unit?: string;
}

export interface ScadaSignalTileLabels {
  on?: string;
  off?: string;
  active?: string;
  inactive?: string;
  notWired?: string;
  nullValue?: string;
  real?: string;
  sim?: string;
  stale?: string;
  notConnected?: string;
  na?: string;
}

function Badge({ text, color, soft }: { text: string; color: string; soft?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', fontSize: 9.5, fontWeight: 800, letterSpacing: 0.6,
      color, background: soft ? `${color}1f` : 'transparent', border: `1px solid ${color}66`,
      borderRadius: 6, padding: '2px 7px', fontFamily: MONO, textTransform: 'uppercase',
    }}>{text}</span>
  );
}

export default function ScadaSignalTile({ data, labels }: { data: ScadaTileData; labels?: ScadaSignalTileLabels }) {
  const { tokens: t } = useScadaTheme();
  const { value, kind, quality } = data;

  const isTrue = value === true;
  const isFalse = value === false;
  const isNull = value === null || value === undefined;

  const ledColor = isTrue ? t.success : isNull ? (quality === 'not_connected' ? t.ledOff : t.warning) : t.ledOff;

  const stateText = isTrue ? (kind === 'output' ? (labels?.on ?? 'ON') : (labels?.active ?? 'ACTIVE'))
    : isFalse ? (kind === 'output' ? (labels?.off ?? 'OFF') : (labels?.inactive ?? 'INACTIVE'))
    : isNull ? (quality === 'not_connected' ? (labels?.notWired ?? 'NOT WIRED') : (labels?.nullValue ?? 'NULL'))
    : `${value}${data.unit ? ` ${data.unit}` : ''}`;
  const stateColor = isTrue ? t.success : isFalse ? t.muted : t.warning;

  const qual: Record<SignalQuality, { txt: string; color: string }> = {
    real: { txt: labels?.real ?? 'REAL', color: t.success },
    sim: { txt: labels?.sim ?? 'SIM', color: t.sim },
    stale: { txt: labels?.stale ?? 'STALE', color: t.warning },
    not_connected: { txt: labels?.notConnected ?? 'N/C', color: t.dim },
    null: { txt: labels?.na ?? 'N/A', color: t.warning },
  };
  const q = qual[quality];
  const faded = quality === 'not_connected';

  return (
    <div style={{
      background: t.surface, border: `1px solid ${t.border}`, borderRadius: 16,
      padding: '14px 16px', minHeight: 84, display: 'flex', flexDirection: 'column',
      justifyContent: 'space-between', gap: 10, boxShadow: t.shadow, opacity: faded ? 0.62 : 1,
      borderLeft: `3px solid ${isTrue ? t.success : isNull ? t.border : t.borderSoft}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{
          width: 14, height: 14, borderRadius: '50%', marginTop: 2, flexShrink: 0,
          background: ledColor, boxShadow: isTrue ? `0 0 10px ${ledColor}` : 'none',
          border: isNull && quality !== 'not_connected' ? `2px solid ${t.warning}` : 'none',
        }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: t.text, lineHeight: 1.2 }}>{data.label}</div>
          <div style={{ fontSize: 11.5, fontFamily: MONO, color: t.dim, marginTop: 2, wordBreak: 'break-all' }}>{data.signalKey}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 800, fontFamily: MONO, color: stateColor, letterSpacing: 0.5 }}>{stateText}</span>
        <Badge text={q.txt} color={q.color} soft />
      </div>
    </div>
  );
}

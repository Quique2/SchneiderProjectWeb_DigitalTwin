// ─────────────────────────────────────────────────────────────────────────────
// ScadaIoPanel.tsx — Panel de I/O con segmented control GRANDE (Inputs/Outputs/
// Legacy) y grid responsive de tiles. Compartido por SCADA real y SCADA SIM.
// Responsive sin media queries: grid auto-fill minmax → 3/2/1 columnas.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState } from 'react';
import { useScadaTheme } from './useScadaTheme';
import ScadaSignalTile, { type ScadaSignalTileLabels, type ScadaTileData } from './ScadaSignalTile';

const MONO = '"Space Mono","JetBrains Mono","IBM Plex Mono","Courier New",monospace';
type IoKind = 'input' | 'output' | 'legacy';

export interface ScadaIoPanelProps {
  tiles: ScadaTileData[];
  mode: 'real' | 'simulation';
  title?: string;
  subtitle?: string;
  labels?: {
    input?: string;
    output?: string;
    legacy?: string;
    simulated?: string;
    real?: string;
    empty?: string;
    tile?: ScadaSignalTileLabels;
  };
}

const KIND_LABEL: Record<IoKind, string> = { input: 'Inputs Sistema', output: 'Outputs Sistema', legacy: 'Legacy / Diag.' };

export default function ScadaIoPanel({ tiles, mode, title, subtitle, labels }: ScadaIoPanelProps) {
  const { tokens: t } = useScadaTheme();
  const kinds: IoKind[] = (['input', 'output', 'legacy'] as IoKind[]).filter((k) => tiles.some((x) => x.kind === k));
  const [active, setActive] = useState<IoKind>(kinds[0] ?? 'input');
  const current = kinds.includes(active) ? active : (kinds[0] ?? 'input');
  const shown = tiles.filter((x) => x.kind === current);

  return (
    <div style={{
      background: t.surface, border: `1px solid ${t.border}`, borderRadius: 20,
      padding: 18, boxShadow: t.shadow, display: 'flex', flexDirection: 'column', gap: 16, width: '100%',
    }}>
      {(title || subtitle) && (
        <div>
          {title && <div style={{ fontSize: 16, fontWeight: 800, color: t.text, letterSpacing: 0.2 }}>{title}</div>}
          {subtitle && <div style={{ fontSize: 12, color: t.muted, marginTop: 2 }}>{subtitle}</div>}
        </div>
      )}

      {/* Segmented control GRANDE */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {kinds.map((k) => {
          const on = k === current;
          const count = tiles.filter((x) => x.kind === k).length;
          return (
            <button
              key={k}
              onClick={() => setActive(k)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 9,
                minHeight: 48, padding: '0 22px', borderRadius: 14,
                fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                background: on ? t.accent : t.surfaceSoft,
                color: on ? (t.mode === 'light' ? '#ffffff' : '#06121f') : t.muted,
                border: `1px solid ${on ? t.accent : t.border}`,
                transition: 'background 160ms, color 160ms',
              }}
            >
              {k === 'input' ? (labels?.input ?? KIND_LABEL[k]) : k === 'output' ? (labels?.output ?? KIND_LABEL[k]) : (labels?.legacy ?? KIND_LABEL[k])}
              <span style={{
                fontSize: 11.5, fontWeight: 800, fontFamily: MONO, borderRadius: 8, padding: '2px 8px',
                background: on ? 'rgba(255,255,255,0.22)' : t.border, color: on ? 'inherit' : t.dim,
              }}>{count}</span>
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <span style={{
          alignSelf: 'center', fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, fontFamily: MONO,
          color: mode === 'simulation' ? t.sim : t.success,
          border: `1px solid ${(mode === 'simulation' ? t.sim : t.success)}66`, borderRadius: 8, padding: '4px 10px',
        }}>{mode === 'simulation' ? (labels?.simulated ?? 'SIMULATED I/O') : (labels?.real ?? 'REAL I/O')}</span>
      </div>

      {/* Grid responsive de tiles */}
      {shown.length === 0 ? (
        <div style={{ fontSize: 13, color: t.dim, padding: '14px 0' }}>{labels?.empty ?? 'No signals in this category.'}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 268px), 1fr))', gap: 12 }}>
          {shown.map((d) => <ScadaSignalTile key={d.signalKey} data={d} labels={labels?.tile} />)}
        </div>
      )}
    </div>
  );
}

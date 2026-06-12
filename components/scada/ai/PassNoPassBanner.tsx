// PassNoPassBanner.tsx — Banner grande AI STATUS: PASS / NO_PASS / WARNING (compartido).
import React from 'react';
import { useScadaTheme } from '../shared/useScadaTheme';
import type { PassNoPass } from './passNoPass';

const MONO = '"Space Mono","JetBrains Mono","IBM Plex Mono","Courier New",monospace';

export default function PassNoPassBanner({ status }: { status: PassNoPass }) {
  const { tokens: t } = useScadaTheme();
  const v = status.verdict;
  const color = v === 'PASS' ? t.success : v === 'NO_PASS' ? t.danger : v === 'WARNING' ? t.warning : t.dim;
  const label = v === 'NO_PASS' ? 'NO PASS' : v;

  return (
    <div style={{
      background: `${color}14`, border: `1px solid ${color}66`, borderLeft: `6px solid ${color}`,
      borderRadius: 16, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12, boxShadow: t.shadow,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span style={{ width: 16, height: 16, borderRadius: '50%', background: color, boxShadow: `0 0 12px ${color}` }} />
        <span style={{ fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: t.muted, fontWeight: 700 }}>AI STATUS</span>
        <span style={{ fontSize: 30, fontWeight: 900, fontFamily: MONO, color, letterSpacing: 1 }}>{label}</span>
        {status.estimated && (
          <span style={{ fontSize: 9.5, fontWeight: 700, color: t.muted, border: `1px solid ${t.border}`, borderRadius: 7, padding: '3px 8px', fontFamily: MONO }}>
            ESTIMADO POR SEÑALES
          </span>
        )}
      </div>

      {status.reasons.length > 0 && (
        <div style={{ fontSize: 13, color: t.text, lineHeight: 1.5 }}>
          {status.reasons.map((r, i) => <div key={i}>• {r}</div>)}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {status.checks.map((c) => {
          const cc = c.ok === true ? t.success : c.ok === false ? t.danger : t.dim;
          return (
            <span key={c.label} title={c.detail} style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, background: t.surface,
              border: `1px solid ${t.border}`, borderRadius: 10, padding: '6px 11px',
            }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: cc, boxShadow: c.ok === true ? `0 0 6px ${cc}` : 'none' }} />
              <span style={{ fontSize: 11.5, color: t.text, fontWeight: 600 }}>{c.label}</span>
              <span style={{ fontSize: 10, color: t.muted, fontFamily: MONO }}>{c.ok === null ? 'N/D' : c.ok ? 'OK' : 'NG'}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ScadaStatusBadge.tsx — Badge de estado/calidad themificado (compartido).
import React from 'react';
import { useScadaTheme } from './useScadaTheme';

const MONO = '"Space Mono","JetBrains Mono","IBM Plex Mono","Courier New",monospace';

export type BadgeTone = 'accent' | 'success' | 'warning' | 'danger' | 'sim' | 'nodeRed' | 'muted';

export function ScadaBadge({ text, tone = 'muted', dot, soft = true, big }: { text: string; tone?: BadgeTone; dot?: boolean; soft?: boolean; big?: boolean }) {
  const { tokens: t } = useScadaTheme();
  const color = tone === 'muted' ? t.dim : (t as unknown as Record<string, string>)[tone] || t.accent;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: big ? 12 : 10, fontWeight: 800, letterSpacing: 0.7, fontFamily: MONO, textTransform: 'uppercase',
      color, background: soft ? `${color}1f` : 'transparent', border: `1px solid ${color}66`,
      borderRadius: 8, padding: big ? '6px 12px' : '3px 9px',
    }}>
      {dot && <span style={{ width: big ? 9 : 7, height: big ? 9 : 7, borderRadius: '50%', background: color, boxShadow: `0 0 7px ${color}` }} />}
      {text}
    </span>
  );
}

export default ScadaBadge;

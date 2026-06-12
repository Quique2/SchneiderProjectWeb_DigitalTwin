// ScadaSectionCard.tsx — Card de sección themificada (header + cuerpo).
import React from 'react';
import { useScadaTheme } from './useScadaTheme';

export default function ScadaSectionCard({ title, accent, right, children }: {
  title?: string; accent?: string; right?: React.ReactNode; children: React.ReactNode;
}) {
  const { tokens: t } = useScadaTheme();
  return (
    <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 18, padding: 18, boxShadow: t.shadow, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' }}>
      {(title || right) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {accent && <span style={{ width: 4, height: 16, borderRadius: 3, background: accent }} />}
          {title && <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: t.muted }}>{title}</div>}
          {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

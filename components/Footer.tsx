import React from 'react';
import { useTheme } from '../context/ThemeContext';

export default function Footer() {
  const T = useTheme();
  return (
    <div style={{
      borderTop: `1px solid ${T.border}`,
      padding: '28px 24px',
      background: T.dark ? 'rgba(0,0,0,0.3)' : T.panel2,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 4, height: 24, background: 'linear-gradient(180deg,#22c55e,#0ea5e9)', borderRadius: 2 }} />
        <div>
          <div style={{ fontSize: 10, letterSpacing: 3, color: '#22c55e', textTransform: 'uppercase' }}>
            Schneider Electric · ITESM Challenge 3.0
          </div>
          <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>
            Equipo 3 · Tecnológico de Monterrey · 2026
          </div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: T.dim }}>
        Gemelo digital generado a partir de workspace ROS V13 · 102 links · 101 joints
      </div>
    </div>
  );
}

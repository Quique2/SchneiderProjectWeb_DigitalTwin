import React from 'react';

export default function Footer() {
  return (
    <div style={{
      borderTop: '1px solid #1a3550',
      padding: '28px 24px',
      background: 'rgba(0,0,0,0.3)',
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
          <div style={{ fontSize: 11, color: '#2a4060', marginTop: 2 }}>
            Equipo 3 · Tecnológico de Monterrey · 2026
          </div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: '#1a3550' }}>
        Gemelo digital generado a partir de workspace ROS V13 · 102 links · 101 joints
      </div>
    </div>
  );
}

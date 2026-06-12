// ScadaThemeToggle.tsx — Switch segmentado Light/Dark para el header de cada SCADA.
import React from 'react';
import { useScadaTheme } from './useScadaTheme';

const MONO = '"Space Mono","JetBrains Mono","IBM Plex Mono","Courier New",monospace';

export default function ScadaThemeToggle() {
  const { theme, tokens: t, setTheme } = useScadaTheme();
  const seg = (mode: 'light' | 'dark', label: string, icon: string) => {
    const active = theme === mode;
    return (
      <button
        key={mode}
        onClick={() => setTheme(mode)}
        title={mode === 'light' ? 'Modo claro' : 'Modo oscuro'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          background: active ? t.accent : 'transparent',
          color: active ? (t.mode === 'light' ? '#ffffff' : '#06121f') : t.muted,
          border: 'none', borderRadius: 8, padding: '5px 10px',
          fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, cursor: 'pointer',
          fontFamily: MONO, transition: 'background 160ms, color 160ms',
        }}
      >
        <span style={{ fontSize: 11 }}>{icon}</span>{label}
      </button>
    );
  };
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, background: t.surfaceSoft, border: `1px solid ${t.border}`, borderRadius: 10, padding: 2 }}>
      {seg('light', 'Light', '☀')}
      {seg('dark', 'Dark', '☾')}
    </div>
  );
}

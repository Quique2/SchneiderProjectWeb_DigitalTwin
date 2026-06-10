import React from 'react';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

const SPEC_IDS = [
  { id: 'cobot',     color: '#3b82f6', title: 'Lexium Cobot' },
  { id: 'plc',       color: '#22c55e', title: 'Modicon M262' },
  { id: 'hmi',       color: '#0ea5e9', title: 'HMI 7"' },
  { id: 'eoat',      color: '#64748b', title: 'EoAT — Gripper' },
  { id: 'cognex',    color: '#c026d3', title: 'Cognex In-Sight 2800' },
  { id: 'fixture',   color: '#a855f7', title: 'Fixtures de Proceso' },
  { id: 'disc',      color: '#f59e0b', title: 'Disco Rotatorio' },
  { id: 'rejection', color: '#f97316', title: 'Sistema de Rechazo' },
];

function getSpecs(t: (k: string) => string) {
  return SPEC_IDS.map((s) => ({
    ...s,
    subtitle: t(`specs.items.${s.id}.subtitle`),
    specs: [0, 1, 2, 3, 4].map((i) => t(`specs.items.${s.id}.specs.${i}`)),
  }));
}

export default function SpecsGrid() {
  const T = useTheme();
  const { t } = useLanguage();
  const SPECS = getSpecs(t);
  return (
    <div style={{
      background: T.bgGrad,
      borderTop: `1px solid ${T.border}`,
      padding: '48px 24px 64px',
    }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 40 }}>
        <div style={{ fontSize: 9, letterSpacing: 5, color: '#22c55e', textTransform: 'uppercase', marginBottom: 8 }}>
          {t('specs.label')}
        </div>
        <div style={{ fontSize: 'clamp(20px,3vw,30px)', fontWeight: 700, color: T.text }}>
          {t('specs.title')}
        </div>
      </div>

      {/* Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: 16,
        maxWidth: 1100,
        margin: '0 auto',
      }}>
        {SPECS.map((s) => (
          <div key={s.id} style={{
            background: T.panel,
            border: `1px solid ${s.color}22`,
            borderLeft: `3px solid ${s.color}`,
            borderRadius: 8,
            padding: '18px 20px',
            transition: 'border-color 0.2s, background 0.2s',
          }}
            onMouseEnter={e => (e.currentTarget.style.background = `${s.color}0d`)}
            onMouseLeave={e => (e.currentTarget.style.background = T.panel)}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: s.color, marginBottom: 4 }}>{s.title}</div>
            <div style={{ fontSize: 10, color: T.dim, marginBottom: 14, letterSpacing: 0.5 }}>{s.subtitle}</div>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {s.specs.map((spec) => (
                <li key={spec} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11, color: T.muted, marginBottom: 5, lineHeight: 1.5 }}>
                  <span style={{ color: s.color, flexShrink: 0, marginTop: 2 }}>›</span>
                  {spec}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

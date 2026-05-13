import React from 'react';

const SPECS = [
  {
    id: 'cobot', color: '#3b82f6', title: 'Lexium Cobot',
    subtitle: 'LXMRL03S0000 · 3 kg payload',
    specs: ['Reach: 626 mm', 'Base: (1.671, 0.920) m', 'EtherNet/IP', 'Yaw: 90° (norte)', '3 pick-and-place ops'],
  },
  {
    id: 'plc', color: '#22c55e', title: 'Modicon M262',
    subtitle: 'PLC Controlador Central',
    specs: ['EtherNet/IP bidireccional', 'Digital I/O → pistones', 'Orquesta secuencia completa', 'Gestión de seguridad', 'Comunicación HMI + Cobot'],
  },
  {
    id: 'hmi', color: '#0ea5e9', title: 'HMI 7"',
    subtitle: 'Panel de Operador',
    specs: ['Botón START de ciclo', 'Indicador PASS / FAIL', 'Estado del sistema en vivo', 'Historial de turno', 'Conectado vía EtherNet/IP'],
  },
  {
    id: 'eoat', color: '#64748b', title: 'EoAT — Gripper',
    subtitle: 'Gripper 3 Dedos · MAL16x25',
    specs: ['Mecanismo pantógrafo', 'Cilindro doble efecto', 'Bore: 16 mm · Stroke: 25 mm', 'Presión: 6 bar max', 'Carga: CAFI 277 g'],
  },
  {
    id: 'cognex', color: '#c026d3', title: 'Cognex In-Sight 2800',
    subtitle: 'Sistema de Visión',
    specs: ['Inspección 5 remaches', 'Resultado PASS/FAIL en tiempo real', 'Señal Digital I/O al PLC', 'Montaje lateral en piso', 'Pos: (2.210, 1.200, 1.750) m'],
  },
  {
    id: 'fixture', color: '#a855f7', title: 'Fixtures de Proceso',
    subtitle: 'Remachado + Inspección · PLA/PETG',
    specs: ['Fixture remachado: 2 pistones', 'Perfil negativo del CAFI', 'Fixture visión: cara expuesta', '5 puntos de remache alineados', 'Insertos metálicos'],
  },
  {
    id: 'disc', color: '#f59e0b', title: 'Disco Rotatorio',
    subtitle: 'Mesa Indexadora 180°',
    specs: ['Radio: 100 mm', 'Centro: (1.671, 1.375) m', 'Mount LOAD: fuera cabina', 'Mount RIVET: bajo prensa', 'Fixture pre-rotado π rad'],
  },
  {
    id: 'rejection', color: '#f97316', title: 'Sistema de Rechazo',
    subtitle: 'Pistón Neumático → Bin',
    specs: ['Activado por PLC en FAIL', 'Eyección automática del CAFI', 'Bin rechazo: (1.486, 0.496) m', 'Bin aceptado: (1.786, 0.496) m', 'Altura bins: 150 mm'],
  },
];

export default function SpecsGrid() {
  return (
    <div style={{
      background: 'linear-gradient(160deg,#06101c 0%,#0a1520 100%)',
      borderTop: '1px solid #1a3550',
      padding: '48px 24px 64px',
    }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 40 }}>
        <div style={{ fontSize: 9, letterSpacing: 5, color: '#22c55e', textTransform: 'uppercase', marginBottom: 8 }}>
          Componentes
        </div>
        <div style={{ fontSize: 'clamp(20px,3vw,30px)', fontWeight: 700, color: '#f1f5f9' }}>
          Especificaciones Técnicas
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
            background: '#0b1828',
            border: `1px solid ${s.color}22`,
            borderLeft: `3px solid ${s.color}`,
            borderRadius: 8,
            padding: '18px 20px',
            transition: 'border-color 0.2s, background 0.2s',
          }}
            onMouseEnter={e => (e.currentTarget.style.background = `${s.color}08`)}
            onMouseLeave={e => (e.currentTarget.style.background = '#0b1828')}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: s.color, marginBottom: 4 }}>{s.title}</div>
            <div style={{ fontSize: 10, color: '#2a4060', marginBottom: 14, letterSpacing: 0.5 }}>{s.subtitle}</div>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {s.specs.map((spec) => (
                <li key={spec} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11, color: '#7a9ab8', marginBottom: 5, lineHeight: 1.5 }}>
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

import { useState } from 'react';

const COMPONENTS = {
  hmi:        { id: 'hmi',        label: '7" HMI Panel',            sublabel: 'Operator Interface',          color: '#0ea5e9', desc: 'Botón START · Indicadores PASS/FAIL · Estado del sistema · Historial de turno' },
  plc:        { id: 'plc',        label: 'Modicon M262 PLC',         sublabel: 'Central Controller',          color: '#22c55e', desc: 'Orquesta la secuencia completa · Gestiona señales de seguridad · Envía resultados al HMI vía EtherNet/IP' },
  cobot:      { id: 'cobot',      label: 'Lexium Cobot',             sublabel: 'Robotic Manipulation',        color: '#3b82f6', desc: '3 ops pick-and-place: ① Canaleta→Fixture Remache  ② Fixture Remache→Fixture Inspección  ③ Fixture Inspección→Stock Final (PASS)' },
  eoat:       { id: 'eoat',       label: 'EoAT – Gripper 3 Dedos',  sublabel: 'Cilindro MAL16x25',           color: '#64748b', desc: 'Mecanismo pantógrafo · Cilindro doble efecto 16 mm bore · 25 mm stroke · 6 bar max · Agarra CAFI (277 g)' },
  canaleta:   { id: 'canaleta',   label: 'Canaleta de Alimentación', sublabel: 'Entrada de piezas',           color: '#f59e0b', desc: 'Suministro continuo de CAFIs sin remachar a la zona de pick del cobot' },
  fixRem:     { id: 'fixRem',     label: 'Fixture de Remachado',     sublabel: '2 pistones de sujeción',      color: '#e11d48', desc: 'Perfil negativo del CAFI · 2 pistones neumáticos sujetan la pieza · Alinea 5 puntos de remache · PLA/PETG + insertos metálicos' },
  fixInsp:    { id: 'fixInsp',    label: 'Fixture de Inspección',    sublabel: 'Posicionamiento estable',     color: '#a855f7', desc: 'Expone la cara superior con 5 marcadores de remache · Garantiza repetibilidad posicional para el sistema de visión · PLA/PETG' },
  inspection: { id: 'inspection', label: 'Sistema de Inspección',    sublabel: 'Visión / Cognex 2800',        color: '#c026d3', desc: 'Detecta presencia de 5 marcadores de remache · Envía resultado PASS/FAIL al PLC en tiempo real' },
  pistonRej:  { id: 'pistonRej',  label: 'Pistón de Rechazo',        sublabel: 'Eyección automática',         color: '#f97316', desc: 'Pistón neumático activado por el PLC en resultado FAIL · Empuja el CAFI defectuoso al bin de rechazo' },
  canasta:    { id: 'canasta',    label: 'Bin de Rechazo',           sublabel: 'Destino FAIL',                color: '#dc2626', desc: 'Recibe CAFIs defectuosos eyectados por el pistón · Permite revisión posterior de piezas no conformes' },
  stock:      { id: 'stock',      label: 'Stock Final',              sublabel: 'Destino PASS',                color: '#16a34a', desc: 'Destino final para CAFIs conformes · El cobot deposita aquí las piezas que pasan la inspección' },
} as const;

type CompId = keyof typeof COMPONENTS;

const POS: Record<CompId, { x: number; y: number }> = {
  hmi:        { x: 110, y: 12  },
  plc:        { x: 110, y: 40  },
  canaleta:   { x: 28,  y: 75  },
  cobot:      { x: 110, y: 75  },
  eoat:       { x: 110, y: 107 },
  fixRem:     { x: 32,  y: 138 },
  fixInsp:    { x: 178, y: 138 },
  inspection: { x: 178, y: 107 },
  pistonRej:  { x: 138, y: 165 },
  canasta:    { x: 138, y: 195 },
  stock:      { x: 205, y: 165 },
};

const BW = 54, BH = 16, BX = -27, BY = -8;

const CONNECTIONS: { from: CompId; to: CompId; label: string; bi: boolean }[] = [
  { from: 'hmi',        to: 'plc',        label: 'EtherNet/IP',   bi: true  },
  { from: 'plc',        to: 'cobot',      label: 'EtherNet/IP',   bi: true  },
  { from: 'plc',        to: 'inspection', label: 'Digital I/O',   bi: true  },
  { from: 'plc',        to: 'fixRem',     label: 'I/O pistones',  bi: false },
  { from: 'plc',        to: 'pistonRej',  label: 'I/O rechazo',   bi: false },
  { from: 'cobot',      to: 'eoat',       label: 'Neumático',     bi: false },
  { from: 'cobot',      to: 'canaleta',   label: '① Pick',        bi: false },
  { from: 'cobot',      to: 'fixRem',     label: '① Place',       bi: false },
  { from: 'cobot',      to: 'fixInsp',    label: '② Pick/Place',  bi: false },
  { from: 'cobot',      to: 'stock',      label: '③ Place PASS',  bi: false },
  { from: 'inspection', to: 'fixInsp',    label: 'Scan',          bi: false },
  { from: 'pistonRej',  to: 'canasta',    label: 'Eyección',      bi: false },
  { from: 'fixInsp',    to: 'pistonRej',  label: '',              bi: false },
];

const STEPS = [
  { label: 'Inicio de Ciclo',                       color: '#0ea5e9', nodes: ['hmi','plc'] as CompId[],                                 desc: 'El operador presiona START en el HMI. El PLC habilita la secuencia y verifica que la zona de trabajo esté libre.' },
  { label: '① Pick desde Canaleta',                 color: '#f59e0b', nodes: ['plc','cobot','eoat','canaleta'] as CompId[],             desc: 'El cobot (con gripper EoAT) realiza el primer pick: agarra el CAFI sin remachar de la canaleta de alimentación.' },
  { label: '① Place en Fixture de Remachado',       color: '#e11d48', nodes: ['plc','cobot','fixRem'] as CompId[],                      desc: 'El cobot coloca el CAFI en el fixture de remachado. Los dos pistones neumáticos de sujeción se activan. El PLC dispara el ciclo de remachado simulado.' },
  { label: '② Pick desde Fixture de Remachado',    color: '#3b82f6', nodes: ['plc','cobot','eoat','fixRem'] as CompId[],               desc: 'Una vez completo el remachado, los pistones liberan. El cobot realiza el segundo pick, levantando la pieza del fixture.' },
  { label: '② Place en Fixture de Inspección',     color: '#a855f7', nodes: ['plc','cobot','fixInsp'] as CompId[],                     desc: 'El cobot deposita el CAFI remachado en el fixture de inspección, exponiendo la cara superior con 5 marcadores al sistema de visión.' },
  { label: 'Inspección de Remaches',                color: '#c026d3', nodes: ['inspection','fixInsp','plc','hmi'] as CompId[],          desc: 'El sistema de visión Cognex escanea los 5 marcadores. El resultado PASS/FAIL se envía al PLC y se muestra en el HMI en tiempo real.' },
  { label: 'Rechazo → Bin (FAIL)',                  color: '#dc2626', nodes: ['plc','fixInsp','pistonRej','canasta','hmi'] as CompId[], desc: 'Si la pieza es defectuosa (< 5 remaches detectados), el PLC activa el pistón de rechazo, que empuja el CAFI al bin.' },
  { label: '③ Place en Stock Final (PASS)',         color: '#16a34a', nodes: ['plc','cobot','eoat','fixInsp','stock','hmi'] as CompId[],desc: 'Si la pieza es conforme (5 remaches detectados), el cobot realiza el tercer pick-and-place: deposita el CAFI en el stock final.' },
];

export default function ArchitectureDiagram() {
  const [activeNode, setActiveNode] = useState<CompId | null>(null);
  const [activeStep, setActiveStep] = useState<number | null>(null);

  const highlighted: CompId[] = activeStep !== null
    ? STEPS[activeStep].nodes
    : activeNode ? [activeNode] : [];

  const connLit = (c: typeof CONNECTIONS[0]) =>
    highlighted.length > 0 && highlighted.includes(c.from) && highlighted.includes(c.to);

  const stepColor = activeStep !== null ? STEPS[activeStep].color : '#22c55e';

  return (
    <div style={{
      background: 'linear-gradient(160deg,#06101c 0%,#0b1829 60%,#040c14 100%)',
      borderTop: '1px solid #1a3550',
      borderBottom: '1px solid #1a3550',
    }}>
      {/* Section header */}
      <div style={{ padding: '32px 24px 0', textAlign: 'center' }}>
        <div style={{ fontSize: 9, letterSpacing: 5, color: '#22c55e', textTransform: 'uppercase', marginBottom: 8 }}>
          Arquitectura del Sistema
        </div>
        <div style={{ fontSize: 'clamp(20px,3vw,30px)', fontWeight: 700, color: '#f1f5f9' }}>
          Diagrama de Componentes Interactivo
        </div>
        <div style={{ fontSize: 12, color: '#2a4060', marginTop: 8 }}>
          Haz click en un nodo o en un paso del flujo para ver los detalles
        </div>
      </div>

      <div style={{
        display: 'flex',
        flex: 1,
        overflow: 'hidden',
        minHeight: 520,
        maxWidth: 1100,
        margin: '0 auto',
        width: '100%',
      }}>
        {/* SVG Diagram */}
        <div style={{ flex: 1, padding: '14px 6px 24px 16px', display: 'flex', flexDirection: 'column' }}>
          <svg viewBox="-5 0 225 210" style={{ width: '100%', maxHeight: '65vh' }}>
            <defs>
              <marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill="#1e3d60" />
              </marker>
              <marker id="arr-on" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill={stepColor} />
              </marker>
              <filter id="glow">
                <feGaussianBlur stdDeviation="2.5" result="b"/>
                <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
            </defs>

            {CONNECTIONS.map((c, i) => {
              const f = POS[c.from], t = POS[c.to];
              const on = connLit(c);
              const lx = (f.x + t.x) / 2;
              const ly = (f.y + t.y) / 2 - 2;
              return (
                <g key={i}>
                  <line x1={f.x} y1={f.y} x2={t.x} y2={t.y}
                    stroke={on ? stepColor : '#1e3d60'}
                    strokeWidth={on ? 1.4 : 0.8}
                    strokeDasharray={on ? 'none' : '3 2'}
                    markerEnd={on ? 'url(#arr-on)' : 'url(#arr)'}
                    filter={on ? 'url(#glow)' : 'none'}
                    style={{ transition: 'all 0.3s' }} />
                  {c.bi && (
                    <line x1={t.x} y1={t.y} x2={f.x} y2={f.y}
                      stroke={on ? '#0ea5e9' : '#1e3d60'}
                      strokeWidth={on ? 1.4 : 0.8}
                      strokeDasharray={on ? 'none' : '3 2'}
                      markerEnd={on ? 'url(#arr-on)' : 'url(#arr)'}
                      filter={on ? 'url(#glow)' : 'none'}
                      style={{ transition: 'all 0.3s' }} />
                  )}
                  {c.label && (
                    <text x={lx} y={ly} textAnchor="middle" fontSize="3"
                      fill={on ? '#86efac' : '#2a4f78'}
                      style={{ transition: 'all 0.3s', fontFamily: 'monospace' }}>
                      {c.label}
                    </text>
                  )}
                </g>
              );
            })}

            {(Object.values(COMPONENTS) as typeof COMPONENTS[CompId][]).map((comp) => {
              const p = POS[comp.id as CompId];
              const inHL = highlighted.includes(comp.id as CompId);
              const dim = highlighted.length > 0 && !inHL;
              return (
                <g key={comp.id} transform={`translate(${p.x},${p.y})`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => { setActiveStep(null); setActiveNode(activeNode === comp.id ? null : comp.id as CompId); }}>
                  {inHL && <circle r="16" fill={comp.color} opacity="0.10" filter="url(#glow)" />}
                  <rect x={BX} y={BY} width={BW} height={BH} rx="3"
                    fill={inHL ? comp.color + '1a' : dim ? '#050d18' : '#0b1828'}
                    stroke={inHL ? comp.color : dim ? '#080f1c' : '#1e3a5f'}
                    strokeWidth={inHL ? 1.0 : 0.5}
                    style={{ transition: 'all 0.3s' }} />
                  <rect x={BX} y={BY} width="2.5" height={BH} rx="1.2"
                    fill={inHL ? comp.color : dim ? '#080f1c' : '#1e3a5f'}
                    style={{ transition: 'all 0.3s' }} />
                  <text x={BX + 5} y="-1.2" fontSize="4.0"
                    fill={inHL ? '#f1f5f9' : dim ? '#151f2b' : '#7a9ab8'}
                    dominantBaseline="middle" fontWeight="700"
                    style={{ transition: 'all 0.3s' }}>
                    {comp.label}
                  </text>
                  <text x={BX + 5} y="4.2" fontSize="3.0"
                    fill={inHL ? comp.color : dim ? '#0d1824' : '#2a4560'}
                    dominantBaseline="middle"
                    style={{ transition: 'all 0.3s' }}>
                    {comp.sublabel}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* Legend */}
          <div style={{ display: 'flex', gap: 20, marginTop: 8, paddingLeft: 4, flexWrap: 'wrap' }}>
            {[
              { c: '#0ea5e9', l: 'EtherNet/IP bidireccional' },
              { c: '#22c55e', l: 'Digital I/O / Control PLC'  },
              { c: '#64748b', l: 'Acción física / Neumático'  },
            ].map(({ c, l }) => (
              <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }}>
                <div style={{ width: 20, height: 2, background: c, borderRadius: 1 }} />
                <span style={{ color: '#2a4060' }}>{l}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right panel */}
        <div style={{ width: 308, borderLeft: '1px solid #1a3550', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
          {/* Node detail */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid #0d1e30', minHeight: 105 }}>
            <div style={{ fontSize: 9, letterSpacing: 3, color: '#2a4060', marginBottom: 7, textTransform: 'uppercase' }}>
              {activeNode ? 'Componente seleccionado' : '← Haz click en un nodo'}
            </div>
            {activeNode && COMPONENTS[activeNode] ? (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, color: COMPONENTS[activeNode].color, marginBottom: 5 }}>
                  {COMPONENTS[activeNode].label}
                </div>
                <div style={{ fontSize: 11, color: '#7a9ab8', lineHeight: 1.65 }}>
                  {COMPONENTS[activeNode].desc}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: '#1a3550' }}>
                Selecciona un componente para ver sus detalles, o elige un paso del flujo de operación para resaltar los nodos involucrados.
              </div>
            )}
          </div>

          {/* Flow steps */}
          <div style={{ padding: '12px 16px 16px', flex: 1 }}>
            <div style={{ fontSize: 9, letterSpacing: 3, color: '#2a4060', marginBottom: 10, textTransform: 'uppercase' }}>
              Flujo Operativo · {STEPS.length} Pasos
            </div>
            {STEPS.map((s, i) => (
              <div key={i}
                onClick={() => { setActiveNode(null); setActiveStep(activeStep === i ? null : i); }}
                style={{
                  display: 'flex', gap: 9, marginBottom: 5,
                  cursor: 'pointer', padding: '7px 9px', borderRadius: 6,
                  background: activeStep === i ? s.color + '12' : 'transparent',
                  border: `1px solid ${activeStep === i ? s.color + '55' : 'transparent'}`,
                  transition: 'all 0.2s',
                }}>
                <div style={{
                  width: 19, height: 19, borderRadius: '50%', flexShrink: 0,
                  background: activeStep === i ? s.color : '#08121e',
                  border: `1px solid ${activeStep === i ? s.color : '#1a3550'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 8, fontWeight: 700,
                  color: activeStep === i ? '#fff' : '#2a4060',
                  transition: 'all 0.2s',
                }}>
                  {i + 1}
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: activeStep === i ? s.color : '#4a6a88', marginBottom: activeStep === i ? 3 : 0 }}>
                    {s.label}
                  </div>
                  {activeStep === i && (
                    <div style={{ fontSize: 10, color: '#7a9ab8', lineHeight: 1.55 }}>{s.desc}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

const COMPONENT_DEFS = {
  hmi:        { id: 'hmi',        label: '7" HMI Panel',            sublabel: 'Operator Interface',          color: '#0ea5e9' },
  plc:        { id: 'plc',        label: 'Modicon M262 PLC',         sublabel: 'Central Controller',          color: '#22c55e' },
  cobot:      { id: 'cobot',      label: 'Lexium Cobot',             sublabel: 'Robotic Manipulation',        color: '#3b82f6' },
  eoat:       { id: 'eoat',       label: 'EoAT – Gripper 3 Dedos',  sublabel: 'Cilindro MAL16x25',           color: '#64748b' },
  canaleta:   { id: 'canaleta',   label: 'Canaleta de Alimentación', sublabel: 'Entrada de piezas',           color: '#f59e0b' },
  fixRem:     { id: 'fixRem',     label: 'Fixture de Remachado',     sublabel: '2 pistones de sujeción',      color: '#e11d48' },
  fixInsp:    { id: 'fixInsp',    label: 'Fixture de Inspección',    sublabel: 'Posicionamiento estable',     color: '#a855f7' },
  inspection: { id: 'inspection', label: 'Sistema de Inspección',    sublabel: 'Visión / Cognex 2800',        color: '#c026d3' },
  pistonRej:  { id: 'pistonRej',  label: 'Pistón de Rechazo',        sublabel: 'Eyección automática',         color: '#f97316' },
  canasta:    { id: 'canasta',    label: 'Bin de Rechazo',           sublabel: 'Destino FAIL',                color: '#dc2626' },
  stock:      { id: 'stock',      label: 'Stock Final',              sublabel: 'Destino PASS',                color: '#16a34a' },
} as const;

type CompId = keyof typeof COMPONENT_DEFS;

function getComponents(t: (k: string) => string) {
  return Object.fromEntries(
    Object.entries(COMPONENT_DEFS).map(([k, v]) => [k, { ...v, desc: t(`arch.comp.${k}`) }])
  ) as Record<CompId, typeof COMPONENT_DEFS[CompId] & { desc: string }>;
}

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

const STEP_DEFS = [
  { color: '#0ea5e9', nodes: ['hmi','plc'] as CompId[] },
  { color: '#f59e0b', nodes: ['plc','cobot','eoat','canaleta'] as CompId[] },
  { color: '#e11d48', nodes: ['plc','cobot','fixRem'] as CompId[] },
  { color: '#3b82f6', nodes: ['plc','cobot','eoat','fixRem'] as CompId[] },
  { color: '#a855f7', nodes: ['plc','cobot','fixInsp'] as CompId[] },
  { color: '#c026d3', nodes: ['inspection','fixInsp','plc','hmi'] as CompId[] },
  { color: '#dc2626', nodes: ['plc','fixInsp','pistonRej','canasta','hmi'] as CompId[] },
  { color: '#16a34a', nodes: ['plc','cobot','eoat','fixInsp','stock','hmi'] as CompId[] },
];

function getSteps(ta: (k: string) => string[]) {
  const lbls = ta('arch.flowLbls');
  const descs = ta('arch.flowDescs');
  return STEP_DEFS.map((s, i) => ({ ...s, label: lbls[i] ?? '', desc: descs[i] ?? '' }));
}

export default function ArchitectureDiagram() {
  const T = useTheme();
  const { t, ta } = useLanguage();
  const [activeNode, setActiveNode] = useState<CompId | null>(null);
  const [activeStep, setActiveStep] = useState<number | null>(null);

  const COMPONENTS = getComponents(t);
  const STEPS = getSteps(ta);

  const highlighted: CompId[] = activeStep !== null
    ? STEPS[activeStep].nodes
    : activeNode ? [activeNode] : [];

  const connLit = (c: typeof CONNECTIONS[0]) =>
    highlighted.length > 0 && highlighted.includes(c.from) && highlighted.includes(c.to);

  const stepColor = activeStep !== null ? STEPS[activeStep].color : '#22c55e';

  return (
    <div style={{
      background: T.bgGrad,
      borderTop: `1px solid ${T.border}`,
      borderBottom: `1px solid ${T.border}`,
    }}>
      {/* Section header */}
      <div style={{ padding: '32px 24px 0', textAlign: 'center' }}>
        <div style={{ fontSize: 9, letterSpacing: 5, color: '#22c55e', textTransform: 'uppercase', marginBottom: 8 }}>
          {t('arch.label')}
        </div>
        <div style={{ fontSize: 'clamp(20px,3vw,30px)', fontWeight: 700, color: T.text }}>
          {t('arch.title')}
        </div>
        <div style={{ fontSize: 12, color: T.muted, marginTop: 8 }}>
          {t('arch.hint')}
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
                <path d="M0,0 L6,3 L0,6 Z" fill={T.connLine} />
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
                    stroke={on ? stepColor : T.connLine}
                    strokeWidth={on ? 1.4 : 0.8}
                    strokeDasharray={on ? 'none' : '3 2'}
                    markerEnd={on ? 'url(#arr-on)' : 'url(#arr)'}
                    filter={on ? 'url(#glow)' : 'none'}
                    style={{ transition: 'all 0.3s' }} />
                  {c.bi && (
                    <line x1={t.x} y1={t.y} x2={f.x} y2={f.y}
                      stroke={on ? '#0ea5e9' : T.connLine}
                      strokeWidth={on ? 1.4 : 0.8}
                      strokeDasharray={on ? 'none' : '3 2'}
                      markerEnd={on ? 'url(#arr-on)' : 'url(#arr)'}
                      filter={on ? 'url(#glow)' : 'none'}
                      style={{ transition: 'all 0.3s' }} />
                  )}
                  {c.label && (
                    <text x={lx} y={ly} textAnchor="middle" fontSize="3"
                      fill={on ? '#86efac' : T.connLabel}
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
                    fill={inHL ? comp.color + '1a' : dim ? T.nodeBgDim : T.nodeBg}
                    stroke={inHL ? comp.color : dim ? T.nodeBorderDim : T.nodeBorder}
                    strokeWidth={inHL ? 1.0 : 0.5}
                    style={{ transition: 'all 0.3s' }} />
                  <rect x={BX} y={BY} width="2.5" height={BH} rx="1.2"
                    fill={inHL ? comp.color : dim ? T.nodeBorderDim : T.nodeBorder}
                    style={{ transition: 'all 0.3s' }} />
                  <text x={BX + 5} y="-1.2" fontSize="4.0"
                    fill={inHL ? (T.dark ? '#f1f5f9' : '#0f172a') : dim ? T.nodeTextDim : T.nodeText}
                    dominantBaseline="middle" fontWeight="700"
                    style={{ transition: 'all 0.3s' }}>
                    {comp.label}
                  </text>
                  <text x={BX + 5} y="4.2" fontSize="3.0"
                    fill={inHL ? comp.color : dim ? T.nodeSublabelDim : T.nodeSublabel}
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
            {(['#0ea5e9', '#22c55e', '#64748b'] as const).map((c, i) => (
              <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }}>
                <div style={{ width: 20, height: 2, background: c, borderRadius: 1 }} />
                <span style={{ color: T.muted }}>{ta('arch.leg')[i]}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right panel */}
        <div style={{ width: 308, borderLeft: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
          {/* Node detail */}
          <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.borderSoft}`, minHeight: 105 }}>
            <div style={{ fontSize: 9, letterSpacing: 3, color: T.dim, marginBottom: 7, textTransform: 'uppercase' }}>
              {activeNode ? t('arch.selectedComp') : t('arch.clickPrompt')}
            </div>
            {activeNode && COMPONENTS[activeNode] ? (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, color: COMPONENTS[activeNode].color, marginBottom: 5 }}>
                  {COMPONENTS[activeNode].label}
                </div>
                <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.65 }}>
                  {COMPONENTS[activeNode].desc}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: T.dim }}>
                {t('arch.clickHint')}
              </div>
            )}
          </div>

          {/* Flow steps */}
          <div style={{ padding: '12px 16px 16px', flex: 1 }}>
            <div style={{ fontSize: 9, letterSpacing: 3, color: T.dim, marginBottom: 10, textTransform: 'uppercase' }}>
              {t('arch.flowTitle')} · {STEPS.length} {t('arch.steps')}
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
                  background: activeStep === i ? s.color : T.panel,
                  border: `1px solid ${activeStep === i ? s.color : T.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 8, fontWeight: 700,
                  color: activeStep === i ? '#fff' : T.dim,
                  transition: 'all 0.2s',
                }}>
                  {i + 1}
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: activeStep === i ? s.color : T.muted, marginBottom: activeStep === i ? 3 : 0 }}>
                    {s.label}
                  </div>
                  {activeStep === i && (
                    <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.55 }}>{s.desc}</div>
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

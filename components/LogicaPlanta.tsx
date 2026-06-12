// ─────────────────────────────────────────────────────────────────────────────
// LogicaPlanta.tsx — Dashboard interactivo de documentación de la lógica de la
// celda de remachado (Schneider Digital Twin).
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useRef } from 'react';
import { useTheme, Theme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

const MONO = "'JetBrains Mono','Fira Code','IBM Plex Mono',monospace";
const SANS = '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif';

// Accent colors — same in both themes
const A = {
  green: '#22dd55', blue: '#3b8bff', orange: '#fb923c', purple: '#a78bfa',
  cyan: '#22d3ee', red: '#ff5566', amber: '#fbbf24',
};

// Combined color bag: theme tokens + accent constants
interface C extends Theme { card: string; green: string; blue: string; orange: string; purple: string; cyan: string; red: string; amber: string }
function makeC(T: Theme): C {
  return { ...T, card: T.dark ? '#101d30' : T.panel, ...A };
}

// ─── Tipos ───────────────────────────────────────────────────────────────────
interface Transition { to: string; label: string; condition?: string }
interface CellStateDef { label: string; color: string; glow: string; transitions: Transition[] }
interface CafiStateDef { label: string; color: string; group: string; transitions: Transition[] }

// ─── Data: estados de la CELDA (solo estructura estática) ────────────────────
const CELL_STATES: Record<string, CellStateDef> = {
  IDLE: {
    label: 'IDLE', color: '#64748b', glow: '#94a3b8',
    transitions: [{ to: 'RUNNING', label: '', condition: '' }],
  },
  RUNNING: {
    label: 'RUNNING', color: '#059669', glow: '#10b981',
    transitions: [
      { to: 'PAUSED', label: '', condition: '' },
      { to: 'FAULT', label: '', condition: '' },
    ],
  },
  PAUSED: {
    label: 'PAUSED', color: '#d97706', glow: '#f59e0b',
    transitions: [
      { to: 'RUNNING', label: '', condition: '' },
      { to: 'RESTARTING', label: '', condition: '' },
    ],
  },
  RESTARTING: {
    label: 'RESTARTING', color: '#7c3aed', glow: '#8b5cf6',
    transitions: [{ to: 'CLEANING_REQUIRED', label: '', condition: '' }],
  },
  CLEANING_REQUIRED: {
    label: 'CLEANING\nREQUIRED', color: '#dc2626', glow: '#ef4444',
    transitions: [{ to: 'IDLE', label: '', condition: '' }],
  },
  FAULT: {
    label: 'FAULT', color: '#b91c1c', glow: '#ef4444',
    transitions: [
      { to: 'CLEANING_REQUIRED', label: '', condition: '' },
      { to: 'IDLE', label: '', condition: '' },
    ],
  },
};

// ─── Data: estados del CAFI (solo estructura estática) ───────────────────────
const CAFI_STATES: Record<string, CafiStateDef> = {
  DISPENSED: { label: 'DISPENSED', color: '#0ea5e9', group: 'conveyor', transitions: [{ to: 'ON_CONVEYOR_WAITING', label: '' }] },
  ON_CONVEYOR_WAITING: { label: 'ON CONVEYOR\nWAITING', color: '#38bdf8', group: 'conveyor', transitions: [{ to: 'AT_SENSOR', label: '' }, { to: 'MANUAL_REMOVAL_REQUIRED', label: '' }] },
  AT_SENSOR: { label: 'AT SENSOR', color: '#0284c7', group: 'conveyor', transitions: [{ to: 'IN_GRIPPER', label: '' }, { to: 'MANUAL_REMOVAL_REQUIRED', label: '' }] },
  IN_GRIPPER: { label: 'IN GRIPPER', color: '#f59e0b', group: 'cobot', transitions: [{ to: 'IN_OUTSIDE_FIXTURE', label: '' }, { to: 'IN_INSPECTION', label: '' }, { to: 'ACCEPTED_BIN', label: '' }, { to: 'REJECTED_BIN', label: '' }] },
  IN_OUTSIDE_FIXTURE: { label: 'IN OUTSIDE\nFIXTURE', color: '#8b5cf6', group: 'mesa', transitions: [{ to: 'IN_RIVET_FIXTURE', label: '' }, { to: 'MANUAL_REMOVAL_REQUIRED', label: '' }] },
  IN_RIVET_FIXTURE: { label: 'IN RIVET\nFIXTURE', color: '#7c3aed', group: 'mesa', transitions: [{ to: 'RIVETING', label: '' }, { to: 'MANUAL_REMOVAL_REQUIRED', label: '' }] },
  RIVETING: { label: 'RIVETING\n(30 seg)', color: '#dc2626', group: 'remachado', transitions: [{ to: 'RIVETED', label: '' }] },
  RIVETED: { label: 'RIVETED', color: '#b45309', group: 'remachado', transitions: [{ to: 'IN_GRIPPER', label: '' }, { to: 'MANUAL_REMOVAL_REQUIRED', label: '' }] },
  IN_INSPECTION: { label: 'IN\nINSPECTION', color: '#0891b2', group: 'vision', transitions: [{ to: 'INSPECTED_PASS', label: '' }, { to: 'INSPECTED_FAIL', label: '' }, { to: 'MANUAL_REMOVAL_REQUIRED', label: '' }] },
  INSPECTED_PASS: { label: 'INSPECTED\nPASS', color: '#059669', group: 'vision', transitions: [{ to: 'ACCEPTED_BIN', label: '' }] },
  INSPECTED_FAIL: { label: 'INSPECTED\nFAIL', color: '#dc2626', group: 'vision', transitions: [{ to: 'REJECTED_BIN', label: '' }] },
  ACCEPTED_BIN: { label: 'ACCEPTED\nBIN', color: '#065f46', group: 'fin', transitions: [{ to: 'DONE', label: '' }] },
  REJECTED_BIN: { label: 'REJECTED\nBIN', color: '#7f1d1d', group: 'fin', transitions: [{ to: 'DONE', label: '' }] },
  MANUAL_REMOVAL_REQUIRED: { label: 'MANUAL\nREMOVAL', color: '#92400e', group: 'fin', transitions: [{ to: 'DONE', label: '' }] },
  DONE: { label: 'DONE', color: '#374151', group: 'fin', transitions: [] },
};

const GROUP_COLORS: Record<string, string> = { conveyor: '#0ea5e9', cobot: '#f59e0b', mesa: '#8b5cf6', remachado: '#ef4444', vision: '#06b6d4', fin: '#374151' };

const RULE_BLOCK_COLORS = ['#ef4444', '#f97316', '#dc2626', '#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#64748b'];

const COMP_COLORS = [A.amber, '#0ea5e9', A.orange, A.purple, A.red, '#06b6d4', A.green];

const SIGNALS_META: { name: string; io: 'IN' | 'OUT'; color: string }[] = [
  { name: 'sensor_conveyor_present', io: 'IN',  color: '#0ea5e9' },
  { name: 'fixtureA_limit',          io: 'IN',  color: A.purple  },
  { name: 'fixtureB_limit',          io: 'IN',  color: A.purple  },
  { name: 'table_home_limit',        io: 'IN',  color: A.amber   },
  { name: 'table_work_limit',        io: 'IN',  color: A.amber   },
  { name: 'vision_present',          io: 'IN',  color: '#06b6d4' },
  { name: 'vision_result',           io: 'IN',  color: '#06b6d4' },
  { name: 'gripper_open / closed',   io: 'OUT', color: A.orange  },
  { name: 'rivet_active',            io: 'OUT', color: A.red     },
  { name: 'table_rotate',            io: 'OUT', color: A.purple  },
  { name: 'conveyor_run',            io: 'OUT', color: '#0ea5e9' },
];

const FLOW_COLORS = ['#0ea5e9', A.orange, A.purple, A.red, '#06b6d4', A.green];

const TIMELINE_STATES = ['DISPENSED', 'AT_SENSOR', 'IN_GRIPPER', 'IN_OUTSIDE_FIXTURE', 'IN_RIVET_FIXTURE', 'RIVETING (30s)', 'RIVETED', 'IN_INSPECTION', 'INSPECTED_PASS', 'ACCEPTED_BIN'];

const SECTION_DEFS = [
  { id: 'resumen',     color: A.blue    },
  { id: 'flujo',       color: '#0ea5e9' },
  { id: 'componentes', color: A.orange  },
  { id: 'senales',     color: A.cyan    },
  { id: 'fixtures',    color: A.purple  },
  { id: 'celda',       color: A.green   },
  { id: 'cafi',        color: '#38bdf8' },
  { id: 'timeline',    color: A.amber   },
  { id: 'reglas',      color: A.red     },
  { id: 'seguridad',   color: '#f97316' },
];
function getSections(t: (k: string) => string) {
  return SECTION_DEFS.map((s) => ({ ...s, label: t(`logic.tabs.${s.id}`) }));
}

// ─── Componentes UI reutilizables ────────────────────────────────────────────
function Badge({ label, color, glow }: { label: string; color: string; glow?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 10.5, fontWeight: 800,
      letterSpacing: '0.05em', color, background: color + '1f', border: `1px solid ${color}66`,
      borderRadius: 5, padding: '3px 9px', whiteSpace: 'nowrap',
      boxShadow: glow ? `0 0 10px ${color}55` : 'none',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, boxShadow: `0 0 6px ${color}` }} />
      {label}
    </span>
  );
}

function Section({ id, title, color, refMap, children }: {
  id: string; title: string; color: string;
  refMap: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  children: React.ReactNode;
}) {
  const T = useTheme();
  return (
    <div ref={(el) => { refMap.current[id] = el; }} style={{ scrollMarginTop: 16, marginBottom: 30 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{ width: 4, height: 18, borderRadius: 2, background: color, boxShadow: `0 0 8px ${color}` }} />
        <h2 style={{ margin: 0, fontFamily: MONO, fontSize: 15, fontWeight: 800, color: T.text, letterSpacing: '0.02em' }}>{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Card({ accent, children, style }: { accent?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  const T = useTheme();
  const cardBg = T.dark ? '#101d30' : T.panel;
  return (
    <div style={{
      background: cardBg, border: `1px solid ${T.border}`,
      borderLeft: accent ? `3px solid ${accent}` : `1px solid ${T.border}`,
      borderRadius: 10, padding: 14, ...style,
    }}>{children}</div>
  );
}

function Accordion({ title, color, open, onToggle, children }: {
  title: string; color: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  const T = useTheme();
  const cardBg = T.dark ? '#101d30' : T.panel;
  return (
    <div style={{ background: cardBg, border: `1px solid ${T.border}`, borderLeft: `3px solid ${color}`, borderRadius: 10, overflow: 'hidden' }}>
      <button onClick={onToggle} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
        background: 'transparent', border: 'none', cursor: 'pointer', padding: '13px 16px',
        fontFamily: MONO, fontSize: 12.5, fontWeight: 700, color,
      }}>
        <span style={{
          width: 18, height: 18, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 4,
          border: `1px solid ${color}66`, color, fontSize: 12, transition: 'transform 0.2s',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>›</span>
        <span style={{ flex: 1, lineHeight: 1.4 }}>{title}</span>
      </button>
      {open && (
        <div style={{ padding: '0 16px 14px 44px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Component principal ─────────────────────────────────────────────────────
export default function LogicaPlanta() {
  const T = useTheme();
  const C = makeC(T);
  const { t, ta } = useLanguage();
  const SECTIONS = getSections(t);
  const refMap = useRef<Record<string, HTMLDivElement | null>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string>('resumen');

  const [selectedCafi, setSelectedCafi] = useState<string | null>(null);
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
  const [activeCafiState, setActiveCafiState] = useState<string>('DISPENSED');
  const [activeCellState, setActiveCellState] = useState<string>('IDLE');
  const [rivetProgress, setRivetProgress] = useState(0);
  const [isRiveting, setIsRiveting] = useState(false);
  const [openRules, setOpenRules] = useState<Record<number, boolean>>({ 0: true });

  useEffect(() => {
    if (!isRiveting) return;
    const start = performance.now();
    const interval = setInterval(() => {
      const p = Math.min((performance.now() - start) / 30000, 1);
      setRivetProgress(p);
      if (p >= 1) { setIsRiveting(false); setActiveCafiState('RIVETED'); }
    }, 100);
    return () => clearInterval(interval);
  }, [isRiveting]);

  const cafiState = (selectedCafi && CAFI_STATES[selectedCafi]) || CAFI_STATES[activeCafiState];
  const cellState = (selectedCell && CELL_STATES[selectedCell]) || CELL_STATES[activeCellState];
  const displayCafiKey = selectedCafi || activeCafiState;
  const displayCellKey = selectedCell || activeCellState;

  const handleCafiClick = (key: string) => { setSelectedCafi(key === selectedCafi ? null : key); if (key !== selectedCafi) setActiveCafiState(key); };
  const handleCellClick = (key: string) => { setSelectedCell(key === selectedCell ? null : key); if (key !== selectedCell) setActiveCellState(key); };
  const simulateStep = (toState: string) => {
    if (toState === 'RIVETING') { setActiveCafiState('RIVETING'); setSelectedCafi(null); setIsRiveting(true); setRivetProgress(0); }
    else { setActiveCafiState(toState); setSelectedCafi(null); }
  };
  const simulateCellStep = (toState: string) => { setActiveCellState(toState); setSelectedCell(null); };

  const scrollTo = (id: string) => {
    setActive(id);
    refMap.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const groupedCafi = Object.entries(CAFI_STATES).reduce<Record<string, Array<[string, CafiStateDef]>>>((acc, [k, v]) => {
    (acc[v.group] = acc[v.group] || []).push([k, v]); return acc;
  }, {});

  const kpiLabels = ta('logic.kpi');
  const flowLabels = ta('logic.flow');
  const signalDescs = ta('logic.signals');
  const timelineDescs = ta('logic.timeline');
  const secPriorities = ta('logic.secPriorities');

  return (
    <div style={{ height: '100%', display: 'flex', background: C.bg, fontFamily: SANS, color: C.text }}>
      {/* ── Sidebar índice ── */}
      <nav style={{
        width: 212, flexShrink: 0, borderRight: `1px solid ${C.border}`, padding: '18px 12px',
        background: `linear-gradient(180deg,${C.panel} 0%,${C.panel2} 100%)`, overflowY: 'auto',
      }}>
        <div style={{ padding: '0 8px 14px' }}>
          <div style={{ fontFamily: MONO, fontSize: 10, color: C.red, letterSpacing: '0.18em', fontWeight: 800 }}>SCHNEIDER</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginTop: 3, lineHeight: 1.25 }}>{t('logic.label')}</div>
          <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim, marginTop: 3, letterSpacing: '0.06em' }}>RIVETING CELL · DOCS</div>
        </div>
        {SECTIONS.map((s, i) => (
          <button key={s.id} onClick={() => scrollTo(s.id)} style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 9, textAlign: 'left',
            border: 'none', borderRadius: 7, cursor: 'pointer', padding: '8px 10px', marginBottom: 2,
            fontFamily: MONO, fontSize: 11.5, fontWeight: active === s.id ? 700 : 500,
            color: active === s.id ? C.text : C.muted,
            background: active === s.id ? s.color + '1f' : 'transparent',
            boxShadow: active === s.id ? `inset 2px 0 ${s.color}` : 'none',
            transition: 'background 0.15s,color 0.15s',
          }}
            onMouseEnter={(e) => { if (active !== s.id) e.currentTarget.style.background = C.dark ? '#16243a' : C.borderSoft; }}
            onMouseLeave={(e) => { if (active !== s.id) e.currentTarget.style.background = 'transparent'; }}
          >
            <span style={{ fontFamily: MONO, fontSize: 9, color: s.color, width: 16 }}>{String(i + 1).padStart(2, '0')}</span>
            {s.label}
          </button>
        ))}
      </nav>

      {/* ── Contenido ── */}
      <div ref={scrollRef} style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '24px 28px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>

          {/* 1 · RESUMEN */}
          <Section id="resumen" title={t('logic.tabs.resumen')} color={C.blue} refMap={refMap}>
            <Card accent={C.blue} style={{ marginBottom: 12 }}>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.7, color: C.muted }}>
                {t('logic.sum.para')}
              </p>
            </Card>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
              {[
                { k: '30 s', c: C.red },
                { k: '2', c: C.purple },
                { k: '2', c: '#0ea5e9' },
                { k: '≥ 5 cm', c: C.orange },
                { k: '6', c: C.green },
                { k: '15', c: '#38bdf8' },
              ].map((s, i) => (
                <Card key={i} accent={s.c} style={{ padding: '12px 14px' }}>
                  <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 800, color: s.c }}>{s.k}</div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{kpiLabels[i] ?? ''}</div>
                </Card>
              ))}
            </div>
          </Section>

          {/* 2 · FLUJO */}
          <Section id="flujo" title={t('logic.sec.flujo')} color="#0ea5e9" refMap={refMap}>
            <Card>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                {FLOW_COLORS.map((color, i) => (
                  <React.Fragment key={i}>
                    <div style={{
                      flex: '1 1 110px', minWidth: 96, textAlign: 'center', padding: '14px 8px',
                      background: color + '14', border: `1px solid ${color}55`, borderRadius: 9,
                    }}>
                      <div style={{ fontFamily: MONO, fontSize: 9, color, fontWeight: 700 }}>{String(i + 1).padStart(2, '0')}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginTop: 3 }}>{flowLabels[i] ?? ''}</div>
                    </div>
                    {i < FLOW_COLORS.length - 1 && <span style={{ color: C.dim, fontSize: 18, padding: '0 2px' }}>→</span>}
                  </React.Fragment>
                ))}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, marginTop: 12, lineHeight: 1.6 }}>
                {t('logic.sum.flowNote')}
              </div>
            </Card>
          </Section>

          {/* 3 · COMPONENTES */}
          <Section id="componentes" title={t('logic.sec.componentes')} color={C.orange} refMap={refMap}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10 }}>
              {COMP_COLORS.map((color, i) => (
                <Card key={i} accent={color}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: color, boxShadow: `0 0 7px ${color}` }} />
                    <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 800, color }}>{t(`logic.comps.${i}.name`)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.55 }}>{t(`logic.comps.${i}.role`)}</div>
                </Card>
              ))}
            </div>
          </Section>

          {/* 4 · SEÑALES I/O */}
          <Section id="senales" title={t('logic.sec.senales')} color={C.cyan} refMap={refMap}>
            <Card style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr', fontFamily: MONO, fontSize: 9.5, color: C.dim, letterSpacing: '0.1em', textTransform: 'uppercase', background: C.panel2, borderBottom: `1px solid ${C.border}`, padding: '8px 14px', fontWeight: 700 }}>
                <span>{t('logic.ui.io')}</span><span>{t('logic.ui.senalDesc')}</span>
              </div>
              {SIGNALS_META.map((s, i) => (
                <div key={s.name} style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 8, alignItems: 'center', padding: '9px 14px', borderBottom: i < SIGNALS_META.length - 1 ? `1px solid ${C.borderSoft}` : 'none' }}>
                  <span style={{
                    fontFamily: MONO, fontSize: 9, fontWeight: 800, textAlign: 'center', borderRadius: 4, padding: '2px 0',
                    color: s.io === 'IN' ? C.green : C.orange, background: (s.io === 'IN' ? C.green : C.orange) + '1c',
                    border: `1px solid ${(s.io === 'IN' ? C.green : C.orange)}55`,
                  }}>{s.io}</span>
                  <span>
                    <span style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: s.color }}>{s.name}</span>
                    <span style={{ fontSize: 11.5, color: C.muted }}> — {signalDescs[i] ?? ''}</span>
                  </span>
                </div>
              ))}
            </Card>
          </Section>

          {/* 5 · FIXTURES A/B */}
          <Section id="fixtures" title={t('logic.tabs.fixtures')} color={C.purple} refMap={refMap}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 10 }}>
              <Card accent={C.purple}>
                <Badge label="FIXTURE A" color={C.purple} />
                <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginTop: 8, marginBottom: 0 }}>
                  {t('logic.fixtureA')}
                </p>
              </Card>
              <Card accent={C.purple}>
                <Badge label="FIXTURE B" color={C.purple} />
                <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginTop: 8, marginBottom: 0 }}>
                  {t('logic.fixtureB')}
                </p>
              </Card>
              <Card accent={C.amber}>
                <Badge label="GIRO 180°" color={C.amber} />
                <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginTop: 8, marginBottom: 0 }}>
                  {t('logic.giro180')}
                </p>
              </Card>
            </div>
          </Section>

          {/* 6 · ESTADOS DE CELDA (interactivo) */}
          <Section id="celda" title={t('logic.tabs.celda')} color={C.green} refMap={refMap}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {Object.entries(CELL_STATES).map(([key, s]) => {
                const isActive = key === activeCellState;
                const isSelected = key === displayCellKey;
                return (
                  <button key={key} onClick={() => handleCellClick(key)} style={{
                    padding: '10px 16px', borderRadius: 8, cursor: 'pointer', fontFamily: MONO, fontSize: 12, fontWeight: 700,
                    letterSpacing: '0.04em', whiteSpace: 'pre', textAlign: 'center', transition: 'all 0.15s',
                    border: `1px solid ${isSelected || isActive ? s.color : C.border}`,
                    background: isSelected ? s.color + '24' : isActive ? s.color + '14' : C.card,
                    color: isActive || isSelected ? s.color : C.muted,
                    boxShadow: isActive ? `0 0 14px ${s.color}40` : 'none',
                    transform: isSelected ? 'translateY(-1px)' : 'none',
                  }}>
                    {s.label}
                    {isActive && <div style={{ fontSize: 8.5, color: s.color, marginTop: 3, fontWeight: 400 }}>{t('logic.ui.activoBadge')}</div>}
                  </button>
                );
              })}
            </div>
            <Card accent={cellState?.color}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <Badge label={displayCellKey} color={cellState?.color || C.dim} glow />
              </div>
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>{t(`logic.cell.${displayCellKey}.desc`)}</div>
              {(() => {
                const conds = ta(`logic.cell.${displayCellKey}.cond`);
                return conds.length > 0 ? (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.dim, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>{t('logic.ui.condiciones')}</div>
                    {conds.map((c, i) => (
                      <div key={i} style={{ fontSize: 12, color: C.muted, lineHeight: 1.7 }}><span style={{ color: cellState?.color }}>•</span> {c}</div>
                    ))}
                  </div>
                ) : null;
              })()}
              {cellState?.transitions?.length > 0 && (
                <>
                  <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.dim, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>{t('logic.ui.transClickSim')}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {cellState.transitions.map((tr, i) => {
                      const target = CELL_STATES[tr.to];
                      const transLabel = ta(`logic.cell.${displayCellKey}.trans`)[i] ?? '';
                      return (
                        <button key={i} onClick={() => simulateCellStep(tr.to)} style={{
                          display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', borderRadius: 7,
                          border: `1px solid ${(target?.color || C.dim)}44`, background: C.panel2, cursor: 'pointer',
                          fontFamily: MONO, fontSize: 12, textAlign: 'left', transition: 'background 0.15s',
                        }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = (target?.color || '#fff') + '14'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = C.panel2; }}
                        >
                          <span style={{ color: C.dim }}>→</span>
                          <span style={{ color: target?.color, fontWeight: 700, minWidth: 140 }}>{tr.to}</span>
                          <span style={{ color: C.muted, fontSize: 11 }}>{transLabel}</span>
                          <span style={{ marginLeft: 'auto', color: C.dim, fontSize: 10 }}>▶</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </Card>
          </Section>

          {/* 7 · ESTADOS DEL CAFI (interactivo) */}
          <Section id="cafi" title={t('logic.tabs.cafi')} color="#38bdf8" refMap={refMap}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontFamily: MONO, fontSize: 11, color: C.dim }}>
              {t('logic.ui.activoLabel')} <Badge label={activeCafiState} color={CAFI_STATES[activeCafiState]?.color || C.dim} />
              <span>{t('logic.ui.clickHint')}</span>
            </div>
            {activeCafiState === 'RIVETING' && (
              <Card accent={C.red} style={{ marginBottom: 12 }}>
                <div style={{ fontFamily: MONO, fontSize: 11, color: C.red, marginBottom: 6, letterSpacing: '0.1em' }}>{t('logic.ui.remActivo')} — {Math.round(rivetProgress * 30)}s / 30s</div>
                <div style={{ height: 7, background: C.panel2, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${rivetProgress * 100}%`, background: `linear-gradient(90deg,${C.red},${C.orange})`, borderRadius: 4, transition: 'width 0.1s' }} />
                </div>
              </Card>
            )}
            {Object.entries(groupedCafi).map(([group, items]) => (
              <div key={group} style={{ marginBottom: 14 }}>
                <div style={{ fontFamily: MONO, fontSize: 9.5, color: GROUP_COLORS[group], letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 7 }}>{t(`logic.groups.${group}`)}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                  {items.map(([key, s]) => {
                    const isActive = key === activeCafiState;
                    const isSelected = key === displayCafiKey;
                    return (
                      <button key={key} onClick={() => handleCafiClick(key)} style={{
                        padding: '7px 12px', borderRadius: 7, cursor: 'pointer', fontFamily: MONO, fontSize: 10.5,
                        fontWeight: isActive || isSelected ? 700 : 500, letterSpacing: '0.04em', whiteSpace: 'pre',
                        lineHeight: 1.35, textAlign: 'center', transition: 'all 0.15s',
                        border: `1px solid ${isSelected || isActive ? s.color : C.border}`,
                        background: isSelected ? s.color + '22' : isActive ? s.color + '12' : C.card,
                        color: isActive || isSelected ? s.color : C.muted,
                        boxShadow: isSelected ? `0 0 12px ${s.color}40` : 'none',
                      }}>{s.label}</button>
                    );
                  })}
                </div>
              </div>
            ))}
            <Card accent={cafiState?.color}>
              <Badge label={displayCafiKey} color={cafiState?.color || C.dim} glow />
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, margin: '8px 0 12px' }}>{t(`logic.cafi.${displayCafiKey}.desc`)}</div>
              {cafiState?.transitions?.length > 0 && (
                <>
                  <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.dim, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>{t('logic.ui.transiciones')}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                    {cafiState.transitions.map((tr, i) => {
                      const target = CAFI_STATES[tr.to];
                      const canSim = tr.to !== 'DONE';
                      const transLabel = ta(`logic.cafi.${displayCafiKey}.trans`)[i] ?? '';
                      return (
                        <button key={i} onClick={() => canSim && simulateStep(tr.to)} style={{
                          display: 'flex', alignItems: 'center', gap: 7, padding: '7px 11px', borderRadius: 6,
                          border: `1px solid ${(target?.color || C.dim)}44`, background: C.panel2,
                          cursor: canSim ? 'pointer' : 'default', fontFamily: MONO, fontSize: 11, transition: 'background 0.15s',
                        }}
                          onMouseEnter={(e) => { if (canSim) e.currentTarget.style.background = (target?.color || '#000') + '14'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = C.panel2; }}
                        >
                          <span style={{ color: C.dim }}>→</span>
                          <span style={{ color: target?.color || C.muted, fontWeight: 700 }}>{tr.to}</span>
                          {transLabel && <span style={{ color: C.dim, fontSize: 10 }}>· {transLabel}</span>}
                          {canSim && <span style={{ color: C.dim, fontSize: 10 }}>▶</span>}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </Card>
          </Section>

          {/* 8 · TIMELINE */}
          <Section id="timeline" title={t('logic.tabs.timeline')} color={C.amber} refMap={refMap}>
            <Card>
              <div style={{ position: 'relative', paddingLeft: 8 }}>
                {TIMELINE_STATES.map((state, i) => (
                  <div key={i} style={{ display: 'flex', gap: 12, paddingBottom: i < TIMELINE_STATES.length - 1 ? 14 : 0, position: 'relative' }}>
                    {i < TIMELINE_STATES.length - 1 && <span style={{ position: 'absolute', left: 7, top: 16, bottom: -2, width: 2, background: C.border }} />}
                    <span style={{ width: 16, height: 16, flexShrink: 0, borderRadius: '50%', background: C.bg, border: `2px solid ${C.amber}`, boxShadow: `0 0 8px ${C.amber}66`, marginTop: 1, zIndex: 1 }} />
                    <div>
                      <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: C.text }}>{state}</div>
                      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 1 }}>{timelineDescs[i] ?? ''}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </Section>

          {/* 9 · REGLAS (accordions) */}
          <Section id="reglas" title={t('logic.tabs.reglas')} color={C.red} refMap={refMap}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {RULE_BLOCK_COLORS.map((color, i) => (
                <Accordion key={i} title={t(`logic.ruleBlocks.${i}.title`)} color={color} open={!!openRules[i]} onToggle={() => setOpenRules((o) => ({ ...o, [i]: !o[i] }))}>
                  {ta(`logic.ruleBlocks.${i}.rules`).map((r, j) => (
                    <div key={j} style={{ fontFamily: MONO, fontSize: 11.5, color: C.muted, lineHeight: 1.6 }}>
                      <span style={{ color }}>→ </span>{r}
                    </div>
                  ))}
                </Accordion>
              ))}
            </div>
          </Section>

          {/* 10 · SEGURIDAD */}
          <Section id="seguridad" title={t('logic.tabs.seguridad')} color="#f97316" refMap={refMap}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10, marginBottom: 12 }}>
              <Card accent={C.red}>
                <Badge label="STOP" color={C.red} />
                <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginTop: 8, marginBottom: 0 }}>{t('logic.secCards.stop')}</p>
              </Card>
              <Card accent={C.green}>
                <Badge label="RESUME" color={C.green} />
                <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginTop: 8, marginBottom: 0 }}>{t('logic.secCards.resume')}</p>
              </Card>
              <Card accent={C.purple}>
                <Badge label="RESTART" color={C.purple} />
                <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginTop: 8, marginBottom: 0 }}>{t('logic.secCards.restart')}</p>
              </Card>
            </div>
            <Card accent="#f97316">
              <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.dim, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>{t('logic.ui.segPriorities')}</div>
              {secPriorities.map((r, i) => (
                <div key={i} style={{ fontSize: 12, color: C.muted, lineHeight: 1.8 }}><span style={{ color: '#f97316' }}>▸ </span>{r}</div>
              ))}
            </Card>
            <div style={{ height: 12 }} />
          </Section>

        </div>
      </div>
    </div>
  );
}

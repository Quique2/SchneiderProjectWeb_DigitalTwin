// ─────────────────────────────────────────────────────────────────────────────
// LogicaPlanta.tsx — Dashboard interactivo de documentación de la lógica de la
// celda de remachado (Schneider Digital Twin).
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useRef } from 'react';
import { useTheme, Theme } from '../context/ThemeContext';

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
interface CellStateDef { label: string; color: string; glow: string; desc: string; conditions: string[]; transitions: Transition[] }
interface CafiStateDef { label: string; color: string; group: string; desc: string; transitions: Transition[] }

// ─── Data: estados de la CELDA ───────────────────────────────────────────────
const CELL_STATES: Record<string, CellStateDef> = {
  IDLE: {
    label: 'IDLE', color: '#64748b', glow: '#94a3b8',
    desc: 'Planta detenida, esperando que el operador presione START.',
    conditions: ['Todos los sensores libres', 'Fixtures A y B vacíos', 'Sin FAULT activo'],
    transitions: [{ to: 'RUNNING', label: 'Operador presiona START', condition: 'Todos los sensores libres + no FAULT' }],
  },
  RUNNING: {
    label: 'RUNNING', color: '#059669', glow: '#10b981',
    desc: 'Planta en operación automática. La lógica de CAFIs, cobot y mesa está activa.',
    conditions: ['START presionado', 'Planta venía de IDLE', 'Sensores libres confirmados'],
    transitions: [
      { to: 'PAUSED', label: 'STOP presionado', condition: 'Siempre permitido' },
      { to: 'FAULT', label: 'Error crítico', condition: 'Colisión / sensor inesperado' },
    ],
  },
  PAUSED: {
    label: 'PAUSED', color: '#d97706', glow: '#f59e0b',
    desc: 'Todo detenido por STOP. El operador debe elegir: RESUME o RESTART.',
    conditions: ['STOP fue presionado desde RUNNING'],
    transitions: [
      { to: 'RUNNING', label: 'RESUME', condition: 'No hay FAULT, estado es recuperable' },
      { to: 'RESTARTING', label: 'RESTART', condition: 'Siempre disponible después de STOP' },
    ],
  },
  RESTARTING: {
    label: 'RESTARTING', color: '#7c3aed', glow: '#8b5cf6',
    desc: 'Recuperación segura. Si cobot tiene pieza → bin de rechazo. Si no → HOME lento.',
    conditions: ['RESTART fue elegido desde PAUSED'],
    transitions: [{ to: 'CLEANING_REQUIRED', label: 'Cobot llegó a HOME', condition: 'Recuperación completada' }],
  },
  CLEANING_REQUIRED: {
    label: 'CLEANING\nREQUIRED', color: '#dc2626', glow: '#ef4444',
    desc: 'El operador debe retirar TODOS los CAFIs manualmente y confirmar limpieza.',
    conditions: ['Viene de RESTARTING', 'Hay CAFIs en fixtures o conveyor'],
    transitions: [{ to: 'IDLE', label: 'Operador confirma limpieza', condition: 'fixtureA=libre, fixtureB=libre, sensor=libre, visión=libre' }],
  },
  FAULT: {
    label: 'FAULT', color: '#b91c1c', glow: '#ef4444',
    desc: 'Falla crítica. Requiere intervención del operador y reset manual.',
    conditions: ['Error crítico detectado', 'Colisión / sensor inconsistente'],
    transitions: [
      { to: 'CLEANING_REQUIRED', label: 'Reset de falla con piezas', condition: 'Operador hace reset' },
      { to: 'IDLE', label: 'Reset limpio', condition: 'No hay piezas + operador confirma' },
    ],
  },
};

// ─── Data: estados del CAFI ──────────────────────────────────────────────────
const CAFI_STATES: Record<string, CafiStateDef> = {
  DISPENSED: { label: 'DISPENSED', color: '#0ea5e9', group: 'conveyor', desc: 'El CAFI acaba de caer del dispensador al conveyor.', transitions: [{ to: 'ON_CONVEYOR_WAITING', label: 'Conveyor en RUNNING' }] },
  ON_CONVEYOR_WAITING: { label: 'ON CONVEYOR\nWAITING', color: '#38bdf8', group: 'conveyor', desc: 'En el conveyor, moviéndose hacia el sensor. Máximo 2 CAFIs pueden estar esperando.', transitions: [{ to: 'AT_SENSOR', label: 'Sensor fotoeléctrico detecta CAFI' }, { to: 'MANUAL_REMOVAL_REQUIRED', label: 'RESTART activado' }] },
  AT_SENSOR: { label: 'AT SENSOR', color: '#0284c7', group: 'conveyor', desc: 'Sensor fotoeléctrico ocupado. Conveyor detenido. Cobot puede tomar si fixture externo está libre.', transitions: [{ to: 'IN_GRIPPER', label: 'Cobot hace pick' }, { to: 'MANUAL_REMOVAL_REQUIRED', label: 'RESTART activado' }] },
  IN_GRIPPER: { label: 'IN GRIPPER', color: '#f59e0b', group: 'cobot', desc: 'Cobot sostiene el CAFI. Gripper cerrado.', transitions: [{ to: 'IN_OUTSIDE_FIXTURE', label: 'Cobot place en fixture externo' }, { to: 'IN_INSPECTION', label: 'Viene de RIVETED → lleva a cámara' }, { to: 'ACCEPTED_BIN', label: 'CAFI inspeccionado PASS' }, { to: 'REJECTED_BIN', label: 'CAFI inspeccionado FAIL o RESTART' }] },
  IN_OUTSIDE_FIXTURE: { label: 'IN OUTSIDE\nFIXTURE', color: '#8b5cf6', group: 'mesa', desc: 'CAFI colocado en fixture externo. Limit switch confirmó presencia.', transitions: [{ to: 'IN_RIVET_FIXTURE', label: 'Mesa gira 180°' }, { to: 'MANUAL_REMOVAL_REQUIRED', label: 'RESTART activado' }] },
  IN_RIVET_FIXTURE: { label: 'IN RIVET\nFIXTURE', color: '#7c3aed', group: 'mesa', desc: 'Mesa giró. Este fixture ahora está en zona de remachado.', transitions: [{ to: 'RIVETING', label: 'rivetFixturePresent=true + mesa detenida' }, { to: 'MANUAL_REMOVAL_REQUIRED', label: 'RESTART activado' }] },
  RIVETING: { label: 'RIVETING\n(30 seg)', color: '#dc2626', group: 'remachado', desc: 'Remachado activo durante 30 segundos exactos. Mesa bloqueada.', transitions: [{ to: 'RIVETED', label: '30 segundos completados' }] },
  RIVETED: { label: 'RIVETED', color: '#b45309', group: 'remachado', desc: 'Remachado terminado. Cobot debe retirarlo. Prioridad absoluta.', transitions: [{ to: 'IN_GRIPPER', label: 'Cobot hace pick del CAFI remachado' }, { to: 'MANUAL_REMOVAL_REQUIRED', label: 'RESTART activado' }] },
  IN_INSPECTION: { label: 'IN\nINSPECTION', color: '#0891b2', group: 'vision', desc: 'Cobot colocó el CAFI en la cámara. Inspección en curso.', transitions: [{ to: 'INSPECTED_PASS', label: 'vision_result = PASS' }, { to: 'INSPECTED_FAIL', label: 'vision_result = FAIL' }, { to: 'MANUAL_REMOVAL_REQUIRED', label: 'RESTART activado' }] },
  INSPECTED_PASS: { label: 'INSPECTED\nPASS', color: '#059669', group: 'vision', desc: 'Cámara dijo PASS. Cobot lo coloca en bin de aceptados.', transitions: [{ to: 'ACCEPTED_BIN', label: 'Cobot place en bin aceptado' }] },
  INSPECTED_FAIL: { label: 'INSPECTED\nFAIL', color: '#dc2626', group: 'vision', desc: 'Cámara dijo FAIL. Cobot lo coloca en bin de rechazados.', transitions: [{ to: 'REJECTED_BIN', label: 'Cobot place en bin rechazado' }] },
  ACCEPTED_BIN: { label: 'ACCEPTED\nBIN', color: '#065f46', group: 'fin', desc: 'CAFI colocado en bin de aceptados. Ciclo terminado.', transitions: [{ to: 'DONE', label: '' }] },
  REJECTED_BIN: { label: 'REJECTED\nBIN', color: '#7f1d1d', group: 'fin', desc: 'CAFI colocado en bin de rechazados. Ciclo terminado.', transitions: [{ to: 'DONE', label: '' }] },
  MANUAL_REMOVAL_REQUIRED: { label: 'MANUAL\nREMOVAL', color: '#92400e', group: 'fin', desc: 'CAFI quedó atrapado en RESTART. El operador debe retirarlo físicamente.', transitions: [{ to: 'DONE', label: 'Operador retira + confirma limpieza' }] },
  DONE: { label: 'DONE', color: '#374151', group: 'fin', desc: 'Ciclo terminado. El CAFI salió del sistema.', transitions: [] },
};

const GROUP_COLORS: Record<string, string> = { conveyor: '#0ea5e9', cobot: '#f59e0b', mesa: '#8b5cf6', remachado: '#ef4444', vision: '#06b6d4', fin: '#374151' };
const GROUP_LABELS: Record<string, string> = { conveyor: 'Conveyor', cobot: 'Cobot', mesa: 'Mesa Giratoria', remachado: 'Remachado', vision: 'Inspección', fin: 'Final' };

interface RuleBlock { color: string; title: string; rules: string[] }
const RULE_BLOCKS: RuleBlock[] = [
  { color: '#ef4444', title: 'STOP detiene TODO, sin excepciones', rules: ['Conveyor se detiene', 'Cobot pausa rutina', 'Mesa inhibida', 'Remachado bloqueado', 'No se aceptan nuevos CAFIs', 'Planta: PAUSED'] },
  { color: '#f97316', title: 'No puede existir ni una sola colisión — mínimo 5 cm de separación', rules: ['Mesa solo gira cuando cobot_in_table_zone = false', 'Cobot solo entra a zona de fixture cuando mesa está completamente detenida Y confirmada por limit switch', 'Si distancia cobot-obstáculo < 5 cm → FAULT inmediato', 'Nunca mover mesa Y cobot simultáneamente si alguno está en zona de riesgo'] },
  { color: '#dc2626', title: 'Remachado: exactamente 30 segundos', rules: ['RIVET_ACTIVE dura 30,000 ms exactos', 'Mostrar barra de progreso en HMI', 'Mesa bloqueada durante todo el remachado', 'Solo inicia si rivetFixturePresent = true'] },
  { color: '#8b5cf6', title: 'CAFI remachado tiene prioridad absoluta', rules: ['Desde IN_GRIPPER (viene de RIVETED) → el cobot no atiende conveyor', 'Debe completar: llevar a inspección → esperar resultado → colocar en bin', 'Nada interrumpe este flujo excepto STOP'] },
  { color: '#0ea5e9', title: 'Fixture externo: el cobot solo va al conveyor si está libre', rules: ['outsideFixtureAvailable = !outsideFixturePresent', 'outsideFixturePresent = limit switch del fixture que actualmente está afuera', 'Si fixture A está afuera → outsideFixturePresent = fixtureA_limit', 'Si fixture B está afuera → outsideFixturePresent = fixtureB_limit'] },
  { color: '#10b981', title: 'Máximo 2 CAFIs esperando en conveyor', rules: ['DISPENSED + ON_CONVEYOR_WAITING + AT_SENSOR = máx 2', 'No se permite alimentar si ya hay 2 esperando', 'El dispensador respeta el límite aunque la planta esté en RUNNING'] },
  { color: '#f59e0b', title: 'Dos CAFIs en el disco simultáneamente', rules: ['Fixture A puede tener CAFI en RIVETING mientras Fixture B recibe un nuevo CAFI', 'Al girar la mesa, los roles se intercambian automáticamente', 'outsideFixtureId y rivetFixtureId se actualizan después de cada giro de 180°', 'El cobot puede trabajar con ambos fixtures en paralelo respetando el orden de prioridad'] },
  { color: '#64748b', title: 'Después de RESTART: limpieza obligatoria antes de START', rules: ['fixtureA_limit debe estar libre (false)', 'fixtureB_limit debe estar libre (false)', 'sensor_conveyor_present debe estar libre (false)', 'vision_present debe estar libre (false)', 'Operador confirma limpieza → Sistema verifica → IDLE → START'] },
];

const COMPONENTS_DATA = [
  { name: 'Dispensador CAFI', color: A.amber, role: 'Suelta piezas CAFI crudas al conveyor (máx 2 en cola).' },
  { name: 'Conveyor', color: '#0ea5e9', role: 'Transporta el CAFI hasta el sensor fotoeléctrico de pick.' },
  { name: 'Cobot Lexium', color: A.orange, role: '6 ejes. Pick/place: conveyor → fixture → cámara → bins.' },
  { name: 'Mesa rotatoria', color: A.purple, role: '2 fixtures A/B; gira 180° e intercambia roles (carga ↔ remachado).' },
  { name: 'Remachadora', color: A.red, role: 'Remacha el CAFI en el fixture interno durante 30 s exactos.' },
  { name: 'Cámara de visión', color: '#06b6d4', role: 'Inspecciona el CAFI remachado → veredicto PASS / FAIL.' },
  { name: 'Bins', color: A.green, role: 'Destino final: bin de aceptados (PASS) o rechazados (FAIL).' },
];

const SIGNALS_DATA: { name: string; io: 'IN' | 'OUT'; desc: string; color: string }[] = [
  { name: 'sensor_conveyor_present', io: 'IN', desc: 'Sensor fotoeléctrico: CAFI en posición de pick.', color: '#0ea5e9' },
  { name: 'fixtureA_limit', io: 'IN', desc: 'Limit switch presencia de CAFI en fixture A.', color: A.purple },
  { name: 'fixtureB_limit', io: 'IN', desc: 'Limit switch presencia de CAFI en fixture B.', color: A.purple },
  { name: 'table_home_limit', io: 'IN', desc: 'Limit switch: mesa en posición HOME (0°).', color: A.amber },
  { name: 'table_work_limit', io: 'IN', desc: 'Limit switch: mesa en posición WORK (180°).', color: A.amber },
  { name: 'vision_present', io: 'IN', desc: 'CAFI presente en el plato de la cámara.', color: '#06b6d4' },
  { name: 'vision_result', io: 'IN', desc: 'Veredicto de la cámara: PASS / FAIL.', color: '#06b6d4' },
  { name: 'gripper_open / closed', io: 'OUT', desc: 'Estado del gripper neumático del cobot (DO).', color: A.orange },
  { name: 'rivet_active', io: 'OUT', desc: 'Comando de remachado (30 s); mesa bloqueada.', color: A.red },
  { name: 'table_rotate', io: 'OUT', desc: 'Comando de giro 180° de la mesa.', color: A.purple },
  { name: 'conveyor_run', io: 'OUT', desc: 'Avance del conveyor (se detiene en AT_SENSOR / STOP).', color: '#0ea5e9' },
];

const FLOW_DATA = [
  { label: 'Conveyor', color: '#0ea5e9' },
  { label: 'Cobot', color: A.orange },
  { label: 'Fixture', color: A.purple },
  { label: 'Remachado', color: A.red },
  { label: 'Visión', color: '#06b6d4' },
  { label: 'Bin', color: A.green },
];

const TIMELINE = [
  { t: 'DISPENSED', d: 'CAFI cae del dispensador' },
  { t: 'AT_SENSOR', d: 'Llega al sensor; conveyor para' },
  { t: 'IN_GRIPPER', d: 'Cobot hace pick' },
  { t: 'IN_OUTSIDE_FIXTURE', d: 'Place en fixture externo' },
  { t: 'IN_RIVET_FIXTURE', d: 'Mesa gira 180°' },
  { t: 'RIVETING (30s)', d: 'Remachado, mesa bloqueada' },
  { t: 'RIVETED', d: 'Cobot retira (prioridad)' },
  { t: 'IN_INSPECTION', d: 'Cobot lleva a cámara' },
  { t: 'INSPECTED_PASS', d: 'Veredicto PASS' },
  { t: 'ACCEPTED_BIN', d: 'Cobot coloca en bin' },
];

const SECTIONS = [
  { id: 'resumen',     label: 'Resumen',              color: A.blue    },
  { id: 'flujo',       label: 'Flujo de producción',  color: '#0ea5e9' },
  { id: 'componentes', label: 'Componentes',           color: A.orange  },
  { id: 'senales',     label: 'Sensores y señales',    color: A.cyan    },
  { id: 'fixtures',    label: 'Fixtures A / B',        color: A.purple  },
  { id: 'celda',       label: 'Estados de celda',      color: A.green   },
  { id: 'cafi',        label: 'Estados del CAFI',      color: '#38bdf8' },
  { id: 'timeline',    label: 'Timeline del ciclo',    color: A.amber   },
  { id: 'reglas',      label: 'Reglas de bloqueo',     color: A.red     },
  { id: 'seguridad',   label: 'STOP · Prioridades',    color: '#f97316' },
] as const;

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

  return (
    <div style={{ height: '100%', display: 'flex', background: C.bg, fontFamily: SANS, color: C.text }}>
      {/* ── Sidebar índice ── */}
      <nav style={{
        width: 212, flexShrink: 0, borderRight: `1px solid ${C.border}`, padding: '18px 12px',
        background: `linear-gradient(180deg,${C.panel} 0%,${C.panel2} 100%)`, overflowY: 'auto',
      }}>
        <div style={{ padding: '0 8px 14px' }}>
          <div style={{ fontFamily: MONO, fontSize: 10, color: C.red, letterSpacing: '0.18em', fontWeight: 800 }}>SCHNEIDER</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginTop: 3, lineHeight: 1.25 }}>Lógica de la celda</div>
          <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim, marginTop: 3, letterSpacing: '0.06em' }}>RIVETING CELL · DOCS</div>
        </div>
        {SECTIONS.map((s, i) => (
          <button key={s.id} onClick={() => scrollTo(s.id)} style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 9, textAlign: 'left',
            border: 'none', borderRadius: 7, cursor: 'pointer', padding: '8px 10px', marginBottom: 2,
            fontFamily: MONO, fontSize: 11.5, fontWeight: active === s.id ? 700 : 500,
            color: active === s.id ? C.text : C.muted,
            background: active === s.id ? s.color + '1f' : 'transparent',
            boxShadow: active === s.id ? `inset 2px 0 0 ${s.color}` : 'none',
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
          <Section id="resumen" title="Resumen del proceso" color={C.blue} refMap={refMap}>
            <Card accent={C.blue} style={{ marginBottom: 12 }}>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.7, color: C.muted }}>
                Celda automática de remachado. Una pieza <b style={{ color: C.text }}>CAFI</b> recorre:
                dispensador → conveyor → <b style={{ color: C.orange }}>cobot</b> →
                <b style={{ color: C.purple }}> mesa rotatoria (fixture A/B)</b> →
                <b style={{ color: C.red }}> remachado (30 s)</b> → <b style={{ color: C.cyan }}>visión</b> →
                <b style={{ color: C.green }}> bin</b> (aceptado / rechazado). La planta opera como una
                máquina de estados; <b style={{ color: C.text }}>STOP</b> detiene todo y exige RESUME o RESTART.
              </p>
            </Card>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
              {[
                { k: '30 s', v: 'Remachado exacto', c: C.red },
                { k: '2', v: 'CAFIs máx en disco', c: C.purple },
                { k: '2', v: 'CAFIs máx en conveyor', c: '#0ea5e9' },
                { k: '≥ 5 cm', v: 'Separación anti-colisión', c: C.orange },
                { k: '6', v: 'Estados de celda', c: C.green },
                { k: '15', v: 'Estados del CAFI', c: '#38bdf8' },
              ].map((s, i) => (
                <Card key={i} accent={s.c} style={{ padding: '12px 14px' }}>
                  <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 800, color: s.c }}>{s.k}</div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{s.v}</div>
                </Card>
              ))}
            </div>
          </Section>

          {/* 2 · FLUJO */}
          <Section id="flujo" title="Flujo de producción" color="#0ea5e9" refMap={refMap}>
            <Card>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                {FLOW_DATA.map((n, i) => (
                  <React.Fragment key={n.label}>
                    <div style={{
                      flex: '1 1 110px', minWidth: 96, textAlign: 'center', padding: '14px 8px',
                      background: n.color + '14', border: `1px solid ${n.color}55`, borderRadius: 9,
                    }}>
                      <div style={{ fontFamily: MONO, fontSize: 9, color: n.color, fontWeight: 700 }}>{String(i + 1).padStart(2, '0')}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginTop: 3 }}>{n.label}</div>
                    </div>
                    {i < FLOW_DATA.length - 1 && <span style={{ color: C.dim, fontSize: 18, padding: '0 2px' }}>→</span>}
                  </React.Fragment>
                ))}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, marginTop: 12, lineHeight: 1.6 }}>
                El cobot también <b style={{ color: C.muted }}>retira</b> el CAFI remachado del fixture y lo lleva a
                visión; el CAFI remachado tiene <b style={{ color: C.purple }}>prioridad absoluta</b> sobre el conveyor.
              </div>
            </Card>
          </Section>

          {/* 3 · COMPONENTES */}
          <Section id="componentes" title="Componentes principales" color={C.orange} refMap={refMap}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10 }}>
              {COMPONENTS_DATA.map((c) => (
                <Card key={c.name} accent={c.color}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: c.color, boxShadow: `0 0 7px ${c.color}` }} />
                    <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 800, color: c.color }}>{c.name}</span>
                  </div>
                  <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.55 }}>{c.role}</div>
                </Card>
              ))}
            </div>
          </Section>

          {/* 4 · SEÑALES I/O */}
          <Section id="senales" title="Sensores y señales (I/O)" color={C.cyan} refMap={refMap}>
            <Card style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr', fontFamily: MONO, fontSize: 9.5, color: C.dim, letterSpacing: '0.1em', textTransform: 'uppercase', background: C.panel2, borderBottom: `1px solid ${C.border}`, padding: '8px 14px', fontWeight: 700 }}>
                <span>I/O</span><span>Señal · descripción</span>
              </div>
              {SIGNALS_DATA.map((s, i) => (
                <div key={s.name} style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 8, alignItems: 'center', padding: '9px 14px', borderBottom: i < SIGNALS_DATA.length - 1 ? `1px solid ${C.borderSoft}` : 'none' }}>
                  <span style={{
                    fontFamily: MONO, fontSize: 9, fontWeight: 800, textAlign: 'center', borderRadius: 4, padding: '2px 0',
                    color: s.io === 'IN' ? C.green : C.orange, background: (s.io === 'IN' ? C.green : C.orange) + '1c',
                    border: `1px solid ${(s.io === 'IN' ? C.green : C.orange)}55`,
                  }}>{s.io}</span>
                  <span>
                    <span style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: s.color }}>{s.name}</span>
                    <span style={{ fontSize: 11.5, color: C.muted }}> — {s.desc}</span>
                  </span>
                </div>
              ))}
            </Card>
          </Section>

          {/* 5 · FIXTURES A/B */}
          <Section id="fixtures" title="Fixtures A / B y limit switches" color={C.purple} refMap={refMap}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 10 }}>
              <Card accent={C.purple}>
                <Badge label="FIXTURE A" color={C.purple} />
                <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginTop: 8, marginBottom: 0 }}>
                  Confirmado por <b style={{ color: C.text }}>fixtureA_limit</b>. Puede estar en zona de carga
                  (externa) o de remachado según el giro de la mesa.
                </p>
              </Card>
              <Card accent={C.purple}>
                <Badge label="FIXTURE B" color={C.purple} />
                <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginTop: 8, marginBottom: 0 }}>
                  Confirmado por <b style={{ color: C.text }}>fixtureB_limit</b>. Mientras A remacha, B puede recibir
                  un nuevo CAFI (2 piezas en el disco a la vez).
                </p>
              </Card>
              <Card accent={C.amber}>
                <Badge label="GIRO 180°" color={C.amber} />
                <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginTop: 8, marginBottom: 0 }}>
                  Al girar, los roles se intercambian: <b style={{ color: C.text }}>outsideFixtureId</b> ↔
                  <b style={{ color: C.text }}> rivetFixtureId</b>. Limit switches <b style={{ color: C.text }}>table_home</b> /
                  <b style={{ color: C.text }}> table_work</b> confirman la posición.
                </p>
              </Card>
            </div>
          </Section>

          {/* 6 · ESTADOS DE CELDA (interactivo) */}
          <Section id="celda" title="Estados de la celda" color={C.green} refMap={refMap}>
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
                    {isActive && <div style={{ fontSize: 8.5, color: s.color, marginTop: 3, fontWeight: 400 }}>● activo</div>}
                  </button>
                );
              })}
            </div>
            <Card accent={cellState?.color}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <Badge label={displayCellKey} color={cellState?.color || C.dim} glow />
              </div>
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>{cellState?.desc}</div>
              {cellState?.conditions?.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.dim, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>Condiciones</div>
                  {cellState.conditions.map((c, i) => (
                    <div key={i} style={{ fontSize: 12, color: C.muted, lineHeight: 1.7 }}><span style={{ color: cellState.color }}>•</span> {c}</div>
                  ))}
                </div>
              )}
              {cellState?.transitions?.length > 0 && (
                <>
                  <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.dim, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>Transiciones · click para simular</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {cellState.transitions.map((t, i) => {
                      const target = CELL_STATES[t.to];
                      return (
                        <button key={i} onClick={() => simulateCellStep(t.to)} style={{
                          display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', borderRadius: 7,
                          border: `1px solid ${(target?.color || C.dim)}44`, background: C.panel2, cursor: 'pointer',
                          fontFamily: MONO, fontSize: 12, textAlign: 'left', transition: 'background 0.15s',
                        }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = (target?.color || '#fff') + '14'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = C.panel2; }}
                        >
                          <span style={{ color: C.dim }}>→</span>
                          <span style={{ color: target?.color, fontWeight: 700, minWidth: 140 }}>{t.to}</span>
                          <span style={{ color: C.muted, fontSize: 11 }}>{t.label}</span>
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
          <Section id="cafi" title="Estados del CAFI" color="#38bdf8" refMap={refMap}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontFamily: MONO, fontSize: 11, color: C.dim }}>
              Activo: <Badge label={activeCafiState} color={CAFI_STATES[activeCafiState]?.color || C.dim} />
              <span>· click en estado para explorar, en transición para simular</span>
            </div>
            {activeCafiState === 'RIVETING' && (
              <Card accent={C.red} style={{ marginBottom: 12 }}>
                <div style={{ fontFamily: MONO, fontSize: 11, color: C.red, marginBottom: 6, letterSpacing: '0.1em' }}>REMACHADO ACTIVO — {Math.round(rivetProgress * 30)}s / 30s</div>
                <div style={{ height: 7, background: C.panel2, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${rivetProgress * 100}%`, background: `linear-gradient(90deg,${C.red},${C.orange})`, borderRadius: 4, transition: 'width 0.1s' }} />
                </div>
              </Card>
            )}
            {Object.entries(groupedCafi).map(([group, items]) => (
              <div key={group} style={{ marginBottom: 14 }}>
                <div style={{ fontFamily: MONO, fontSize: 9.5, color: GROUP_COLORS[group], letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 7 }}>{GROUP_LABELS[group]}</div>
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
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, margin: '8px 0 12px' }}>{cafiState?.desc}</div>
              {cafiState?.transitions?.length > 0 && (
                <>
                  <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.dim, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>Transiciones</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                    {cafiState.transitions.map((t, i) => {
                      const target = CAFI_STATES[t.to];
                      const canSim = t.to !== 'DONE';
                      return (
                        <button key={i} onClick={() => canSim && simulateStep(t.to)} style={{
                          display: 'flex', alignItems: 'center', gap: 7, padding: '7px 11px', borderRadius: 6,
                          border: `1px solid ${(target?.color || C.dim)}44`, background: C.panel2,
                          cursor: canSim ? 'pointer' : 'default', fontFamily: MONO, fontSize: 11, transition: 'background 0.15s',
                        }}
                          onMouseEnter={(e) => { if (canSim) e.currentTarget.style.background = (target?.color || '#000') + '14'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = C.panel2; }}
                        >
                          <span style={{ color: C.dim }}>→</span>
                          <span style={{ color: target?.color || C.muted, fontWeight: 700 }}>{t.to}</span>
                          {t.label && <span style={{ color: C.dim, fontSize: 10 }}>· {t.label}</span>}
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
          <Section id="timeline" title="Timeline del ciclo (camino aceptado)" color={C.amber} refMap={refMap}>
            <Card>
              <div style={{ position: 'relative', paddingLeft: 8 }}>
                {TIMELINE.map((step, i) => (
                  <div key={i} style={{ display: 'flex', gap: 12, paddingBottom: i < TIMELINE.length - 1 ? 14 : 0, position: 'relative' }}>
                    {i < TIMELINE.length - 1 && <span style={{ position: 'absolute', left: 7, top: 16, bottom: -2, width: 2, background: C.border }} />}
                    <span style={{ width: 16, height: 16, flexShrink: 0, borderRadius: '50%', background: C.bg, border: `2px solid ${C.amber}`, boxShadow: `0 0 8px ${C.amber}66`, marginTop: 1, zIndex: 1 }} />
                    <div>
                      <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: C.text }}>{step.t}</div>
                      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 1 }}>{step.d}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </Section>

          {/* 9 · REGLAS (accordions) */}
          <Section id="reglas" title="Reglas de bloqueo (interlocks)" color={C.red} refMap={refMap}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {RULE_BLOCKS.map((block, i) => (
                <Accordion key={i} title={block.title} color={block.color} open={!!openRules[i]} onToggle={() => setOpenRules((o) => ({ ...o, [i]: !o[i] }))}>
                  {block.rules.map((r, j) => (
                    <div key={j} style={{ fontFamily: MONO, fontSize: 11.5, color: C.muted, lineHeight: 1.6 }}>
                      <span style={{ color: block.color }}>→ </span>{r}
                    </div>
                  ))}
                </Accordion>
              ))}
            </div>
          </Section>

          {/* 10 · SEGURIDAD */}
          <Section id="seguridad" title="STOP / RESUME / RESTART · prioridades de seguridad" color="#f97316" refMap={refMap}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10, marginBottom: 12 }}>
              <Card accent={C.red}>
                <Badge label="STOP" color={C.red} />
                <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginTop: 8, marginBottom: 0 }}>Detiene TODO al instante: conveyor, cobot, mesa, remachado. Planta → PAUSED.</p>
              </Card>
              <Card accent={C.green}>
                <Badge label="RESUME" color={C.green} />
                <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginTop: 8, marginBottom: 0 }}>Reanuda desde PAUSED si el estado es recuperable y no hay FAULT.</p>
              </Card>
              <Card accent={C.purple}>
                <Badge label="RESTART" color={C.purple} />
                <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginTop: 8, marginBottom: 0 }}>Recuperación segura → CLEANING_REQUIRED. El operador retira CAFIs y confirma limpieza.</p>
              </Card>
            </div>
            <Card accent="#f97316">
              <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.dim, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>Prioridades de seguridad</div>
              {[
                'Seguridad sobre productividad: ante duda → FAULT.',
                'Anti-colisión: mesa y cobot nunca se mueven juntos en zona de riesgo (≥ 5 cm).',
                'CAFI remachado: prioridad absoluta hasta llegar a un bin.',
                'Remachado: 30 s exactos, mesa bloqueada.',
                'Tras RESTART: limpieza obligatoria antes de un nuevo START.',
              ].map((r, i) => (
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

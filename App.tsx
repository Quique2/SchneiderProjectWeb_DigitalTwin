import React, { useEffect, useState } from 'react';
import HeroSection from './components/HeroSection';
import CellViewer3D from './components/CellViewer3D';
import CobotLiveView from './components/CobotLiveView';
import WiringDiagram from './components/WiringDiagram';
import LogicaPlanta from './components/LogicaPlanta';
import ScadaView from './components/scada/ScadaView';
import ArchitectureDiagram from './components/ArchitectureDiagram';
import SpecsGrid from './components/SpecsGrid';
import Footer from './components/Footer';
import { ThemeProvider, useThemeCtx } from './context/ThemeContext';

type TabId = 'inicio' | 'wiring' | 'cell' | 'live' | 'logic' | 'scada';
interface TabDef { id: TabId; label: string }

const TABS: TabDef[] = [
  { id: 'inicio',  label: 'Inicio' },
  { id: 'wiring',  label: 'Cableado' },
  { id: 'cell',    label: 'Celda 3D' },
  { id: 'live',    label: 'Cobot en Vivo' },
  { id: 'logic',   label: 'Lógica' },
  { id: 'scada',   label: 'SCADA' },
];

const TOPBAR_HEIGHT = 60;

function readScadaStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.hash === '#scada' || window.location.search.includes('scada');
}

function openScadaPage(): void {
  window.open('https://digitaltwinwebordo-production.up.railway.app/#scada', '_blank', 'noopener');
}

const SANS_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO_FONT =
  '"JetBrains Mono", "Fira Code", "IBM Plex Mono", "Courier New", monospace';

export default function App() {
  const [standalone] = useState(readScadaStandalone);
  if (standalone) return <ScadaView />;
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}

function AppShell() {
  const { T, isDark, toggle } = useThemeCtx();
  const [tab, setTab] = useState<TabId>('inicio');

  useEffect(() => {
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.height = '100%';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.background = T.bg;
    document.body.style.overflow = 'hidden';
    document.body.style.height = '100%';
    document.body.style.fontFamily = SANS_FONT;
    const root = document.getElementById('root');
    if (root) { root.style.overflow = 'hidden'; root.style.height = '100%'; }
    const style = document.createElement('style');
    style.textContent = `
      .mono { font-family: ${MONO_FONT}; font-variant-numeric: tabular-nums; }
      ::selection { background: rgba(184,115,51,0.45); color: #fff; }
    `;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, [T.bg]);

  return (
    <div style={{
      fontFamily: SANS_FONT,
      background: T.bg,
      color: T.text,
      height: '100vh',
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      margin: 0,
      padding: 0,
      boxSizing: 'border-box',
    }}>
      {/* === TOP BAR === */}
      <header style={{
        height: TOPBAR_HEIGHT,
        flexShrink: 0,
        background: T.topbar,
        borderBottom: `1px solid ${T.topbarBorder}`,
        boxShadow: isDark ? '0 4px 18px rgba(0,0,0,0.35)' : '0 2px 8px rgba(0,0,0,0.06)',
        display: 'flex',
        alignItems: 'stretch',
        padding: '0 20px',
        position: 'relative',
        gap: 8,
      }}>
        {/* green accent rule */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 2,
          background: 'linear-gradient(90deg,#22c55e 0%,#16a34a 30%,transparent 100%)',
        }} />

        {/* Brand */}
        <div style={{
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
          minWidth: 200, gap: 1,
        }}>
          <div style={{ fontSize: 9, letterSpacing: 3.5, color: '#22c55e', textTransform: 'uppercase', fontWeight: 600 }}>
            Gemelo Digital · V60
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: T.text, letterSpacing: -0.2 }}>
            Schneider Riveting Cell
          </div>
        </div>

        {/* Tabs */}
        <nav style={{ display: 'flex', gap: 4, flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button key={t.id}
                onClick={() => { if (t.id === 'scada') openScadaPage(); else setTab(t.id); }}
                style={{
                  position: 'relative',
                  background: active ? 'rgba(184,115,51,0.12)' : 'transparent',
                  color: active ? T.text : T.muted,
                  border: 'none',
                  padding: '0 16px',
                  height: '100%',
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                  letterSpacing: 1.2,
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  transition: 'color 0.15s, background 0.15s',
                }}
                onMouseEnter={(e) => { if (!active) (e.currentTarget.style.color = T.text); }}
                onMouseLeave={(e) => { if (!active) (e.currentTarget.style.color = T.muted); }}>
                {t.label}{t.id === 'scada' ? ' ↗' : ''}
                {active && (
                  <div style={{
                    position: 'absolute', left: 12, right: 12, bottom: 0, height: 2,
                    background: 'linear-gradient(90deg,#d97740 0%,#b87333 100%)',
                    borderRadius: 1,
                  }} />
                )}
              </button>
            );
          })}
        </nav>

        {/* Right side: theme toggle + credit */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 200, justifyContent: 'flex-end' }}>
          {/* Light / Dark toggle */}
          <div style={{
            display: 'flex', gap: 2,
            background: T.panel2,
            border: `1px solid ${T.border}`,
            borderRadius: 6, padding: 2,
          }}>
            <button
              onClick={() => isDark && toggle()}
              style={{
                padding: '4px 10px', borderRadius: 4, border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                background: !isDark ? '#3b82f6' : 'transparent',
                color: !isDark ? '#fff' : T.muted,
                transition: 'all 0.15s',
              }}
            >☀ Light</button>
            <button
              onClick={() => !isDark && toggle()}
              style={{
                padding: '4px 10px', borderRadius: 4, border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                background: isDark ? (T.panel) : 'transparent',
                color: isDark ? '#7ab4f0' : T.muted,
                transition: 'all 0.15s',
              }}
            >☽ Dark</button>
          </div>

          {/* Credit */}
          <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'right', gap: 2 }}>
            <div style={{ fontSize: 11, color: T.text, fontWeight: 500 }}>Equipo 3</div>
            <div style={{ fontSize: 9, letterSpacing: 1.5, color: T.muted, textTransform: 'uppercase' }}>
              ITESM × Schneider Challenge 3.0
            </div>
          </div>
        </div>
      </header>

      {/* === ACTIVE TAB CONTENT === */}
      <main style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        {tab === 'inicio' && (
          <ScrollHost>
            <HeroSection />
            <ArchitectureDiagram />
            <SpecsGrid />
            <Footer />
          </ScrollHost>
        )}
        {tab === 'wiring' && <ScrollHost><WiringDiagram /></ScrollHost>}
        {tab === 'cell'   && <CellViewer3D />}
        {tab === 'live'   && <CobotLiveView />}
        {tab === 'logic'  && <LogicaPlanta />}
        {tab === 'scada'  && <ScadaView />}
      </main>
    </div>
  );
}

function ScrollHost({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
      {children}
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import HeroSection from './components/HeroSection';
import CellViewer3D from './components/CellViewer3D';
import WiringDiagram from './components/WiringDiagram';
import ArchitectureDiagram from './components/ArchitectureDiagram';
import SpecsGrid from './components/SpecsGrid';
import Footer from './components/Footer';

type TabId = 'cell' | 'inicio' | 'wiring' | 'arch' | 'specs';

interface TabDef {
  id: TabId;
  label: string;
  icon: string;
}

const TABS: TabDef[] = [
  { id: 'cell',    label: 'Celda 3D',     icon: '🤖' },
  { id: 'inicio',  label: 'Inicio',       icon: '🏠' },
  { id: 'wiring',  label: 'Cableado',     icon: '🔌' },
  { id: 'arch',    label: 'Arquitectura', icon: '🏗' },
  { id: 'specs',   label: 'Specs',        icon: '📊' },
];

const TOPBAR_HEIGHT = 56;

export default function App() {
  const [tab, setTab] = useState<TabId>('cell');

  useEffect(() => {
    // React Native Web sets overflow:hidden on html/body/root — override it.
    // For the tabbed layout we want the page to BE the viewport (no scroll
    // on the shell itself; each tab manages its own scrolling).
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.height = '100%';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.background = '#06101c';
    document.body.style.overflow = 'hidden';
    document.body.style.height = '100%';
    const root = document.getElementById('root');
    if (root) {
      root.style.overflow = 'hidden';
      root.style.height = '100%';
    }
  }, []);

  return (
    <div style={{
      fontFamily: "'IBM Plex Mono','Courier New',monospace",
      background: '#06101c',
      color: '#e2e8f0',
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
        background: 'linear-gradient(180deg,#0a1422 0%,#06101c 100%)',
        borderBottom: '1px solid #1a3550',
        display: 'flex',
        alignItems: 'center',
        padding: '0 20px',
        gap: 24,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 220 }}>
          <div style={{ fontSize: 8, letterSpacing: 4, color: '#22c55e', textTransform: 'uppercase' }}>
            Gemelo Digital · V60
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#f1f5f9', lineHeight: 1.1 }}>
            Schneider Riveting Cell
          </div>
        </div>

        <nav style={{ display: 'flex', gap: 2, flex: 1, justifyContent: 'center' }}>
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                background: active
                  ? 'linear-gradient(180deg,#b87333 0%,#8b5a25 100%)'
                  : 'transparent',
                color: active ? '#fff' : '#9bb0c8',
                border: '1px solid ' + (active ? '#b87333' : '#1d2c44'),
                borderRadius: 5,
                padding: '8px 16px',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1.2,
                cursor: 'pointer',
                fontFamily: 'inherit',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                transition: 'background 0.15s, color 0.15s',
              }}>
                <span style={{ fontSize: 13 }}>{t.icon}</span>
                {t.label}
              </button>
            );
          })}
        </nav>

        <div style={{
          minWidth: 220, textAlign: 'right', fontSize: 10, color: '#456',
          fontFamily: 'monospace',
        }}>
          Equipo 3 · ITESM × Schneider 3.0
        </div>
      </header>

      {/* === ACTIVE TAB CONTENT === */}
      <main style={{
        flex: 1,
        minHeight: 0, // critical so the child can shrink to fit instead of pushing the shell
        overflow: 'hidden',
        position: 'relative',
      }}>
        {tab === 'cell'   && <CellViewer3D />}
        {tab === 'inicio' && <ScrollHost><HeroSection /></ScrollHost>}
        {tab === 'wiring' && <ScrollHost><WiringDiagram /></ScrollHost>}
        {tab === 'arch'   && <ScrollHost><ArchitectureDiagram /></ScrollHost>}
        {tab === 'specs'  && <ScrollHost><SpecsGrid /><Footer /></ScrollHost>}
      </main>
    </div>
  );
}

// Tabs other than the cell viewer keep their original full-page layouts; wrap
// them in a scrolling host so they don't blow out the fixed viewport.
function ScrollHost({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
      {children}
    </div>
  );
}

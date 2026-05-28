import React, { useEffect, useState } from 'react';
import HeroSection from './components/HeroSection';
import CellViewer3D from './components/CellViewer3D';
import CobotLiveView from './components/CobotLiveView';
import WiringDiagram from './components/WiringDiagram';
import ArchitectureDiagram from './components/ArchitectureDiagram';
import SpecsGrid from './components/SpecsGrid';
import Footer from './components/Footer';

type TabId = 'inicio' | 'wiring' | 'cell' | 'live';

interface TabDef {
  id: TabId;
  label: string;
}

// INICIO is the landing tab — it scrolls through Hero → Architecture →
// Specs → Footer the way the old single-page layout did.  CABLEADO and
// CELDA 3D are dedicated full-viewport views.
const TABS: TabDef[] = [
  { id: 'inicio',  label: 'Inicio' },
  { id: 'wiring',  label: 'Cableado' },
  { id: 'cell',    label: 'Celda 3D' },
  { id: 'live',    label: 'Cobot en Vivo' },
];

const TOPBAR_HEIGHT = 60;

// System sans-serif stack picks the OS-native UI font (SF Pro on macOS,
// Segoe UI on Windows, Roboto on Android/ChromeOS) so the chrome looks
// native and professional without shipping a font file.
const SANS_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO_FONT =
  '"JetBrains Mono", "Fira Code", "IBM Plex Mono", "Courier New", monospace';

export default function App() {
  const [tab, setTab] = useState<TabId>('inicio');

  useEffect(() => {
    // React Native Web sets overflow:hidden on html/body/root — override it.
    // The shell IS the viewport here; each tab manages its own scrolling.
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.height = '100%';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.background = '#06101c';
    document.body.style.overflow = 'hidden';
    document.body.style.height = '100%';
    document.body.style.fontFamily = SANS_FONT;
    const root = document.getElementById('root');
    if (root) {
      root.style.overflow = 'hidden';
      root.style.height = '100%';
    }
    // Inject a small style block so children can opt into the mono stack
    // via the .mono utility class — keeps numeric readouts aligned.
    const style = document.createElement('style');
    style.textContent = `
      .mono { font-family: ${MONO_FONT}; font-variant-numeric: tabular-nums; }
      ::selection { background: rgba(184,115,51,0.45); color: #fff; }
    `;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, []);

  return (
    <div style={{
      fontFamily: SANS_FONT,
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
        background: 'linear-gradient(180deg,#0c1a2c 0%,#070f1a 100%)',
        borderBottom: '1px solid #1a2c44',
        boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'stretch',
        padding: '0 28px',
        position: 'relative',
      }}>
        {/* thin green accent rule along the very top edge */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 2,
          background: 'linear-gradient(90deg,#22c55e 0%,#16a34a 30%,transparent 100%)',
        }} />

        {/* Brand */}
        <div style={{
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
          minWidth: 240, gap: 1,
        }}>
          <div style={{
            fontSize: 9, letterSpacing: 3.5, color: '#22c55e',
            textTransform: 'uppercase', fontWeight: 600,
          }}>
            Gemelo Digital · V60
          </div>
          <div style={{
            fontSize: 16, fontWeight: 600, color: '#f1f5f9',
            letterSpacing: -0.2,
          }}>
            Schneider Riveting Cell
          </div>
        </div>

        {/* Tabs */}
        <nav style={{
          display: 'flex', gap: 4, flex: 1,
          justifyContent: 'center', alignItems: 'center',
        }}>
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                position: 'relative',
                background: active ? 'rgba(184,115,51,0.12)' : 'transparent',
                color: active ? '#f1f5f9' : '#8a9bb4',
                border: 'none',
                padding: '0 18px',
                height: '100%',
                fontSize: 12,
                fontWeight: active ? 600 : 500,
                letterSpacing: 1.2,
                textTransform: 'uppercase',
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'color 0.15s, background 0.15s',
              }}
                onMouseEnter={(e) => { if (!active) (e.currentTarget.style.color = '#dde4f0'); }}
                onMouseLeave={(e) => { if (!active) (e.currentTarget.style.color = '#8a9bb4'); }}>
                {t.label}
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

        {/* Credit */}
        <div style={{
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
          minWidth: 240, textAlign: 'right', gap: 2,
        }}>
          <div style={{ fontSize: 11, color: '#dde4f0', fontWeight: 500 }}>
            Equipo 3
          </div>
          <div style={{ fontSize: 9, letterSpacing: 1.5, color: '#5a6c84', textTransform: 'uppercase' }}>
            ITESM × Schneider Challenge 3.0
          </div>
        </div>
      </header>

      {/* === ACTIVE TAB CONTENT === */}
      <main style={{
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        position: 'relative',
      }}>
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

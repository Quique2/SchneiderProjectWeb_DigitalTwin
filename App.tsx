import React, { useEffect, useState } from 'react';
import HeroSection from './components/HeroSection';
import CellViewer3D from './components/CellViewer3D';
import CobotLiveView from './components/CobotLiveView';
import WiringDiagram from './components/WiringDiagram';
import LogicaPlanta from './components/LogicaPlanta';
import ScadaView from './components/scada/ScadaView';
import ScadaSimView from './components/scadaSimLocal/ScadaSimView';
import ArchitectureDiagram from './components/ArchitectureDiagram';
import SpecsGrid from './components/SpecsGrid';
import Footer from './components/Footer';
import LoginScreen from './components/LoginScreen';
import { ThemeProvider, useThemeCtx } from './context/ThemeContext';
import { LanguageProvider, useLanguage } from './context/LanguageContext';
import { AuthProvider, useAuth, ROLE_TABS } from './context/AuthContext';
import { LANG_LABELS, Lang } from './translations';

type TabId = 'inicio' | 'wiring' | 'cell' | 'live' | 'logic' | 'scada' | 'scadasim';
interface TabDef { id: TabId; labelKey: string }

const TABS: TabDef[] = [
  { id: 'inicio',    labelKey: 'app.tabs.home' },
  { id: 'wiring',   labelKey: 'app.tabs.wiring' },
  { id: 'cell',     labelKey: 'app.tabs.cell3d' },
  { id: 'live',     labelKey: 'app.tabs.cobotLive' },
  { id: 'logic',    labelKey: 'app.tabs.logic' },
  { id: 'scada',    labelKey: 'app.tabs.scada' },
  { id: 'scadasim', labelKey: 'app.tabs.scadaSim' },
];

const EXTERNAL_TABS = new Set<TabId>(['scada', 'scadasim']);

const TOPBAR_HEIGHT = 60;

function readStandalone(): 'scada' | 'scada-sim' | null {
  if (typeof window === 'undefined') return null;
  const h = window.location.hash;
  if (h === '#scada-sim' || window.location.search.includes('scada-sim')) return 'scada-sim';
  if (h === '#scada'     || window.location.search.includes('scada'))     return 'scada';
  return null;
}

function openHashPage(hash: string): void {
  const { origin, pathname } = window.location;
  window.open(`${origin}${pathname}#${hash}`, '_blank', 'noopener');
}

const SANS_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO_FONT =
  '"JetBrains Mono", "Fira Code", "IBM Plex Mono", "Courier New", monospace';

const FULLSCREEN: React.CSSProperties = { position: 'fixed', inset: 0, overflow: 'hidden' };

export default function App() {
  const [standalone] = useState(readStandalone);
  if (standalone === 'scada')     return <div style={FULLSCREEN}><ScadaView /></div>;
  if (standalone === 'scada-sim') return <div style={FULLSCREEN}><ScadaSimView /></div>;
  return (
    <ThemeProvider>
      <LanguageProvider>
        <AuthProvider>
          <AppShell />
        </AuthProvider>
      </LanguageProvider>
    </ThemeProvider>
  );
}

function AppShell() {
  const { T, isDark, toggle } = useThemeCtx();
  const { t, lang, setLang } = useLanguage();
  const { user, logout } = useAuth();
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

  if (!user) return <LoginScreen />;
  const allowedTabs = TABS.filter((td) => ROLE_TABS[user.role].includes(td.id));

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
            {t('app.brandLabel')}
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: T.text, letterSpacing: -0.2 }}>
            {t('app.brandTitle')}
          </div>
        </div>

        {/* Tabs */}
        <nav style={{ display: 'flex', gap: 4, flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          {allowedTabs.map((tabDef) => {
            const active = tabDef.id === tab;
            return (
              <button key={tabDef.id}
                onClick={() => { if (EXTERNAL_TABS.has(tabDef.id)) openHashPage(tabDef.id === 'scadasim' ? 'scada-sim' : tabDef.id); else setTab(tabDef.id); }}
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
                {t(tabDef.labelKey)}{EXTERNAL_TABS.has(tabDef.id) ? ' ↗' : ''}
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

        {/* Right side: language selector + theme toggle + credit */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 200, justifyContent: 'flex-end' }}>

          {/* Language selector */}
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value as Lang)}
            style={{
              background: T.panel2, border: `1px solid ${T.border}`, borderRadius: 6,
              color: T.text, fontSize: 11, fontWeight: 600, padding: '5px 6px',
              cursor: 'pointer', fontFamily: 'inherit', outline: 'none',
            }}
          >
            {(Object.keys(LANG_LABELS) as Lang[]).map((l) => (
              <option key={l} value={l}>{LANG_LABELS[l]}</option>
            ))}
          </select>

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
            >☀ {t('app.themeLight')}</button>
            <button
              onClick={() => !isDark && toggle()}
              style={{
                padding: '4px 10px', borderRadius: 4, border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                background: isDark ? (T.panel) : 'transparent',
                color: isDark ? '#7ab4f0' : T.muted,
                transition: 'all 0.15s',
              }}
            >☽ {t('app.themeDark')}</button>
          </div>

          {/* User badge + logout */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'right', gap: 1 }}>
              <span style={{ fontSize: 11, color: T.text, fontWeight: 600 }}>{user.email.split('@')[0]}</span>
              <span style={{
                fontSize: 9, letterSpacing: 1.5, textTransform: 'uppercase', fontWeight: 700,
                color: user.role === 'ADMIN' ? '#d97740' : user.role === 'DEMO' ? '#22c55e' : '#7ab4f0',
              }}>{user.role}</span>
            </div>
            <button
              onClick={logout}
              title="Cerrar sesión"
              style={{
                background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 6,
                color: T.muted, fontSize: 11, fontWeight: 600, padding: '5px 10px',
                cursor: 'pointer', fontFamily: 'inherit', transition: 'color 0.15s, border-color 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.borderColor = '#f87171'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = T.muted; e.currentTarget.style.borderColor = T.border; }}
            >↩ Salir</button>
          </div>

          {/* Credit */}
          <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'right', gap: 2 }}>
            <div style={{ fontSize: 11, color: T.text, fontWeight: 500 }}>{t('app.team')}</div>
            <div style={{ fontSize: 9, letterSpacing: 1.5, color: T.muted, textTransform: 'uppercase' }}>
              {t('app.challenge')}
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

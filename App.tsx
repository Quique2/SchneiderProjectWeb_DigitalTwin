import React, { useEffect } from 'react';
import HeroSection from './components/HeroSection';
import CellViewer3D from './components/CellViewer3D';
import WiringDiagram from './components/WiringDiagram';
import ArchitectureDiagram from './components/ArchitectureDiagram';
import SpecsGrid from './components/SpecsGrid';
import Footer from './components/Footer';

export default function App() {
  // Force full-width dark background on the document root in web
  useEffect(() => {
    // React Native Web sets overflow:hidden on html/body/root — override it
    document.documentElement.style.overflow = 'auto';
    document.documentElement.style.height = 'auto';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.background = '#06101c';
    document.body.style.overflow = 'auto';
    document.body.style.height = 'auto';
    const root = document.getElementById('root');
    if (root) {
      root.style.overflow = 'auto';
      root.style.height = 'auto';
    }
  }, []);

  return (
    <div style={{
      fontFamily: "'IBM Plex Mono','Courier New',monospace",
      background: '#06101c',
      color: '#e2e8f0',
      minHeight: '100vh',
      width: '100%',
      margin: 0,
      padding: 0,
      boxSizing: 'border-box',
      overflow: 'visible',
    }}>
      <HeroSection />
      <CellViewer3D />
      <WiringDiagram />
      <ArchitectureDiagram />
      <SpecsGrid />
      <Footer />
    </div>
  );
}

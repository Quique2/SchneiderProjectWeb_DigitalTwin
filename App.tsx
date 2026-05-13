import React from 'react';
import HeroSection from './components/HeroSection';
import CellViewer3D from './components/CellViewer3D';
import ArchitectureDiagram from './components/ArchitectureDiagram';
import SpecsGrid from './components/SpecsGrid';
import Footer from './components/Footer';

export default function App() {
  return (
    <div style={{
      fontFamily: "'IBM Plex Mono','Courier New',monospace",
      background: '#06101c',
      color: '#e2e8f0',
      minHeight: '100vh',
      margin: 0,
      padding: 0,
    }}>
      <HeroSection />
      <CellViewer3D />
      <ArchitectureDiagram />
      <SpecsGrid />
      <Footer />
    </div>
  );
}

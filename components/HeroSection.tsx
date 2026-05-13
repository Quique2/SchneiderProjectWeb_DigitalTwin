import React, { useEffect, useState } from 'react';

const WORDS = ['Remachado', 'Inspección', 'Automatización'];

export default function HeroSection() {
  const [wordIdx, setWordIdx] = useState(0);
  const [fade, setFade] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setWordIdx(i => (i + 1) % WORDS.length);
        setFade(true);
      }, 350);
    }, 2600);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      background: 'linear-gradient(160deg,#06101c 0%,#0b1829 60%,#040c14 100%)',
      borderBottom: '1px solid #1a3550',
      position: 'relative',
      overflow: 'hidden',
      padding: '0 24px',
      textAlign: 'center',
    }}>
      {/* Background grid */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'linear-gradient(rgba(34,197,94,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(34,197,94,0.03) 1px,transparent 1px)',
        backgroundSize: '60px 60px',
        pointerEvents: 'none',
      }} />

      {/* Top badge */}
      <div style={{
        fontSize: 10, letterSpacing: 5, color: '#22c55e',
        textTransform: 'uppercase', marginBottom: 24,
        background: 'rgba(34,197,94,0.08)',
        border: '1px solid rgba(34,197,94,0.2)',
        padding: '6px 20px', borderRadius: 99,
      }}>
        Schneider Electric · ITESM Challenge 3.0 · Equipo 3
      </div>

      {/* Main title */}
      <div style={{ fontSize: 'clamp(28px,5vw,60px)', fontWeight: 700, color: '#f1f5f9', lineHeight: 1.15, maxWidth: 860 }}>
        Celda Semi-Automatizada de{' '}
        <span style={{
          color: '#22c55e',
          transition: 'opacity 0.35s ease',
          opacity: fade ? 1 : 0,
          display: 'inline-block',
          minWidth: 220,
        }}>
          {WORDS[wordIdx]}
        </span>
        {' '}de CAFIs
      </div>

      {/* Subtitle */}
      <div style={{ marginTop: 24, fontSize: 'clamp(13px,1.8vw,17px)', color: '#4a6a88', maxWidth: 700, lineHeight: 1.75 }}>
        Propuesta de solución integral: Lexium Cobot + Modicon M262 PLC + sistema de visión Cognex 2800.
        Cero configuración requerida — explora el gemelo digital directamente en tu browser.
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 40, marginTop: 52, flexWrap: 'wrap', justifyContent: 'center' }}>
        {[
          { value: '3', label: 'Pick & Place Ops' },
          { value: '5', label: 'Puntos de Remache' },
          { value: '100%', label: 'Inspección Visual' },
          { value: '0', label: 'Setup Requerido' },
        ].map(({ value, label }) => (
          <div key={label} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 'clamp(28px,4vw,44px)', fontWeight: 700, color: '#22c55e', lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: 10, color: '#2a4060', letterSpacing: 2, textTransform: 'uppercase', marginTop: 6 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Scroll indicator */}
      <div style={{ position: 'absolute', bottom: 32, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <div style={{ fontSize: 9, letterSpacing: 3, color: '#1a3550', textTransform: 'uppercase' }}>Explorar</div>
        <div style={{ width: 1, height: 40, background: 'linear-gradient(#22c55e,transparent)' }} />
      </div>
    </div>
  );
}

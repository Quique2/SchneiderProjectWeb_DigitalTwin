import React, { useEffect, useRef, useState } from 'react';

// Generado desde diagramadeconexiones.dxf (diagram_tools/dxf_to_svg.py).
// Los cables principales del DXF están sin color de función (ACI 7); se
// muestran como "Cableado principal". El color por tipo de cable solo existe
// en las entidades de acento + el bloque 2D insertado (GPIO/conectores/pines).
const WIRE_GROUPS = [
  { hex: '#9FB3C8', label: 'Cableado principal', count: 12636 },
  { hex: '#6B7480', label: 'Estructura',          count:   50 },
  { hex: '#00FF00', label: 'GPIO (bloque)',       count:   47 },
  { hex: '#00FFFF', label: 'Conectores (bloque)', count:   41 },
  { hex: '#A953A0', label: 'Motores aux.',        count:   20 },
  { hex: '#FFFF00', label: 'Pines (bloque)',      count:   20 },
  { hex: '#58BA48', label: 'Switch',              count:   18 },
  { hex: '#CD2027', label: '+24 V',               count:   18 },
  { hex: '#F7F281', label: 'Señal (amarillo)',    count:   12 },
  { hex: '#2776BB', label: 'Comunicación',        count:   11 },
  { hex: '#ED1F24', label: '+24 V (alt)',         count:   10 },
  { hex: '#FF0000', label: 'Rojo',                count:    8 },
  { hex: '#7AAFDF', label: 'Azul claro',          count:    5 },
  { hex: '#F26722', label: 'Señales (naranja)',   count:    3 },
  { hex: '#F8991E', label: 'Señales (ámbar)',     count:    3 },
];

const ALL_HEX = new Set(WIRE_GROUPS.map(w => w.hex));

export default function WiringDiagram() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Set<string>>(new Set(ALL_HEX));
  const [loaded, setLoaded] = useState(false);

  // Load SVG once into DOM
  useEffect(() => {
    fetch('/diagram.svg')
      .then(r => r.text())
      .then(html => {
        if (containerRef.current) {
          containerRef.current.innerHTML = html;
          setLoaded(true);
        }
      });
  }, []);

  // Toggle wire group visibility
  useEffect(() => {
    if (!loaded || !containerRef.current) return;
    WIRE_GROUPS.forEach(({ hex }) => {
      const gid = 'wire-' + hex.slice(1).toUpperCase();
      const el = containerRef.current!.querySelector('#' + gid) as SVGElement | null;
      if (el) el.style.opacity = active.has(hex) ? '1' : '0.06';
    });
  }, [active, loaded]);

  const toggle = (hex: string) => {
    setActive(prev => {
      const next = new Set(prev);
      if (next.has(hex)) next.delete(hex);
      else next.add(hex);
      return next;
    });
  };

  const isolate = (hex: string) => {
    setActive(new Set([hex]));
  };

  const showAll = () => setActive(new Set(ALL_HEX));
  const hideAll = () => setActive(new Set());

  const allOn  = active.size === WIRE_GROUPS.length;
  const allOff = active.size === 0;

  return (
    <div style={{ background: '#07111e', borderTop: '1px solid #1a3550', borderBottom: '1px solid #1a3550' }}>

      {/* Header */}
      <div style={{ padding: '32px 24px 16px', textAlign: 'center' }}>
        <div style={{ fontSize: 9, letterSpacing: 5, color: '#22c55e', textTransform: 'uppercase', marginBottom: 8 }}>
          Gemelo Digital
        </div>
        <div style={{ fontSize: 'clamp(18px,2.8vw,28px)', fontWeight: 700, color: '#f1f5f9' }}>
          Diagrama de Conexiones del Sistema
        </div>
        <div style={{ fontSize: 12, color: '#2a4060', marginTop: 8 }}>
          Haz clic en un cable para aislarlo · Shift+clic para activar/desactivar
        </div>
      </div>

      {/* Filter controls */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center',
        padding: '0 24px 20px',
      }}>
        {/* All/None buttons */}
        <button
          onClick={showAll}
          style={ctrlBtn(allOn)}
        >
          Todos
        </button>
        <button
          onClick={hideAll}
          style={ctrlBtn(allOff, '#f87171')}
        >
          Ninguno
        </button>

        <div style={{ width: 1, background: '#1a3550', margin: '0 4px' }} />

        {/* Wire-color buttons */}
        {WIRE_GROUPS.map(({ hex, label, count }) => {
          const on = active.has(hex);
          return (
            <button
              key={hex}
              title={`Click: aislar · Shift+click: mostrar/ocultar`}
              onClick={e => {
                if (e.shiftKey) toggle(hex);
                else isolate(hex);
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '5px 12px',
                background: on ? hex + '18' : 'transparent',
                border: `1px solid ${on ? hex : hex + '44'}`,
                borderRadius: 4, cursor: 'pointer',
                color: on ? hex : hex + '55',
                fontSize: 11, fontFamily: 'inherit',
                transition: 'all 0.15s',
              }}
            >
              <span style={{
                display: 'inline-block', width: 10, height: 10,
                borderRadius: 2, background: on ? hex : 'transparent',
                border: `1.5px solid ${on ? hex : hex + '66'}`,
                flexShrink: 0, transition: 'all 0.15s',
              }} />
              {label}
              <span style={{ opacity: 0.45, fontSize: 9 }}>{count}</span>
            </button>
          );
        })}

        <button
          onClick={showAll}
          style={{ ...ctrlBtn(false), marginLeft: 4, fontSize: 10 }}
        >
          ↺ Reset
        </button>
      </div>

      {/* SVG canvas */}
      <div style={{
        maxWidth: 1400, margin: '0 auto',
        padding: '0 16px 32px',
        position: 'relative',
      }}>
        {!loaded && (
          <div style={{
            height: 400, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#2a4060', fontSize: 13,
          }}>
            Cargando diagrama…
          </div>
        )}
        <div
          ref={containerRef}
          style={{
            width: '100%',
            borderRadius: 8,
            overflow: 'hidden',
            border: '1px solid #112236',
            display: loaded ? 'block' : 'none',
          }}
        />
      </div>

      {/* Legend hint */}
      <div style={{
        textAlign: 'center', paddingBottom: 24,
        fontSize: 10, color: '#1e3348',
      }}>
        Shift+clic para selección múltiple · Haz clic en "Todos" para restaurar
      </div>
    </div>
  );
}

function ctrlBtn(active: boolean, color = '#94a3b8') {
  return {
    padding: '5px 14px',
    background: active ? color + '22' : 'transparent',
    border: `1px solid ${active ? color : color + '44'}`,
    borderRadius: 4, cursor: 'pointer',
    color: active ? color : color + '66',
    fontSize: 11, fontFamily: 'inherit',
    transition: 'all 0.15s',
  } as React.CSSProperties;
}

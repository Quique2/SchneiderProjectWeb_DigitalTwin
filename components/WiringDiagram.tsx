import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

// Generado desde diagramadeconexiones_final.dxf (diagram_tools/dxf_to_svg.py).
// Los cables principales del DXF están sin color de función (ACI 7); se
// muestran como "Cableado principal". El color por tipo de cable existe en
// las entidades de acento + el bloque 2D insertado (GPIO/conectores/pines).
const WIRE_GROUPS = [
  { hex: '#9FB3C8', labelKey: 'wiring.groups.structure', count: 13852 },
  { hex: '#A953A0', labelKey: 'wiring.groups.raspIn',    count:    24 },
  { hex: '#58BA48', labelKey: 'wiring.groups.ethernet',  count:    22 },
  { hex: '#FF0000', labelKey: 'wiring.groups.v24',       count:    22 },
  { hex: '#F1EB1F', labelKey: 'wiring.groups.nema',      count:    20 },
  { hex: '#7AAFDF', labelKey: 'wiring.groups.pneumatic', count:    17 },
  { hex: '#F8991E', labelKey: 'wiring.groups.raspOut',   count:    10 },
  { hex: '#FEEAB9', labelKey: 'wiring.groups.cobotOut',  count:     5 },
  { hex: '#991B1E', labelKey: 'wiring.groups.v5',        count:     5 },
  { hex: '#ED1F24', labelKey: 'wiring.groups.v12',       count:     4 },
  { hex: '#C8C92D', labelKey: 'wiring.groups.cobotIn',   count:     4 },
];

const ALL_HEX = new Set(WIRE_GROUPS.map(w => w.hex));

export default function WiringDiagram() {
  const T = useTheme();
  const { t } = useLanguage();
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

  // Apply theme colors to SVG background + text whenever theme or loaded changes
  useEffect(() => {
    if (!loaded || !containerRef.current) return;
    const svg = containerRef.current.querySelector('svg');
    if (!svg) return;

    const bg = T.dark ? '#07111e' : T.bg;
    const textFill = T.dark ? '#7a9ab8' : '#475569';

    // 1. SVG element inline style background
    svg.style.background = bg;

    // 2. Background rect (first <rect> = the fill behind all wires)
    const bgRect = svg.querySelector('rect');
    if (bgRect) bgRect.setAttribute('fill', bg);

    // 3. Text fill inside the <style> block
    const styleEl = svg.querySelector('style');
    if (styleEl && styleEl.textContent) {
      styleEl.textContent = styleEl.textContent.replace(
        /fill:#[0-9a-fA-F]{6}/,
        `fill:${textFill}`,
      );
    }
  }, [loaded, T.dark, T.bg]);

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
    <div style={{ background: T.bg, borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}` }}>

      {/* Header */}
      <div style={{ padding: '32px 24px 16px', textAlign: 'center' }}>
        <div style={{ fontSize: 9, letterSpacing: 5, color: '#22c55e', textTransform: 'uppercase', marginBottom: 8 }}>
          {t('wiring.label')}
        </div>
        <div style={{ fontSize: 'clamp(18px,2.8vw,28px)', fontWeight: 700, color: T.text }}>
          {t('wiring.title')}
        </div>
        <div style={{ fontSize: 12, color: T.muted, marginTop: 8 }}>
          {t('wiring.hint')}
        </div>
      </div>

      {/* Filter controls */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center',
        padding: '0 24px 20px',
      }}>
        {/* All/None buttons */}
        <button onClick={showAll} style={ctrlBtn(allOn, '#94a3b8', T.text)}>{t('wiring.btnAll')}</button>
        <button onClick={hideAll} style={ctrlBtn(allOff, '#f87171', T.text)}>{t('wiring.btnNone')}</button>

        <div style={{ width: 1, background: T.border, margin: '0 4px' }} />

        {/* Wire-color buttons */}
        {WIRE_GROUPS.map(({ hex, labelKey, count }) => {
          const on = active.has(hex);
          return (
            <button
              key={hex}
              title="Click: aislar · Shift+click: mostrar/ocultar"
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
                color: on ? hex : hex + '88',
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
              {t(labelKey)}
              <span style={{ opacity: 0.45, fontSize: 9 }}>{count}</span>
            </button>
          );
        })}

        <button onClick={showAll} style={{ ...ctrlBtn(false, '#94a3b8', T.text), marginLeft: 4, fontSize: 10 }}>
          {t('wiring.btnReset')}
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
            color: T.muted, fontSize: 13,
          }}>
            {t('wiring.loading')}
          </div>
        )}
        <div
          ref={containerRef}
          style={{
            width: '100%',
            borderRadius: 8,
            overflow: 'hidden',
            border: `1px solid ${T.border}`,
            display: loaded ? 'block' : 'none',
          }}
        />
      </div>

      {/* Legend hint */}
      <div style={{
        textAlign: 'center', paddingBottom: 24,
        fontSize: 10, color: T.dim,
      }}>
        {t('wiring.hint2')}
      </div>
    </div>
  );
}

function ctrlBtn(active: boolean, color = '#94a3b8', _text = '#fff') {
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

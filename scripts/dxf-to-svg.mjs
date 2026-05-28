// Converts diagramadeconexiones.dxf → public/diagram.svg
// Usage: node scripts/dxf-to-svg.mjs
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DXF_PATH = 'C:/Users/kiki7/Downloads/diagramadeconexiones (1).dxf';
const SVG_PATH = path.join(__dir, '../public/diagram.svg');

const raw = readFileSync(DXF_PATH, 'utf8');
const lines = raw.split(/\r?\n/);

// ── ACI colour index → display hex ──────────────────────────────────────────
// ACI 7 (white) re-mapped to a blue-grey visible on the dark background.
const ACI_MAP = {
  1: '#FF0000',
  2: '#FFFF00',
  3: '#00FF00',
  4: '#00FFFF',
  5: '#0000FF',
  6: '#FF00FF',
  7: '#9FB3C8',   // white → muted blue-grey for dark bg (Cableado principal)
  18: '#6B7480',  // Estructura
  30: '#F26722',  // Naranja (señales)
  51: '#F7F281',  // Soft yellow (señal)
  85: '#58BA48',  // Green (switch)
  143: '#7AAFDF', // Light blue
  152: '#2776BB', // Blue (comunicación)
  215: '#A953A0', // Purple (motores aux)
  240: '#ED1F24', // Bright red (+24V alt)
  242: '#CD2027', // Dark red (+24V)
};
function aciHex(aci) {
  return ACI_MAP[aci] ?? ('#' + Math.abs(aci).toString(16).padStart(6, '0'));
}

// ── Layer default ACI ────────────────────────────────────────────────────────
const layerACI = {};
for (let i = 0; i < lines.length - 1; i++) {
  if (lines[i].trim() === '0' && lines[i + 1].trim() === 'LAYER') {
    let name = '', color = '';
    for (let j = i + 2; j < Math.min(i + 40, lines.length - 1); j += 2) {
      const c = lines[j].trim(), v = (lines[j + 1] || '').trim();
      if (c === '2' && !name)  name  = v;
      if (c === '62' && !color) color = v;
      if (name && color) break;
    }
    if (name) layerACI[name] = Math.abs(parseInt(color) || 7);
  }
}

// ── Parse entities ───────────────────────────────────────────────────────────
const groups  = {};    // hex → [{x1,y1,x2,y2}]
const textItems = [];  // {x,y,h,text}

let curType = '', curLayer = '', curACI = 256;
let x1 = NaN, y1 = NaN, x2 = NaN, y2 = NaN;
let tx = NaN, ty = NaN, th = 2.5, ttxt = '';

function flushEntity() {
  if (curType === 'LINE' && !isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)) {
    const aci = curACI === 256 ? (layerACI[curLayer] ?? 7) : curACI;
    const hex = aciHex(aci);
    (groups[hex] ??= []).push({ x1, y1, x2, y2 });
  }
  if ((curType === 'TEXT' || curType === 'MTEXT') && ttxt && !isNaN(tx) && !isNaN(ty)) {
    textItems.push({ x: tx, y: ty, h: th, text: ttxt });
  }
}

for (let i = 0; i < lines.length - 1; i += 2) {
  const code = lines[i].trim();
  const val  = (lines[i + 1] ?? '').trim();

  if (code === '0') {
    flushEntity();
    curType = val; curLayer = ''; curACI = 256;
    x1 = y1 = x2 = y2 = NaN;
    tx = ty = NaN; th = 2.5; ttxt = '';
  }
  if (code === '8')  curLayer = val;
  if (code === '62') curACI   = parseInt(val);
  if (code === '10') { if (curType === 'LINE') x1 = parseFloat(val); else if (curType === 'TEXT' || curType === 'MTEXT') tx = parseFloat(val); }
  if (code === '20') { if (curType === 'LINE') y1 = parseFloat(val); else if (curType === 'TEXT' || curType === 'MTEXT') ty = parseFloat(val); }
  if (code === '11' && curType === 'LINE') x2 = parseFloat(val);
  if (code === '21' && curType === 'LINE') y2 = parseFloat(val);
  if (code === '40' && (curType === 'TEXT' || curType === 'MTEXT')) th = parseFloat(val);
  if (code === '1') {
    if (curType === 'TEXT') ttxt = val;
    if (curType === 'MTEXT') {
      // Strip MTEXT formatting codes
      ttxt = val
        .replace(/\\P/g, ' ')
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\[a-zA-Z][^;]*;/g, '')
        .replace(/\\\\/g, '\\')
        .trim();
    }
  }
}
flushEntity();

// ── Coordinate bounds + transform ────────────────────────────────────────────
const allX = [], allY = [];
for (const segs of Object.values(groups)) {
  for (const s of segs) { allX.push(s.x1, s.x2); allY.push(s.y1, s.y2); }
}
for (const t of textItems) { allX.push(t.x); allY.push(t.y); }

const pad  = 25;
const minX = Math.min(...allX) - pad;
const maxX = Math.max(...allX) + pad;
const minY = Math.min(...allY) - pad;
const maxY = Math.max(...allY) + pad;
const W    = maxX - minX;
const H    = maxY - minY;

const tx_ = (x) => (x - minX).toFixed(2);
const ty_ = (y) => (maxY - y).toFixed(2);   // flip Y: DXF Y-up → SVG Y-down

// ── Stroke widths ─────────────────────────────────────────────────────────────
const THIN_HEX = new Set(['#9FB3C8', '#6B7480']);
const strokeW  = (hex) => THIN_HEX.has(hex) ? '0.9' : '1.8';

// ── Group labels ──────────────────────────────────────────────────────────────
const LABELS = {
  '#9FB3C8': 'Cableado principal',
  '#6B7480': 'Estructura',
  '#00FF00': 'GPIO (bloque)',
  '#00FFFF': 'Conectores (bloque)',
  '#A953A0': 'Motores aux.',
  '#FFFF00': 'Pines (bloque)',
  '#58BA48': 'Switch',
  '#CD2027': '+24 V',
  '#F7F281': 'Señal (amarillo)',
  '#2776BB': 'Comunicación',
  '#ED1F24': '+24 V (alt)',
  '#FF0000': 'Rojo',
  '#7AAFDF': 'Azul claro',
  '#F26722': 'Señales (naranja)',
  '#F8991E': 'Señales (ámbar)',
};

// ── Render order: cableado last so coloured wires draw on top ─────────────────
const PREFERRED_ORDER = [
  '#9FB3C8', '#6B7480', '#00FF00', '#00FFFF', '#A953A0', '#FFFF00',
  '#58BA48', '#CD2027', '#F7F281', '#2776BB', '#ED1F24', '#FF0000',
  '#7AAFDF', '#F26722', '#F8991E',
];
const extraHex = Object.keys(groups).filter((h) => !PREFERRED_ORDER.includes(h));
const renderOrder = [...PREFERRED_ORDER, ...extraHex];

// ── Build SVG ─────────────────────────────────────────────────────────────────
const parts = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(2)} ${H.toFixed(2)}" style="background:#07111e;display:block;width:100%;height:auto;">`);
parts.push(`<defs><style>line,path,circle,polyline,polygon,ellipse{vector-effect:non-scaling-stroke}text{font-family:"IBM Plex Mono",monospace;fill:#7a9ab8}</style></defs>`);
parts.push(`<rect width="${W.toFixed(2)}" height="${H.toFixed(2)}" fill="#07111e"/>`);

for (const hex of renderOrder) {
  const segs = groups[hex];
  if (!segs || segs.length === 0) continue;
  const gid   = 'wire-' + hex.slice(1).toUpperCase();
  const label = LABELS[hex] ?? hex;
  parts.push(`<g id="${gid}" data-label="${label}" stroke="${hex}" stroke-width="${strokeW(hex)}" fill="none">`);
  for (const s of segs) {
    parts.push(`<line x1="${tx_(s.x1)}" y1="${ty_(s.y1)}" x2="${tx_(s.x2)}" y2="${ty_(s.y2)}"/>`);
  }
  parts.push(`</g>`);
}

// Text labels
if (textItems.length > 0) {
  parts.push('<g id="labels">');
  for (const t of textItems) {
    const fs = Math.max(2, Math.min(t.h * 0.72, 8)).toFixed(1);
    const escaped = t.text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    parts.push(`<text x="${tx_(t.x)}" y="${ty_(t.y)}" font-size="${fs}">${escaped}</text>`);
  }
  parts.push('</g>');
}

parts.push('</svg>');
const svgStr = parts.join('\n') + '\n';
writeFileSync(SVG_PATH, svgStr);

const totalLines = Object.values(groups).reduce((a, b) => a + b.length, 0);
console.log('SVG written to', SVG_PATH);
console.log('ViewBox:', W.toFixed(0) + ' x ' + H.toFixed(0));
console.log('Wire groups:', Object.keys(groups).length);
console.log('Total line segments:', totalLines);
console.log('Text labels:', textItems.length);
console.log('Groups:');
for (const hex of renderOrder) {
  const n = groups[hex]?.length ?? 0;
  if (n > 0) console.log(' ', hex, LABELS[hex] ?? '', ':', n, 'lines');
}

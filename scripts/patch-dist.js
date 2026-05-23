const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'dist', 'index.html');

if (!fs.existsSync(indexPath)) {
  console.error('dist/index.html not found. Run expo export first.');
  process.exit(1);
}

let html = fs.readFileSync(indexPath, 'utf-8');

// Patch title
html = html.replace(/<title>.*?<\/title>/, '<title>Schneider Digital Twin | ITESM Challenge 3.0</title>');

// Patch meta description
if (!html.includes('name="description"')) {
  html = html.replace('</head>', `  <meta name="description" content="Gemelo digital de celda semi-automatizada de remachado e inspección de CAFIs — Equipo 3 ITESM · Schneider Electric Challenge 3.0">\n</head>`);
}

// Patch favicon if not already custom
if (html.includes('favicon.ico') && !html.includes('favicon.png')) {
  html = html.replace('favicon.ico', 'favicon.png');
}

// Force dark background before JS loads
if (!html.includes('background:#06101c')) {
  html = html.replace('<body', '<body style="margin:0;background:#06101c;color:#e2e8f0"');
}

fs.writeFileSync(indexPath, html, 'utf-8');
console.log('✓ dist/index.html patched successfully.');

// Copy public/meshes → dist/meshes (recursively, includes sim/ subdir)
function copyDirRec(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const sp = path.join(srcDir, entry.name);
    const dp = path.join(dstDir, entry.name);
    if (entry.isDirectory()) count += copyDirRec(sp, dp);
    else { fs.copyFileSync(sp, dp); count++; }
  }
  return count;
}
const meshSrc = path.join(__dirname, '..', 'public', 'meshes');
const meshDst = path.join(__dirname, '..', 'dist', 'meshes');
if (fs.existsSync(meshSrc)) {
  const n = copyDirRec(meshSrc, meshDst);
  console.log(`✓ STL meshes copied to dist/meshes/ (${n} files, recursive).`);
}

// Copy public/urdf → dist/urdf (V53 URDF files loaded at runtime)
const urdfSrc = path.join(__dirname, '..', 'public', 'urdf');
const urdfDst = path.join(__dirname, '..', 'dist', 'urdf');
if (fs.existsSync(urdfSrc)) {
  const n = copyDirRec(urdfSrc, urdfDst);
  console.log(`✓ URDF files copied to dist/urdf/ (${n} files).`);
}

// Copy public/diagram.svg → dist/diagram.svg (wiring diagram)
const diagSrc = path.join(__dirname, '..', 'public', 'diagram.svg');
const diagDst = path.join(__dirname, '..', 'dist', 'diagram.svg');
if (fs.existsSync(diagSrc)) {
  fs.copyFileSync(diagSrc, diagDst);
  const kb = Math.round(fs.statSync(diagDst).size / 1024);
  console.log(`✓ diagram.svg copied to dist/ (${kb} KB).`);
}

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

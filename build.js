#!/usr/bin/env node
// Build script: inlines JS into HTML, copies SW + manifest + icons to dist
// Usage: node build.js
// Output: dist/sar-preflight.html + dist/sw.js + dist/manifest.json + dist/icons/

const fs = require('fs');
const path = require('path');

const dir = __dirname;
const outDir = path.join(dir, 'dist');

const html = fs.readFileSync(path.join(dir, 'sar-preflight.html'), 'utf8');
const versionJs = fs.readFileSync(path.join(dir, 'version.js'), 'utf8');
const offlineJs = fs.readFileSync(path.join(dir, 'sar-preflight-offline.js'), 'utf8');
const coreJs = fs.readFileSync(path.join(dir, 'sar-preflight-core.js'), 'utf8');
const chartsJs = fs.readFileSync(path.join(dir, 'sar-preflight-charts.js'), 'utf8');
const appJs = fs.readFileSync(path.join(dir, 'sar-preflight.js'), 'utf8');

// Strip CJS export blocks (not needed in browser)
const stripCJS = code => code.replace(/\/\/\s*---\s*CJS export[\s\S]*?^}/m, '').trimEnd();

// Replace all local <script src> tags + the empty placeholder with a single inline <script>
const pattern = /<script src="version\.js"><\/script>\s*<script src="sar-preflight-offline\.js"><\/script>\s*<script src="sar-preflight-core\.js"><\/script>\s*<script src="sar-preflight-charts\.js"><\/script>[\s\S]*?<script>\/\*.*?intentionally left empty.*?\*\/\s*<\/script>/;

const inlinedJs = `<script>\n${versionJs.trimEnd()}\n\n${stripCJS(offlineJs)}\n\n${stripCJS(coreJs)}\n\n${stripCJS(chartsJs)}\n\n${stripCJS(appJs)}\n</script>`;
let output = html.replace(pattern, inlinedJs);

// Verify the replacement actually happened
if (output === html) {
  console.error('ERROR: Script replacement pattern did not match. Check sar-preflight.html structure.');
  process.exit(1);
}

// Create dist directory structure
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
const iconsDir = path.join(outDir, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

// Write main HTML
fs.writeFileSync(path.join(outDir, 'sar-preflight.html'), output, 'utf8');

// Copy service worker — inline version.js so dist/sw.js is standalone
let swCode = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
swCode = swCode.replace(
  /importScripts\(['"]\.\/version\.js['"]\);/,
  versionJs.trimEnd()
);
// Strip CJS export from SW too (no-op today, but keeps the pattern consistent)
swCode = swCode.replace(/\/\/\s*---\s*CJS export[\s\S]*?^}/m, '').trimEnd();
// In dist mode, the app shell is just the single HTML + sw.js + manifest
swCode = swCode.replace(
  /const APP_SHELL = \[[\s\S]*?\];/,
  `const APP_SHELL = ['./', './sar-preflight.html', './manifest.json', './icons/icon-192.svg', './icons/icon-512.svg'];`
);
fs.writeFileSync(path.join(outDir, 'sw.js'), swCode, 'utf8');

// Copy manifest and icons
fs.copyFileSync(path.join(dir, 'manifest.json'), path.join(outDir, 'manifest.json'));
fs.copyFileSync(path.join(dir, 'icons', 'icon-192.svg'), path.join(iconsDir, 'icon-192.svg'));
fs.copyFileSync(path.join(dir, 'icons', 'icon-512.svg'), path.join(iconsDir, 'icon-512.svg'));

const htmlSize = Math.round(fs.statSync(path.join(outDir, 'sar-preflight.html')).size / 1024);
const swSize = Math.round(fs.statSync(path.join(outDir, 'sw.js')).size / 1024);
console.log(`Built dist/sar-preflight.html (${htmlSize} KB) + sw.js (${swSize} KB) + manifest.json + icons`);

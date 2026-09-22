#!/usr/bin/env node
// Build script: inlines JS into HTML, copies SW + manifest + icons to dist
// Usage: node build.js          (SAR_BUILD_OUT=<dir> overrides the output folder)
// Output: dist/sar-preflight.html + dist/sw.js + dist/manifest.json + dist/icons/
//         + the files the inlined app still fetches at runtime (see RUNTIME_FILES)

const fs = require('fs');
const path = require('path');

const dir = __dirname;
const outDir = process.env.SAR_BUILD_OUT ? path.resolve(process.env.SAR_BUILD_OUT) : path.join(dir, 'dist');

const html = fs.readFileSync(path.join(dir, 'sar-preflight.html'), 'utf8');
const versionJs = fs.readFileSync(path.join(dir, 'version.js'), 'utf8');
const offlineJs = fs.readFileSync(path.join(dir, 'sar-preflight-offline.js'), 'utf8');
const coreJs = fs.readFileSync(path.join(dir, 'sar-preflight-core.js'), 'utf8');
const rasterJs = fs.readFileSync(path.join(dir, 'sar-preflight-raster.js'), 'utf8');
const chartsJs = fs.readFileSync(path.join(dir, 'sar-preflight-charts.js'), 'utf8');
const appJs = fs.readFileSync(path.join(dir, 'sar-preflight.js'), 'utf8');

// Strip CJS export blocks (not needed in browser)
const stripCJS = code => code.replace(/\/\/\s*---\s*CJS export[\s\S]*?^}/m, '').trimEnd();

// Replace all local <script src> tags + the empty placeholder with a single inline <script>
const pattern = /<script src="version\.js"><\/script>\s*<script src="sar-preflight-offline\.js"><\/script>\s*<script src="sar-preflight-core\.js"><\/script>\s*<script src="sar-preflight-raster\.js"><\/script>\s*<script src="sar-preflight-charts\.js"><\/script>[\s\S]*?<script>\/\*.*?intentionally left empty.*?\*\/\s*<\/script>/;

// A literal "</script" anywhere in the code — even inside a comment — makes the
// HTML parser close the inline <script> right there, silently dropping every
// function after it (and what's left still parses, so nothing complains).
// "<\/script" is the same text to JS in strings, templates, regexes and comments.
const escapeForInlineScript = code => code.replace(/<\/script/gi, '<\\/script');
const bundledJs = [versionJs.trimEnd(), stripCJS(offlineJs), stripCJS(coreJs), stripCJS(rasterJs),
  stripCJS(chartsJs), stripCJS(appJs)].join('\n\n');
const inlinedJs = `<script>\n${escapeForInlineScript(bundledJs)}\n</script>`;
// Function replacement: a string replacement would expand $& / $' / $` in the code.
let output = html.replace(pattern, () => inlinedJs);

// Verify the replacement actually happened
if (output === html) {
  console.error('ERROR: Script replacement pattern did not match. Check sar-preflight.html structure.');
  process.exit(1);
}

// License + advisory banner: the single-file field build travels without the repo,
// so the notice has to ride inside the HTML itself (Apache-2.0 §4).
const licenseBanner = `<!--
  SAR UAS Pre-Flight Intelligence Tool (SAR-Preflight)
  Copyright 2026 John O'Keefe (https://github.com/TheCoderPerson/SAR-Preflight)
  Licensed under the Apache License, Version 2.0 — see the LICENSE and NOTICE
  files in the repository, or http://www.apache.org/licenses/LICENSE-2.0
  Provided "AS IS", without warranty of any kind.

  Advisory planning aid only — NOT certified by the FAA and NOT a substitute
  for an official preflight briefing (1800wxbrief.com).
-->`;
output = output.replace('<!DOCTYPE html>', `<!DOCTYPE html>\n${licenseBanner}`);

// Create dist directory structure
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
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
  `const APP_SHELL = ['./', './sar-preflight.html', './version.js', './manifest.json', './icons/icon-192.svg', './icons/icon-512.svg'];`
);
fs.writeFileSync(path.join(outDir, 'sw.js'), swCode, 'utf8');

// Copy manifest and icons
fs.copyFileSync(path.join(dir, 'manifest.json'), path.join(outDir, 'manifest.json'));
fs.copyFileSync(path.join(dir, 'icons', 'icon-192.svg'), path.join(iconsDir, 'icon-192.svg'));
fs.copyFileSync(path.join(dir, 'icons', 'icon-512.svg'), path.join(iconsDir, 'icon-512.svg'));

// Inlining the code does not remove its runtime FILE dependencies — the app
// still fetches these relative URLs, so a dist-only host must serve them:
//   version.js    Config → Check for Updates reads the deployed version
//   data/naipchm  NAIP-CHM per-1°-block quad index (_naipIndexForBlock)
//   data/cell     FCC carrier coverage GeoJSON, when generated locally
fs.copyFileSync(path.join(dir, 'version.js'), path.join(outDir, 'version.js'));
fs.cpSync(path.join(dir, 'data'), path.join(outDir, 'data'), { recursive: true });

// Regenerate CHANGELOG.md from the single source of truth (CHANGELOG_ENTRIES in core.js)
try {
  const { CHANGELOG_ENTRIES } = require('./sar-preflight-core.js');
  const md = [
    '# Changelog', '',
    'All notable changes to the SAR UAS Pre-Flight Intelligence Tool, newest first.',
    '',
    '> Generated from `CHANGELOG_ENTRIES` in `sar-preflight-core.js` by `build.js` — edit there, not here.',
    '',
  ];
  for (const e of CHANGELOG_ENTRIES) {
    md.push(`## v${e.version} — ${e.date}`, '');
    for (const c of e.changes) md.push(`- ${c}`);
    md.push('');
  }
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), md.join('\n'), 'utf8');
  // The update prompt fetches CHANGELOG.md for its "what's new" list.
  fs.copyFileSync(path.join(dir, 'CHANGELOG.md'), path.join(outDir, 'CHANGELOG.md'));
  console.log(`Regenerated CHANGELOG.md (${CHANGELOG_ENTRIES.length} versions)`);
} catch (e) {
  console.warn('CHANGELOG.md generation skipped:', e.message);
}

// Build-output contract: every file the bundled app requests at runtime must
// exist in the output, so a packaging omission fails the build instead of
// shipping an app whose update check and NAIP canopy lookup silently break.
const RUNTIME_FILES = ['sar-preflight.html', 'sw.js', 'manifest.json', 'version.js', 'CHANGELOG.md',
  'icons/icon-192.svg', 'icons/icon-512.svg', 'data/naipchm/manifest.json'];
const missing = RUNTIME_FILES.filter(f => !fs.existsSync(path.join(outDir, f)));
const srcNaip = fs.readdirSync(path.join(dir, 'data', 'naipchm')).length;
const naipOut = path.join(outDir, 'data', 'naipchm');
const outNaip = fs.existsSync(naipOut) ? fs.readdirSync(naipOut).length : 0;
if (outNaip !== srcNaip) missing.push(`data/naipchm/* (${outNaip} of ${srcNaip} files)`);
if (!missing.includes('version.js') &&
    !/SAR_VERSION\s*=\s*'[^']+'/.test(fs.readFileSync(path.join(outDir, 'version.js'), 'utf8'))) {
  missing.push('version.js (no SAR_VERSION)');
}
if (!swCode.includes("'./version.js'")) missing.push('sw.js APP_SHELL entry for version.js');
// The inline script as the HTML parser will see it (up to the first "</script")
// must END with the bundled code's last 400 chars, not stop at a stray "</script".
const bundledTail = escapeForInlineScript(bundledJs).slice(-400).trimEnd();
const inlineApp = (output.match(/<script>\n([\s\S]*?)<\/script>/) || [])[1] || '';
if (!inlineApp.trimEnd().endsWith(bundledTail)) missing.push('inline <script> is truncated (ends before the app code does)');
if (missing.length) {
  console.error('ERROR: build output is missing runtime files:\n  ' + missing.join('\n  '));
  process.exit(1);
}

const htmlSize = Math.round(fs.statSync(path.join(outDir, 'sar-preflight.html')).size / 1024);
const swSize = Math.round(fs.statSync(path.join(outDir, 'sw.js')).size / 1024);
console.log(`Built ${path.relative(dir, outDir) || '.'}/sar-preflight.html (${htmlSize} KB) + sw.js (${swSize} KB) + manifest.json + icons + version.js + CHANGELOG.md + data/ (${outNaip} NAIP index files)`);

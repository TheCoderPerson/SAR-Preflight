// ============================================================
// SAR Preflight — cell-coverage bundle builder
//
// FCC mobile (LTE) coverage has NO free live API or tile service — it is published
// only as bulk per-state / per-provider downloads. This one-time build step turns
// those downloads into the compact, offline-capable per-carrier overlay the app
// loads from data/cell/{att,tmobile,verizon}.geojson.
//
// PIPELINE (see README.md for the full walkthrough):
//   1. Download FCC BDC mobile LTE availability for your carriers/state from
//      https://broadbandmap.fcc.gov/data-download  (Mobile → 4G LTE → your state).
//   2. Dissolve the H3 hexagons to coverage boundaries + convert to GeoJSON, e.g.
//        npx mapshaper att_lte.gpkg -dissolve2 -o input/att.geojson
//      (or feed the FCC "raw propagation modeled" polygons, already dissolved).
//   3. Run this script — it clips to the operating region, simplifies, quantizes,
//      strips attributes, and writes data/cell/<carrier>.geojson.
//
// Stdlib-only (no npm deps). Re-run ~2×/year when the FCC refreshes the data.
// Usage:  node tools/cell-coverage/build.mjs            (reads tools/cell-coverage/input/*.geojson)
//         node tools/cell-coverage/build.mjs --region=38.0,-121.7,39.7,-119.6
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const INPUT_DIR = join(__dirname, 'input');
const OUTPUT_DIR = join(REPO_ROOT, 'data', 'cell');

const CARRIERS = ['att', 'tmobile', 'verizon'];

// Default operating region (El Dorado / Placer + neighbors): [south, west, north, east].
// Override with --region=S,W,N,E. Features fully outside this box are dropped.
let REGION = { south: 38.0, west: -121.7, north: 39.7, east: -119.6 };
const SIMPLIFY_TOL_DEG = 0.0015; // ~150 m — LTE coverage edges are fuzzy
const QUANTIZE_DECIMALS = 4;     // ~11 m — finer than the data warrants

const regionArg = process.argv.find(a => a.startsWith('--region='));
if (regionArg) {
  const [s, w, n, e] = regionArg.slice('--region='.length).split(',').map(Number);
  if ([s, w, n, e].every(Number.isFinite)) REGION = { south: s, west: w, north: n, east: e };
}

// --- Geometry helpers (operate on GeoJSON [lng,lat] coordinates) ---

function ringBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function bboxIntersectsRegion(bb) {
  return bb.minX <= REGION.east && bb.maxX >= REGION.west &&
         bb.minY <= REGION.north && bb.maxY >= REGION.south;
}

// Perpendicular distance from p to segment a-b (planar; degrees are fine at this tol).
function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function douglasPeucker(points, tol) {
  if (points.length < 3) return points.slice();
  let maxD = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], points[0], points[points.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > tol) {
    const left = douglasPeucker(points.slice(0, idx + 1), tol);
    const right = douglasPeucker(points.slice(idx), tol);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

function quantize(ring) {
  const f = Math.pow(10, QUANTIZE_DECIMALS);
  const out = ring.map(([x, y]) => [Math.round(x * f) / f, Math.round(y * f) / f]);
  // Drop consecutive duplicates produced by quantizing.
  const dedup = out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0] || p[1] !== out[i - 1][1]);
  if (dedup.length && (dedup[0][0] !== dedup[dedup.length - 1][0] || dedup[0][1] !== dedup[dedup.length - 1][1])) {
    dedup.push(dedup[0]); // re-close
  }
  return dedup;
}

function processRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const simplified = douglasPeucker(ring, SIMPLIFY_TOL_DEG);
  const q = quantize(simplified);
  return q.length >= 4 ? q : null;
}

function processPolygon(coords) {
  const rings = (coords || []).map(processRing).filter(Boolean);
  return rings.length ? rings : null;
}

function processFeature(feature) {
  const g = feature && feature.geometry;
  if (!g) return null;
  let geometry = null;
  if (g.type === 'Polygon') {
    const bb = ringBBox(g.coordinates[0] || []);
    if (!bboxIntersectsRegion(bb)) return null;
    const poly = processPolygon(g.coordinates);
    if (poly) geometry = { type: 'Polygon', coordinates: poly };
  } else if (g.type === 'MultiPolygon') {
    const polys = (g.coordinates || [])
      .filter(p => bboxIntersectsRegion(ringBBox(p[0] || [])))
      .map(processPolygon).filter(Boolean);
    if (polys.length) geometry = { type: 'MultiPolygon', coordinates: polys };
  }
  if (!geometry) return null;
  return { type: 'Feature', properties: { covered: true }, geometry };
}

// All input files belonging to a carrier: `att.geojson` and/or any
// `att_*.geojson` / `att-*.geojson` (e.g. att_4g.geojson + att_5g.geojson).
// Their features are merged, so a point covered by EITHER technology counts as
// covered (the app tests "inside any polygon" per carrier — union for free).
function inputsForCarrier(carrier) {
  if (!existsSync(INPUT_DIR)) return [];
  return readdirSync(INPUT_DIR)
    .filter(f => f.toLowerCase().endsWith('.geojson'))
    .filter(f => {
      const base = f.toLowerCase().replace(/\.geojson$/, '');
      return base === carrier || base.startsWith(carrier + '_') || base.startsWith(carrier + '-');
    })
    .sort()
    .map(f => join(INPUT_DIR, f));
}

function buildCarrier(carrier) {
  const paths = inputsForCarrier(carrier);
  if (!paths.length) {
    console.warn(`  [skip] ${carrier}: no input file (looked for ${carrier}.geojson / ${carrier}_*.geojson in input/)`);
    return false;
  }
  const features = [];
  for (const p of paths) {
    const gj = JSON.parse(readFileSync(p, 'utf8'));
    (gj.features || []).forEach(f => { const pf = processFeature(f); if (pf) features.push(pf); });
  }
  const out = {
    type: 'FeatureCollection',
    metadata: {
      carrier,
      source: 'FCC Broadband Data Collection — Mobile 4G LTE / 5G-NR availability',
      inputs: paths.map(p => p.split(/[\\/]/).pop()),
      region: REGION,
      note: 'Combined modeled coverage (any reported technology), ~1000 ft (H3 res-9) granularity. Advisory — verify on-site.',
    },
    features,
  };
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = join(OUTPUT_DIR, `${carrier}.geojson`);
  const json = JSON.stringify(out);
  writeFileSync(outPath, json);
  console.log(`  [ok]   ${carrier}: ${features.length} features → ${outPath} (${(json.length / 1024).toFixed(0)} KB)`);
  return true;
}

console.log(`Cell-coverage build — region S,W,N,E = ${REGION.south},${REGION.west},${REGION.north},${REGION.east}`);
let any = false;
for (const c of CARRIERS) any = buildCarrier(c) || any;
if (!any) {
  console.log('\nNo inputs found. Place dissolved FCC LTE GeoJSON at tools/cell-coverage/input/{att,tmobile,verizon}.geojson');
  console.log('See tools/cell-coverage/README.md for the download + dissolve steps.');
  process.exitCode = 1;
}

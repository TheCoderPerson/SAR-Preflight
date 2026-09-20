#!/usr/bin/env node
// ============================================================
// NAIP-CHM lookup index builder
//
// The NAIP-CHM dataset (Morford et al. 2026, Univ. of Montana NTSG) is one
// Cloud-Optimized GeoTIFF per NAIP quarter-quad, stored as
//   {year}/{utmZone}/m_{quad7}{qq}_{zone}_{res}_{date}[_{date2}]_chm.tif
// The quarter-quad footprint is fully determined by lat/lng (USGS 7.5' quad
// numbering), but the YEAR, UTM zone, resolution code and acquisition DATE(S)
// in the filename are not — only the dataset's 256 MB index.csv knows them.
// This tool turns that CSV into small per-1°-block JSON files the app fetches
// lazily (1–4 per canopy load):
//
//   data/naipchm/{block}.json  →  {"v":1,"e":{"01ne":"2022/10_060_20220721", …}}
//
// where block = first 5 digits of quad_id (lat° + lon°W, e.g. 38120 = lat
// [38,39), lon [-121,-120)), the key is the 2-digit quad index + quarter, and
// the value is `${year}/` + the source_doqq tail after `m_{quad}{qq}_`
// (zone_res_date[_date2], verbatim). The app rebuilds the path as
//   `${year}/${zone}/m_${quad}${qq}_${tail}_chm.tif`   (zone = first token of tail).
//
// Usage:
//   node tools/naip-chm-index/build.mjs                 # stream index.csv from the server (~256 MB)
//   node tools/naip-chm-index/build.mjs --input index.csv
//   node tools/naip-chm-index/build.mjs --bbox -125,32,-114,42   # subset (west,south,east,north)
//   node tools/naip-chm-index/build.mjs --out data/naipchm
//
// Stdlib only. Almost every quarter-quad appears in exactly one year; ~850
// Florida quads exist twice (a 2021/22 60 cm run and a 2023 30 cm run) — the
// higher year wins. The res code is 060 / 030 / 1 or the letter 'h' (25 rows,
// 2016 zone 11), so the tail regex allows [0-9a-z].
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const INDEX_URL = 'https://rangeland.ntsg.umt.edu/data/naip-chm/index.csv';
export const INDEX_FORMAT_VERSION = 1;

// Parse one CSV data row. Only the trailing `.geo` column is quoted / contains
// commas, so the first 12 fields split cleanly on ','. Returns null for rows
// that are not NAIP-CHM assets (header, blanks, malformed).
export function parseIndexRow(line) {
  if (!line || !line.startsWith('m_')) return null;
  const p = line.split(',', 13);
  if (p.length < 12) return null;
  const quadId = p[6], quarter = p[7], sourceDoqq = p[9];
  const zone = parseInt(p[10], 10), year = parseInt(p[11], 10);
  if (!/^\d{7}$/.test(quadId) || !/^[ns][ew]$/.test(quarter)) return null;
  if (!Number.isFinite(zone) || !Number.isFinite(year)) return null;
  const prefix = `m_${quadId}_${quarter}_`;
  if (!sourceDoqq.startsWith(prefix)) return null;
  const tail = sourceDoqq.slice(prefix.length); // zone_res_date[_date2]  (res: 060 | 030 | 1 | h)
  if (!/^\d{1,2}_[0-9a-z]{1,3}(_\d{8}){1,2}$/.test(tail)) return null; // res code is 060/030/1 or 'h' (2016 zone-11 rows)
  return { block: quadId.slice(0, 5), key: quadId.slice(5) + quarter, value: `${year}/${tail}`, year, zone, quadId, quarter };
}

// Nominal lat/lng footprint of a 7-digit quad id + quarter (no buffer).
// Quad index 01–64 is row-major from the NW corner (row north→south, col west→east).
export function quarterQuadBounds(quadId, quarter) {
  const latDeg = parseInt(quadId.slice(0, 2), 10);
  const lonDeg = parseInt(quadId.slice(2, 5), 10);
  const idx = parseInt(quadId.slice(5, 7), 10) - 1;
  const row = Math.floor(idx / 8), col = idx % 8;
  const north = latDeg + 1 - row * 0.125, west = -(lonDeg + 1) + col * 0.125;
  const qn = quarter[0] === 'n' ? north : north - 0.0625;
  const qw = quarter[1] === 'w' ? west : west + 0.0625;
  return { west: qw, south: qn - 0.0625, east: qw + 0.0625, north: qn };
}

function intersects(a, bb) {
  return a.west < bb.east && a.east > bb.west && a.south < bb.north && a.north > bb.south;
}

export async function buildIndex({ lines, bbox, onProgress }) {
  const blocks = new Map(); // block → Map(key → {value, year})
  let rows = 0, kept = 0, skipped = 0;
  for await (const line of lines) {
    rows++;
    const rec = parseIndexRow(line);
    if (!rec) { if (rows > 1) skipped++; continue; }
    if (bbox && !intersects(quarterQuadBounds(rec.quadId, rec.quarter), bbox)) continue;
    let m = blocks.get(rec.block);
    if (!m) { m = new Map(); blocks.set(rec.block, m); }
    const prev = m.get(rec.key);
    if (!prev || rec.year > prev.year) m.set(rec.key, { value: rec.value, year: rec.year });
    kept++;
    if (onProgress && rows % 20000 === 0) onProgress(rows, kept);
  }
  return { blocks, rows, kept, skipped };
}

export function writeIndex(outDir, built, meta) {
  fs.mkdirSync(outDir, { recursive: true });
  const blockNames = [...built.blocks.keys()].sort();
  let entries = 0;
  for (const b of blockNames) {
    const m = built.blocks.get(b);
    const e = {};
    for (const k of [...m.keys()].sort()) e[k] = m.get(k).value;
    entries += m.size;
    fs.writeFileSync(path.join(outDir, `${b}.json`), JSON.stringify({ v: INDEX_FORMAT_VERSION, e }));
  }
  const manifest = Object.assign({
    v: INDEX_FORMAT_VERSION, built: new Date().toISOString(), entries, blocks: blockNames.length,
    source: INDEX_URL, license: 'MIT (dataset) — cite Morford et al. 2026, Sci Data, doi:10.1038/s41597-026-07549-w',
  }, meta || {});
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { entries, blocks: blockNames.length };
}

async function openLines(input) {
  if (input) return readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
  const res = await fetch(INDEX_URL);
  if (!res.ok || !res.body) throw new Error(`index.csv HTTP ${res.status}`);
  return readline.createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
}

function parseArgs(argv) {
  const a = { out: null, input: null, bbox: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--out') { a.out = v; i++; }
    else if (k === '--input') { a.input = v; i++; }
    else if (k === '--bbox') {
      const n = String(v).split(',').map(Number);
      if (n.length !== 4 || n.some(x => !Number.isFinite(x))) throw new Error('--bbox west,south,east,north');
      a.bbox = { west: n[0], south: n[1], east: n[2], north: n[3] }; i++;
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = args.out ? path.resolve(args.out) : path.resolve(here, '..', '..', 'data', 'naipchm');
  const t0 = Date.now();
  console.log(`NAIP-CHM index → ${outDir}` + (args.input ? ` (from ${args.input})` : ` (streaming ${INDEX_URL})`) + (args.bbox ? ` bbox ${JSON.stringify(args.bbox)}` : ''));
  const lines = await openLines(args.input);
  const built = await buildIndex({ lines, bbox: args.bbox, onProgress: (r, k) => process.stdout.write(`\r  rows ${r}  kept ${k}`) });
  process.stdout.write('\n');
  const w = writeIndex(outDir, built, { bbox: args.bbox || null });
  console.log(`rows ${built.rows}  kept ${built.kept}  skipped ${built.skipped}  → ${w.blocks} block files, ${w.entries} entries in ${Math.round((Date.now() - t0) / 1000)} s`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}

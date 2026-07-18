// ============================================================
// SAR Preflight — Raster & Viewshed Math (pure, DOM/Leaflet/fetch-free)
// Vegetation-height handling + line-of-sight viewshed.
// Ported from the companion SAR_UAS_Segment tool (raster/los.py, raster/dsm.py).
// Testable in Node (CJS export at the bottom).
// ============================================================

// --- Units / physical constants (ported verbatim from the segment tool) ---
const M_PER_FT = 0.3048;
const FT_PER_M = 1 / 0.3048;
const R_EARTH_M = 6371008.8;             // mean Earth radius (los.py)
const PILOT_EYE_M = 5.5 * M_PER_FT;      // 1.6764 m — assumed observer eye height
const VLOS_DEFAULT_M = 2500 * M_PER_FT;  // 762 m — default visual line-of-sight range
const WORK_RES_M = 3.0;                   // working grid resolution (config.py)
const MAX_GRID = 512;                     // cap on grid dimension for browser perf
const KERNEL_SENTINEL = -1e6;             // NaN obstacle sentinel (pipeline.py)

// Meta/WRI Global Canopy Height (1 m) — Bing-quadkey z9 COG tiles.
// Verified: (-120.99, 38.685) → quadkey "023010211".
const META_ZOOM = 9;
const META_BASE_DEFAULT = 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float';

function ftToM(ft) { return ft * M_PER_FT; }
function mToFt(m) { return m * FT_PER_M; }

// --- Web Mercator helpers ---
const WEBMERC_R = 6378137; // EPSG:3857 sphere radius (metres)
function mercatorY(lat) {
  const r = lat * Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + r / 2));
}
function mercatorLatFromY(my) {
  return (2 * Math.atan(Math.exp(my)) - Math.PI / 2) * 180 / Math.PI;
}
// EPSG:3857 metres (for converting COG bounding boxes to/from lat/lng)
function lngToMercX(lng) { return WEBMERC_R * lng * Math.PI / 180; }
function latToMercY(lat) { return WEBMERC_R * mercatorY(lat); }
function mercXToLng(x) { return x / WEBMERC_R * 180 / Math.PI; }
function mercYToLat(y) { return mercatorLatFromY(y / WEBMERC_R); }

// ============================================================
// QUADKEY / TILING (Bing/slippy) — covers a bbox without the 15 MB tiles.geojson
// ============================================================
function lngLatToTileXY(lng, lat, z) {
  const n = Math.pow(2, z);
  let x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  let y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  x = Math.max(0, Math.min(n - 1, x));
  y = Math.max(0, Math.min(n - 1, y));
  return { x, y };
}

function tileXYToQuadkey(x, y, z) {
  let qk = '';
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    qk += String(digit);
  }
  return qk;
}

function quadkeyToTileXY(qk) {
  let x = 0, y = 0;
  const z = qk.length;
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    const d = qk[z - i];
    if (d === '1') x |= mask;
    else if (d === '2') y |= mask;
    else if (d === '3') { x |= mask; y |= mask; }
  }
  return { x, y, z };
}

function tileXYBounds(x, y, z) {
  const n = Math.pow(2, z);
  const west = x / n * 360 - 180;
  const east = (x + 1) / n * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { north, south, east, west };
}

function quadkeyBounds(qk) {
  const t = quadkeyToTileXY(qk);
  return tileXYBounds(t.x, t.y, t.z);
}

// Quadkeys (at META_ZOOM) covering a geographic bbox.
function metaQuadkeysForBBox(west, south, east, north, z) {
  if (z == null) z = META_ZOOM;
  const nw = lngLatToTileXY(west, north, z);
  const se = lngLatToTileXY(east, south, z);
  const out = [];
  for (let x = Math.min(nw.x, se.x); x <= Math.max(nw.x, se.x); x++) {
    for (let y = Math.min(nw.y, se.y); y <= Math.max(nw.y, se.y); y++) {
      out.push(tileXYToQuadkey(x, y, z));
    }
  }
  return out;
}

// ============================================================
// GRID GEOMETRY — local equirectangular metres grid over an AOI.
// Sub-metre error at <=1.5 km AOI, so no UTM needed.
// row 0 = north edge, col 0 = west edge; values are cell-centre sampled.
// ============================================================
function makeGrid(centerLat, centerLng, halfWidthM, resM) {
  const mPerDegLat = 111320;
  const mPerDegLng = mPerDegLat * Math.cos(centerLat * Math.PI / 180);
  let n = Math.ceil((2 * halfWidthM) / resM);
  if (n > MAX_GRID) n = MAX_GRID;
  if (n < 1) n = 1;
  const effResM = (2 * halfWidthM) / n;
  const halfLat = halfWidthM / mPerDegLat;
  const halfLng = halfWidthM / mPerDegLng;
  const west = centerLng - halfLng, east = centerLng + halfLng;
  const south = centerLat - halfLat, north = centerLat + halfLat;
  return {
    lat0: centerLat, lng0: centerLng,
    west, east, south, north,
    rows: n, cols: n, resM: effResM,
    mPerDegLat, mPerDegLng,
    bounds: { west, south, east, north },
  };
}

function gridColToLng(grid, col) {
  return grid.west + (col + 0.5) / grid.cols * (grid.east - grid.west);
}
function gridRowToLat(grid, row) {
  return grid.north - (row + 0.5) / grid.rows * (grid.north - grid.south);
}
function gridLngToCol(grid, lng) {
  let c = Math.floor((lng - grid.west) / (grid.east - grid.west) * grid.cols);
  return Math.max(0, Math.min(grid.cols - 1, c));
}
function gridLatToRow(grid, lat) {
  let r = Math.floor((grid.north - lat) / (grid.north - grid.south) * grid.rows);
  return Math.max(0, Math.min(grid.rows - 1, r));
}
function latLngToCell(grid, lat, lng) {
  return { col: gridLngToCol(grid, lng), row: gridLatToRow(grid, lat) };
}

// ============================================================
// Bilinearly sample a flat grid (row-major, cols-wide) at a lat/lng.
// Used to read terrain elevation directly under a moving point (e.g. an
// aircraft) so the value varies smoothly instead of snapping per cell.
// Falls back to the nearest finite corner when some neighbours are NaN
// (grid edge / nodata); returns NaN only when no usable neighbour exists or
// the point is outside the grid bounds.
// ============================================================
function sampleGridBilinear(grid, flat, lat, lng) {
  if (!grid || !flat) return NaN;
  // Continuous cell coordinates (cell centres at integer indices).
  const fx = (lng - grid.west) / (grid.east - grid.west) * grid.cols - 0.5;
  const fy = (grid.north - lat) / (grid.north - grid.south) * grid.rows - 0.5;
  if (fx < -0.5 || fy < -0.5 || fx > grid.cols - 0.5 || fy > grid.rows - 0.5) return NaN;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = x0 + 1, y1 = y0 + 1;
  const tx = fx - x0, ty = fy - y0;
  const at = (x, y) => {
    if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) return NaN;
    return flat[y * grid.cols + x];
  };
  const v00 = at(x0, y0), v10 = at(x1, y0), v01 = at(x0, y1), v11 = at(x1, y1);
  // Fast path: all four corners finite → true bilinear.
  if (Number.isFinite(v00) && Number.isFinite(v10) && Number.isFinite(v01) && Number.isFinite(v11)) {
    const top = v00 * (1 - tx) + v10 * tx;
    const bot = v01 * (1 - tx) + v11 * tx;
    return top * (1 - ty) + bot * ty;
  }
  // Degraded path: nearest finite corner (by bilinear weight).
  const cands = [
    { v: v00, w: (1 - tx) * (1 - ty) },
    { v: v10, w: tx * (1 - ty) },
    { v: v01, w: (1 - tx) * ty },
    { v: v11, w: tx * ty },
  ].filter(c => Number.isFinite(c.v));
  if (!cands.length) return NaN;
  cands.sort((a, b) => b.w - a.w);
  return cands[0].v;
}

// ============================================================
// RESAMPLE a georeferenced source raster onto the target grid (nearest-neighbour).
// src = { data, srcCols, srcRows, srcBounds:{west,south,east,north}, srcIsMercator, nodata }
// srcIsMercator: pixels are equally spaced in Web Mercator Y (Meta COG tiles);
// otherwise plate-carrée lat/lng (3DEP exportImage with imageSR=4326).
// ============================================================
function resampleToGrid(grid, src) {
  const out = new Float32Array(grid.rows * grid.cols);
  const { srcCols, srcRows, data, srcBounds: sb, srcIsMercator, nodata } = src;
  const myTop = srcIsMercator ? mercatorY(sb.north) : 0;
  const myBot = srcIsMercator ? mercatorY(sb.south) : 0;
  for (let row = 0; row < grid.rows; row++) {
    const lat = gridRowToLat(grid, row);
    let sy;
    if (srcIsMercator) sy = (myTop - mercatorY(lat)) / (myTop - myBot) * srcRows;
    else sy = (sb.north - lat) / (sb.north - sb.south) * srcRows;
    const iy = Math.floor(sy);
    for (let col = 0; col < grid.cols; col++) {
      const lng = gridColToLng(grid, col);
      const sx = (lng - sb.west) / (sb.east - sb.west) * srcCols;
      const ix = Math.floor(sx);
      let v = NaN;
      if (ix >= 0 && ix < srcCols && iy >= 0 && iy < srcRows) {
        v = data[iy * srcCols + ix];
        if (nodata != null && v === nodata) v = NaN;
      }
      out[row * grid.cols + col] = v;
    }
  }
  return out;
}

// ============================================================
// DSM = DEM + max(canopy, 0)  (port of dsm.py)
// canopyFlat null/absent → DSM = DEM (bare earth).
// ============================================================
function buildDSM(demFlat, canopyFlat, n) {
  const out = new Float32Array(n);
  if (!canopyFlat) {
    for (let i = 0; i < n; i++) out[i] = demFlat[i];
    return out;
  }
  for (let i = 0; i < n; i++) {
    const c = canopyFlat[i];
    out[i] = demFlat[i] + (Number.isFinite(c) && c > 0 ? c : 0);
  }
  return out;
}

// Replace NaN with a large-negative sentinel so the LOS kernel never sees a
// phantom obstacle where data is missing.
function sanitizeForKernel(arr, n, sentinel) {
  if (sentinel == null) sentinel = KERNEL_SENTINEL;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Number.isFinite(arr[i]) ? arr[i] : sentinel;
  return out;
}

// ============================================================
// VIEWSHED KERNEL — faithful port of los.py is_visible / coverage_from_station.
// Observer eye = DEM[obs] + eye height (bare ground); target (drone) = DEM[cell] + AGL;
// obstructions tested against DSM (terrain + vegetation) with Earth-curvature drop.
// ============================================================
function curvatureDrop(rangeM, t) {
  const d = t * rangeM;
  return d * (rangeM - d) / (2 * R_EARTH_M);
}

// Straight line-of-sight from observer cell (px,py) to target cell (tx,ty).
// Returns true if the ray clears the DSM at every INTERMEDIATE cell.
function isVisible(px, py, pilotZ, tx, ty, targetZ, dsm, cols, rows, cellSizeM) {
  const dx = tx - px, dy = ty - py;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) return true;
  const rangeM = Math.hypot(dx, dy) * cellSizeM;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const cx = Math.round(px + dx * t);
    const cy = Math.round(py + dy * t);
    if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) return false;
    const rayZ = pilotZ + t * (targetZ - pilotZ);
    const obstacleZ = dsm[cy * cols + cx] + curvatureDrop(rangeM, t);
    if (obstacleZ > rayZ) return false;
  }
  return true;
}

// Compute the full viewshed mask (Uint8: 1 = drone visible, 0 = not / unknown).
// dem: raw DEM (NaN allowed); dsm: sanitized obstacle surface (NaN→sentinel).
function computeViewshed(opts) {
  const grid = opts.grid;
  const dem = opts.dem, dsm = opts.dsm;
  const obsCol = opts.obsCol, obsRow = opts.obsRow;
  const pilotEyeM = opts.pilotEyeM != null ? opts.pilotEyeM : PILOT_EYE_M;
  const aglM = opts.aglM;
  const vlosRangeM = opts.vlosRangeM != null ? opts.vlosRangeM : VLOS_DEFAULT_M;
  const onProgress = opts.onProgress;

  const cols = grid.cols, rows = grid.rows, cellSizeM = grid.resM;
  const out = new Uint8Array(rows * cols);
  const obsIdx = obsRow * cols + obsCol;
  const obsGround = dem[obsIdx];
  if (!Number.isFinite(obsGround)) return out; // observer ground unknown → cannot assess
  const pilotZ = obsGround + pilotEyeM;

  const vlosCells = vlosRangeM / cellSizeM;
  const vlosCells2 = vlosCells * vlosCells;
  const rMin = Math.max(0, Math.floor(obsRow - vlosCells));
  const rMax = Math.min(rows - 1, Math.ceil(obsRow + vlosCells));
  const cMin = Math.max(0, Math.floor(obsCol - vlosCells));
  const cMax = Math.min(cols - 1, Math.ceil(obsCol + vlosCells));

  out[obsIdx] = 1; // the observer can always see their own location
  for (let row = rMin; row <= rMax; row++) {
    for (let col = cMin; col <= cMax; col++) {
      const dc = col - obsCol, dr = row - obsRow;
      if (dc * dc + dr * dr > vlosCells2) continue;
      const idx = row * cols + col;
      if (idx === obsIdx) continue;
      const g = dem[idx];
      if (!Number.isFinite(g)) continue; // unknown terrain
      const targetZ = g + aglM;
      if (isVisible(obsCol, obsRow, pilotZ, col, row, targetZ, dsm, cols, rows, cellSizeM)) {
        out[idx] = 1;
      }
    }
    if (onProgress) onProgress((row - rMin + 1) / Math.max(1, rMax - rMin + 1));
  }
  return out;
}

// Fraction of in-range cells that are visible (for the result readout).
function viewshedCoverage(grid, mask, obsCol, obsRow, vlosRangeM) {
  const cols = grid.cols, rows = grid.rows;
  const vlosCells = vlosRangeM / grid.resM;
  const vlosCells2 = vlosCells * vlosCells;
  let total = 0, vis = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const dc = col - obsCol, dr = row - obsRow;
      if (dc * dc + dr * dr > vlosCells2) continue;
      total++;
      if (mask[row * cols + col]) vis++;
    }
  }
  return total > 0 ? vis / total : 0;
}

// ============================================================
// COLOR RAMPS → RGBA (per-pixel alpha; global translucency via overlay opacity)
// ============================================================
function _lerp(a, b, t) { return Math.round(a + (b - a) * t); }

// 0/NaN → transparent; >0..30 m → pale tan → deep green.
function canopyColorRamp(heightM) {
  if (!Number.isFinite(heightM) || heightM <= 0) return [0, 0, 0, 0];
  const t = Math.min(heightM, 30) / 30;
  return [_lerp(237, 13, t), _lerp(201, 94, t), _lerp(135, 40, t), 255];
}

function viewshedColorRamp(v) {
  return v ? [34, 197, 94, 255] : [0, 0, 0, 0]; // --accent-green
}

function canopyGridToRGBA(grid, canopyFlat) {
  const n = grid.rows * grid.cols;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const c = canopyColorRamp(canopyFlat[i]);
    const o = i * 4;
    rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3];
  }
  return rgba;
}

// ============================================================
// 3D CANOPY SURFACE MESH — decimate the canopy grid to a renderable vertex
// count and triangulate it into a surface for the custom WebGL layer.
// ============================================================

// Decimate to at most maxDim × maxDim vertices. Each decimated cell
// MAX-POOLS its source block (point-sampling would arbitrarily drop half
// the trees and speckle the surface); at full resolution (maxDim >= grid
// dim) the blocks are single cells and this is a pass-through. Returns
// { rows, cols, lats, lngs, canopy } where lats[r]/lngs[c] are vertex
// positions (block centres) and canopy is Float32Array(rows*cols) of
// heights in m (NaN/<=0 normalized to 0 so the triangulator can hole/fade).
function decimateCanopyMesh(grid, canopyFlat, maxDim) {
  const dim = Math.max(2, Math.min(maxDim || MAX_GRID, Math.max(grid.rows, grid.cols)));
  const rows = Math.min(grid.rows, dim), cols = Math.min(grid.cols, dim);
  const lats = new Float64Array(rows), lngs = new Float64Array(cols);
  const canopy = new Float32Array(rows * cols);
  const blockOf = (i, n, srcN) => {
    const a = Math.floor(i * srcN / n);
    return [a, Math.max(a + 1, Math.floor((i + 1) * srcN / n))];
  };
  for (let c = 0; c < cols; c++) {
    const [c0, c1] = blockOf(c, cols, grid.cols);
    lngs[c] = gridColToLng(grid, (c0 + c1 - 1) / 2);
  }
  for (let r = 0; r < rows; r++) {
    const [r0, r1] = blockOf(r, rows, grid.rows);
    lats[r] = gridRowToLat(grid, (r0 + r1 - 1) / 2);
    for (let c = 0; c < cols; c++) {
      const [c0, c1] = blockOf(c, cols, grid.cols);
      let max = 0;
      for (let sr = r0; sr < r1; sr++) {
        for (let sc = c0; sc < c1; sc++) {
          const v = canopyFlat[sr * grid.cols + sc];
          if (Number.isFinite(v) && v > max) max = v;
        }
      }
      canopy[r * cols + c] = max;
    }
  }
  return { rows, cols, lats, lngs, canopy };
}

// Mesh → INDEXED triangle surface: shared vertices + Uint32 index triples
// (6× less vertex data than unindexed at full grid resolution). A quad is
// emitted when ANY of its four corners has canopy > 0; zero-canopy corners
// sit at ground level, so the surface tapers to the ground at clearing
// edges instead of cutting hard swiss-cheese holes. Fully-zero regions emit
// nothing. Returns
// { vRow, vCol, vCanopy, vColor (rgba per vertex, 0..1), indices } —
// vertex lat/lng come from mesh.lats[vRow[i]] / mesh.lngs[vCol[i]].
// opts.color: [r,g,b] 0..1 → a single uniform OPAQUE color for every vertex
// (rendered in the opaque pass). Default: the 2D height ramp, with alpha 0
// on zero-canopy edge verts for translucent-pass fading.
// opts.minH: metres of canopy below which a corner does not count as
// forested (default 0) — culls near-ground scrub that would z-fight the
// terrain surface.
function canopyMeshIndexed(mesh, opts) {
  const { rows, cols, canopy } = mesh;
  const map = new Int32Array(rows * cols).fill(-1);
  const vRow = [], vCol = [], vCanopy = [];
  const indices = [];
  const reg = (r, c) => {
    const k = r * cols + c;
    if (map[k] === -1) {
      map[k] = vRow.length;
      vRow.push(r); vCol.push(c); vCanopy.push(canopy[k]);
    }
    return map[k];
  };
  const minH = (opts && opts.minH) || 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if (!(canopy[r * cols + c] > minH || canopy[r * cols + c + 1] > minH
        || canopy[(r + 1) * cols + c] > minH || canopy[(r + 1) * cols + c + 1] > minH)) continue;
      const a = reg(r, c), b = reg(r, c + 1), d = reg(r + 1, c + 1), e = reg(r + 1, c);
      indices.push(a, b, d, a, d, e);
    }
  }
  const uniform = opts && opts.color;
  const vColor = new Float32Array(vRow.length * 4);
  for (let i = 0; i < vRow.length; i++) {
    if (uniform) {
      vColor[i * 4] = uniform[0];
      vColor[i * 4 + 1] = uniform[1];
      vColor[i * 4 + 2] = uniform[2];
      vColor[i * 4 + 3] = 1;
      continue;
    }
    const h = vCanopy[i];
    // Zero-canopy edge verts keep a low-ramp tint so the fade doesn't darken
    // through black — only their alpha goes to 0.
    const ramp = canopyColorRamp(h > 0 ? h : 0.5);
    vColor[i * 4] = ramp[0] / 255;
    vColor[i * 4 + 1] = ramp[1] / 255;
    vColor[i * 4 + 2] = ramp[2] / 255;
    vColor[i * 4 + 3] = h > 0 ? ramp[3] / 255 : 0;
  }
  return {
    vRow: Int32Array.from(vRow), vCol: Int32Array.from(vCol),
    vCanopy: Float32Array.from(vCanopy), vColor,
    indices: Uint32Array.from(indices),
  };
}

// Unit ENU surface normal from local slopes dz/dx (east) and dz/dy (north),
// all in meters. Flat ground → [0,0,1]. Used to light the 3D canopy surface
// by sun/moon position.
function normalFromSlopes(dzdx, dzdy) {
  const len = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
  return [-dzdx / len, -dzdy / len, 1 / len];
}

function viewshedMaskToRGBA(grid, mask) {
  const n = grid.rows * grid.cols;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const c = viewshedColorRamp(mask[i]);
    const o = i * 4;
    rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3];
  }
  return rgba;
}

// ============================================================
// GEOTIFF ENCODER (pure) — write a georeferenced RGBA GeoTIFF for the canopy /
// viewshed overlays. Uncompressed, single-strip, little-endian.
// `rgba` is the Uint8ClampedArray from canopyGridToRGBA / viewshedMaskToRGBA;
// `bounds` is {west,south,east,north} in the units of `opts.epsg`
// (degrees for 4326, metres for projected CRSs like 3857).
// `opts.epsg` defaults to 4326 (geographic). Pass 3857 for Web Mercator —
// CalTopo's "Map Sheet" GeoTIFF import expects EPSG:3857.
// ============================================================
function encodeGeoTiffRGBA(rgba, width, height, bounds, opts) {
  opts = opts || {};
  const epsg = opts.epsg || 4326;
  const SAMPLES = 4;
  const imageLen = width * height * SAMPLES;
  const NUM_TAGS = 14;
  const ifdLen = 2 + NUM_TAGS * 12 + 4;
  const ifdOffset = 8 + imageLen;

  // External value blocks live after the IFD; doubles padded to 8-byte alignment.
  const align8 = (o) => (o % 8 === 0 ? o : o + (8 - (o % 8)));
  let ext = ifdOffset + ifdLen;
  const bpsOffset = ext; ext = bpsOffset + 8;            // BitsPerSample: 4 shorts
  const pixScaleOffset = align8(ext); ext = pixScaleOffset + 24; // ModelPixelScale: 3 doubles
  const tiepointOffset = align8(ext); ext = tiepointOffset + 48; // ModelTiepoint: 6 doubles
  const geoKeyOffset = ext; ext = geoKeyOffset + 32;     // GeoKeyDirectory: 16 shorts
  const totalLen = ext;

  const buf = new ArrayBuffer(totalLen);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const LE = true;

  // TIFF header (little-endian)
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49); // "II"
  dv.setUint16(2, 42, LE);
  dv.setUint32(4, ifdOffset, LE);

  // Image strip — RGBA, row-major, top (north) row first.
  if (rgba && rgba.length) u8.set(rgba.length > imageLen ? rgba.subarray(0, imageLen) : rgba, 8);

  // IFD
  const SHORT = 3, LONG = 4, DOUBLE = 12;
  const TSIZE = { 3: 2, 4: 4, 12: 8 };
  let p = ifdOffset;
  dv.setUint16(p, NUM_TAGS, LE); p += 2;
  function tag(id, type, count, val) {
    dv.setUint16(p, id, LE); dv.setUint16(p + 2, type, LE); dv.setUint32(p + 4, count, LE);
    if (TSIZE[type] * count <= 4) {
      if (type === SHORT) { dv.setUint16(p + 8, val, LE); dv.setUint16(p + 10, 0, LE); }
      else dv.setUint32(p + 8, val, LE);
    } else {
      dv.setUint32(p + 8, val, LE); // offset to external value
    }
    p += 12;
  }
  tag(256, LONG, 1, width);        // ImageWidth
  tag(257, LONG, 1, height);       // ImageLength
  tag(258, SHORT, 4, bpsOffset);   // BitsPerSample [8,8,8,8]
  tag(259, SHORT, 1, 1);           // Compression = none
  tag(262, SHORT, 1, 2);           // PhotometricInterpretation = RGB
  tag(273, LONG, 1, 8);            // StripOffsets -> image data at byte 8
  tag(277, SHORT, 1, SAMPLES);     // SamplesPerPixel
  tag(278, LONG, 1, height);       // RowsPerStrip (single strip)
  tag(279, LONG, 1, imageLen);     // StripByteCounts
  tag(284, SHORT, 1, 1);           // PlanarConfiguration = chunky
  tag(338, SHORT, 1, 2);           // ExtraSamples = unassociated alpha
  tag(33550, DOUBLE, 3, pixScaleOffset); // ModelPixelScale
  tag(33922, DOUBLE, 6, tiepointOffset); // ModelTiepoint
  tag(34735, SHORT, 16, geoKeyOffset);   // GeoKeyDirectory
  dv.setUint32(p, 0, LE);          // no next IFD

  // External values
  for (let i = 0; i < 4; i++) dv.setUint16(bpsOffset + i * 2, 8, LE);
  const sx = (bounds.east - bounds.west) / width;
  const sy = (bounds.north - bounds.south) / height;
  dv.setFloat64(pixScaleOffset, sx, LE);
  dv.setFloat64(pixScaleOffset + 8, sy, LE);
  dv.setFloat64(pixScaleOffset + 16, 0, LE);
  // Tiepoint: raster (0,0) = top-left = (west, north).
  const tp = [0, 0, 0, bounds.west, bounds.north, 0];
  for (let i = 0; i < 6; i++) dv.setFloat64(tiepointOffset + i * 8, tp[i], LE);
  // GeoKeyDirectory: PixelIsArea + either geographic (GTModelType=2,
  // GeographicTypeGeoKey 2048) or projected (GTModelType=1, ProjectedCSTypeGeoKey 3072).
  const projected = epsg !== 4326;
  const csKey = projected ? 3072 : 2048;
  const modelType = projected ? 1 : 2;
  const geoKeys = [1, 1, 0, 3, 1024, 0, 1, modelType, 1025, 0, 1, 1, csKey, 0, 1, epsg];
  for (let i = 0; i < geoKeys.length; i++) dv.setUint16(geoKeyOffset + i * 2, geoKeys[i], LE);

  return buf;
}

// ESRI world file (.tfw) for a north-up EPSG:4326 raster + matching .prj WKT —
// sidecars some tools use when they don't read the embedded GeoTIFF georeferencing.
function worldFileForBounds(bounds, width, height) {
  const sx = (bounds.east - bounds.west) / width;
  const sy = (bounds.north - bounds.south) / height;
  const fmt = (v) => (Math.abs(v) < 1e-13 ? '0' : v.toFixed(12));
  return [
    fmt(sx),                    // A: pixel size in X
    '0',                        // D
    '0',                        // B
    fmt(-sy),                   // E: pixel size in Y (negative — north up)
    fmt(bounds.west + sx / 2),  // C: X of centre of top-left pixel
    fmt(bounds.north - sy / 2), // F: Y of centre of top-left pixel
  ].join('\n') + '\n';
}
const WGS84_WKT = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
  'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';

// Resample an EPSG:4326 (geographic, row 0 = north) RGBA grid onto a square-pixel
// EPSG:3857 (Web Mercator) grid — the projection CalTopo's GeoTIFF import expects.
// `grid` has .bounds {west,east,south,north} (degrees) and .cols/.rows matching rgba.
// Returns { rgba, width, height, bounds } where bounds are in Web-Mercator metres.
function reprojectRgbaTo3857(rgba, grid) {
  const b = grid.bounds;
  const minX = lngToMercX(b.west), maxX = lngToMercX(b.east);
  const minY = latToMercY(b.south), maxY = latToMercY(b.north);
  const mercW = maxX - minX, mercH = maxY - minY;
  const srcCols = grid.cols, srcRows = grid.rows;
  // Square metric pixels; longer side ~ the source's longer side.
  const res = Math.max(mercW, mercH) / Math.max(1, Math.max(srcCols, srcRows));
  const outW = Math.max(1, Math.round(mercW / res));
  const outH = Math.max(1, Math.round(mercH / res));
  const out = new Uint8ClampedArray(outW * outH * 4);
  const lonSpan = b.east - b.west, latSpan = b.north - b.south;
  for (let row = 0; row < outH; row++) {
    const my = maxY - (row + 0.5) * (mercH / outH);
    const lat = mercYToLat(my);
    const srcRow = Math.floor((b.north - lat) / latSpan * srcRows);
    for (let col = 0; col < outW; col++) {
      const o = (row * outW + col) * 4;
      if (srcRow < 0 || srcRow >= srcRows) continue; // leave transparent (0,0,0,0)
      const mx = minX + (col + 0.5) * (mercW / outW);
      const lng = mercXToLng(mx);
      const srcCol = Math.floor((lng - b.west) / lonSpan * srcCols);
      if (srcCol < 0 || srcCol >= srcCols) continue;
      const si = (srcRow * srcCols + srcCol) * 4;
      out[o] = rgba[si]; out[o + 1] = rgba[si + 1]; out[o + 2] = rgba[si + 2]; out[o + 3] = rgba[si + 3];
    }
  }
  return { rgba: out, width: outW, height: outH, bounds: { west: minX, east: maxX, south: minY, north: maxY } };
}
const WEBMERC_WKT = 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",' +
  'SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],' +
  'PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],' +
  'PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AXIS["X",EAST],AXIS["Y",NORTH],' +
  'AUTHORITY["EPSG","3857"]]';

// --- Minimal store-only ZIP (for KMZ) ---
const _CRC_TABLE = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ _CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
// entries: [{ name, data: Uint8Array }]. Returns a Uint8Array of the ZIP (stored, no
// compression) — enough for KMZ (doc.kml + image). DOS time/date are fixed (no clock).
function zipStore(entries) {
  const enc = (s) => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xFF; return a; };
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = enc(e.name);
    const data = e.data;
    const crc = crc32(data);
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);   // local file header sig
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0, true);            // flags
    lv.setUint16(8, 0, true);            // method = store
    lv.setUint16(10, 0, true);           // mod time
    lv.setUint16(12, 0x21, true);        // mod date (1980-01-01)
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           // extra len
    lh.set(nameBytes, 30);
    locals.push(lh, data);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);   // central dir sig
    cv.setUint16(4, 20, true);           // version made by
    cv.setUint16(6, 20, true);           // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);      // local header offset
    ch.set(nameBytes, 46);
    central.push(ch);

    offset += lh.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);     // EOCD sig
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);        // central dir offset
  const parts = locals.concat(central, [eocd]);
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ============================================================
// OBSERVER / VIEWSHED RECORDS (pure) — multi-observer support. A record bundles
// an observer location with its computed viewshed (mask + grid) so it can be
// saved, re-displayed without recompute, and exported.
// ============================================================

// Normalize/validate a viewshed record. Caller supplies `id` (and usually a grid+mask
// once computed). `mask` is coerced to Uint8Array. Returns null if observer is invalid.
function makeViewshedRecord(opts) {
  opts = opts || {};
  const o = opts.observer || {};
  const lat = +o.lat, lng = +o.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let mask = opts.mask;
  if (mask != null && !(mask instanceof Uint8Array)) mask = new Uint8Array(mask);
  return {
    id: opts.id,
    areaKey: opts.areaKey != null ? opts.areaKey : null,
    name: opts.name != null ? String(opts.name) : '',
    observer: { lat, lng },
    aglFt: Number.isFinite(+opts.aglFt) ? +opts.aglFt : 200,
    vlosFt: Number.isFinite(+opts.vlosFt) ? +opts.vlosFt : 2500,
    grid: opts.grid || null,
    mask: mask || null,
    coverage: opts.coverage != null ? opts.coverage : null,
    demSource: opts.demSource || null,
    canopySource: opts.canopySource || null,
    computedAt: opts.computedAt != null ? opts.computedAt : null,
  };
}

// Safe filename core for a viewshed export, e.g. "Ridge Top #2" -> "Ridge_Top_2".
function viewshedFilenameSlug(name) {
  const s = String(name == null ? '' : name)
    .replace(/[^A-Za-z0-9-]+/g, '_')   // non-alphanumerics -> underscore
    .replace(/_+/g, '_')                // collapse runs
    .replace(/^_+|_+$/g, '')            // trim
    .slice(0, 40);
  return s || 'observer';
}

// Resolve a name collision against a set/array of existing names: "Ridge" -> "Ridge (2)".
function uniqueViewshedName(base, existingNames) {
  const set = existingNames instanceof Set ? existingNames : new Set(existingNames || []);
  let name = String(base == null || base === '' ? 'Observer' : base).trim() || 'Observer';
  if (!set.has(name)) return name;
  for (let i = 2; ; i++) {
    const cand = `${name} (${i})`;
    if (!set.has(cand)) return cand;
  }
}

// Plain-text KML <description> for an observer point (no HTML — reads cleanly in CalTopo).
function observerKmlDescription(rec) {
  if (!rec) return '';
  const o = rec.observer || {};
  const cov = (rec.coverage == null) ? (rec.grid && rec.mask ? '--' : 'not computed')
    : Math.round(rec.coverage * 100) + '% of VLOS visible';
  const lines = [
    rec.name ? `Observer: ${rec.name}` : 'Observer',
    (Number.isFinite(+o.lat) && Number.isFinite(+o.lng)) ? `Location: ${(+o.lat).toFixed(5)}, ${(+o.lng).toFixed(5)}` : '',
    `Drone AGL: ${rec.aglFt} ft`,
    `VLOS range: ${rec.vlosFt} ft`,
    `Viewshed: ${cov}`,
    rec.demSource ? `Terrain: ${rec.demSource}` : '',
    rec.canopySource ? `Canopy: ${rec.canopySource}` : '',
    rec.computedAt ? `Computed: ${new Date(rec.computedAt).toISOString()}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

// --- CJS export for Node/Vitest ---
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    M_PER_FT, FT_PER_M, R_EARTH_M, PILOT_EYE_M, VLOS_DEFAULT_M, WORK_RES_M,
    MAX_GRID, KERNEL_SENTINEL, META_ZOOM, META_BASE_DEFAULT,
    ftToM, mToFt, mercatorY, mercatorLatFromY, WEBMERC_R,
    lngToMercX, latToMercY, mercXToLng, mercYToLat,
    lngLatToTileXY, tileXYToQuadkey, quadkeyToTileXY, tileXYBounds, quadkeyBounds, metaQuadkeysForBBox,
    makeGrid, gridColToLng, gridRowToLat, gridLngToCol, gridLatToRow, latLngToCell,
    sampleGridBilinear,
    resampleToGrid, buildDSM, sanitizeForKernel,
    curvatureDrop, isVisible, computeViewshed, viewshedCoverage,
    canopyColorRamp, viewshedColorRamp, canopyGridToRGBA, viewshedMaskToRGBA,
    decimateCanopyMesh, canopyMeshIndexed, normalFromSlopes,
    encodeGeoTiffRGBA, reprojectRgbaTo3857, worldFileForBounds, WGS84_WKT, WEBMERC_WKT, crc32, zipStore,
    makeViewshedRecord, viewshedFilenameSlug, uniqueViewshedName, observerKmlDescription,
  };
}

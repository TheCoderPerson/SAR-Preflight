// ============================================================
// SAR Preflight — Raster & Viewshed Math (pure, DOM/Leaflet/fetch-free)
// Vegetation-height handling + line-of-sight viewshed.
// Ported from the EDSAR SAR_UAS_Segment tool (raster/los.py, raster/dsm.py).
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

// --- CJS export for Node/Vitest ---
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    M_PER_FT, FT_PER_M, R_EARTH_M, PILOT_EYE_M, VLOS_DEFAULT_M, WORK_RES_M,
    MAX_GRID, KERNEL_SENTINEL, META_ZOOM, META_BASE_DEFAULT,
    ftToM, mToFt, mercatorY, mercatorLatFromY, WEBMERC_R,
    lngToMercX, latToMercY, mercXToLng, mercYToLat,
    lngLatToTileXY, tileXYToQuadkey, quadkeyToTileXY, tileXYBounds, quadkeyBounds, metaQuadkeysForBBox,
    makeGrid, gridColToLng, gridRowToLat, gridLngToCol, gridLatToRow, latLngToCell,
    resampleToGrid, buildDSM, sanitizeForKernel,
    curvatureDrop, isVisible, computeViewshed, viewshedCoverage,
    canopyColorRamp, viewshedColorRamp, canopyGridToRGBA, viewshedMaskToRGBA,
  };
}

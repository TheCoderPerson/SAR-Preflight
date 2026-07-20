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
// Stamp OSM building footprints onto the DSM as solid obstacles:
// dsm = max(dsm, dem + heightM) for every cell whose CENTER falls inside a
// footprint (same cell-center rule as the canopy ops). `buildings` is the
// parseOverpassBuildings shape — footprint is an open ring of [lon, lat]
// pairs. Cells with unknown ground (NaN dem) are left alone so the kernel's
// missing-data sentinel handling stays intact; call BEFORE sanitizeForKernel.
// Returns the number of buildings that stamped at least one cell.
// ============================================================
function stampBuildingsOnDSM(grid, dsm, demFlat, buildings) {
  if (!grid || !dsm || !demFlat || !buildings || !buildings.length) return 0;
  let stamped = 0;
  for (const b of buildings) {
    const fp = b && b.footprint;
    const hM = b && b.heightM;
    if (!fp || fp.length < 3 || !Number.isFinite(hM) || hM <= 0) continue;
    let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
    for (const p of fp) {
      if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0];
      if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1];
    }
    if (e < grid.west || w > grid.east || n < grid.south || s > grid.north) continue;
    const r0 = gridLatToRow(grid, n), r1 = gridLatToRow(grid, s);
    const c0 = gridLngToCol(grid, w), c1 = gridLngToCol(grid, e);
    let hit = false;
    for (let row = r0; row <= r1; row++) {
      const lat = gridRowToLat(grid, row);
      for (let col = c0; col <= c1; col++) {
        const lng = gridColToLng(grid, col);
        // Ray-cast in lon/lat space against the [lon, lat] ring.
        let inside = false;
        for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
          const xi = fp[i][0], yi = fp[i][1], xj = fp[j][0], yj = fp[j][1];
          if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
        }
        if (!inside) continue;
        const idx = row * grid.cols + col;
        const g = demFlat[idx];
        if (!Number.isFinite(g)) continue;
        const z = g + hM;
        if (!(dsm[idx] >= z)) dsm[idx] = z; // NaN-safe max
        hit = true;
      }
    }
    if (hit) stamped++;
  }
  return stamped;
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

// ============================================================
// SUN-SHADOW KERNEL — how shaded is each cell from a light source at
// (azimuthDeg, elevationDeg)? Classic DEM shadow-cast sweep: rays enter the
// grid from the sun-facing edges and march away from the sun along the
// dominant axis; each ray carries a "shadow front" height that descends at
// tan(elevation) per metre travelled. A cell below the front is in shadow;
// a cell at/above it is lit and resets the front to its own height. Slopes
// facing away from the sun fall out of this naturally (terrain dropping
// faster than the ray descends stays under the front). O(cells) total.
//
// Two anti-aliasing measures keep coarse/rough DEMs from producing hard
// synchronized speckle ("comb" stripes at low sun over corrugated terrain):
// the terrain is sampled BILINEARLY along the ray (all rays share the same
// fractional stepping pattern, so nearest-cell sampling makes every ray jump
// rows at the same columns), and the result is a GRADED shade depth rather
// than a binary verdict — cells barely below the shadow front get partial
// values, so marginal cells render as faint shade instead of flickering.
//
// Returns Uint8Array: 0 = sunlit or unknown (NaN) terrain, 255 = fully
// shaded, 1..254 = penumbra/marginal shade (soft edge). Sun at/below the
// horizon → every known cell is 255 (night).
// ============================================================
function computeShadowMask(grid, dem, sunAzDeg, sunElDeg) {
  const cols = grid.cols, rows = grid.rows, n = rows * cols;
  const out = new Uint8Array(n);
  if (!dem) return out;
  if (!(sunElDeg > 0)) {
    for (let i = 0; i < n; i++) if (Number.isFinite(dem[i])) out[i] = 255;
    return out;
  }
  if (cols < 2 || rows < 2) return out; // a 1-cell strip can't cast shadows
  const az = sunAzDeg * Math.PI / 180;
  // Horizontal direction the LIGHT travels (away from the sun), in grid axes:
  // +x = east = +col; grid rows grow southward, so +y(row) = -north.
  let dx = -Math.sin(az);
  let dy = Math.cos(az);
  const dom = Math.max(Math.abs(dx), Math.abs(dy));
  if (!(dom > 0)) return out; // degenerate (never happens for a real azimuth)
  dx /= dom; dy /= dom;
  const dropM = Math.tan(sunElDeg * Math.PI / 180) * Math.hypot(dx, dy) * grid.resM;
  // Soft-edge width: full shade only when the terrain sits at least this far
  // below the shadow front. Scaled to the per-step drop (bounded) so the
  // penumbra spans roughly one ray step regardless of grid resolution.
  const softM = Math.max(2, Math.min(15, dropM));

  // Bilinear terrain sample at fractional cell coords (clamped to the grid).
  // Falls back to the heaviest finite corner when a neighbour is NaN.
  const zAt = (x, y) => {
    let x0 = Math.floor(x), y0 = Math.floor(y);
    if (x0 < 0) x0 = 0; else if (x0 > cols - 2) x0 = cols - 2;
    if (y0 < 0) y0 = 0; else if (y0 > rows - 2) y0 = rows - 2;
    const tx = Math.min(1, Math.max(0, x - x0)), ty = Math.min(1, Math.max(0, y - y0));
    const i00 = y0 * cols + x0;
    const v00 = dem[i00], v10 = dem[i00 + 1], v01 = dem[i00 + cols], v11 = dem[i00 + cols + 1];
    if (Number.isFinite(v00) && Number.isFinite(v10) && Number.isFinite(v01) && Number.isFinite(v11)) {
      return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
    }
    let best = NaN, bestW = -1;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    if (Number.isFinite(v00) && w00 > bestW) { best = v00; bestW = w00; }
    if (Number.isFinite(v10) && w10 > bestW) { best = v10; bestW = w10; }
    if (Number.isFinite(v01) && w01 > bestW) { best = v01; bestW = w01; }
    if (Number.isFinite(v11) && w11 > bestW) { best = v11; bestW = w11; }
    return best;
  };

  const trace = (sx, sy) => {
    let x = sx, y = sy;
    let frontZ = -Infinity;
    while (x > -0.5 && x < cols - 0.5 && y > -0.5 && y < rows - 0.5) {
      const z = zAt(x, y);
      if (Number.isFinite(z)) {
        if (z >= frontZ) {
          frontZ = z;
        } else {
          const idx = Math.round(y) * cols + Math.round(x);
          if (Number.isFinite(dem[idx])) {
            const d = (frontZ - z) / softM;
            const v = d >= 1 ? 255 : Math.round(d * 255);
            if (v > out[idx]) out[idx] = v;
          }
        }
      }
      x += dx; y += dy;
      frontZ -= dropM;
    }
  };

  // Rays start on the edge(s) the light enters through; together the two
  // entry edges cover every cell (dominant-axis stepping, unit ray spacing).
  if (dx > 1e-12) for (let r = 0; r < rows; r++) trace(0, r);
  else if (dx < -1e-12) for (let r = 0; r < rows; r++) trace(cols - 1, r);
  if (dy > 1e-12) for (let c = 0; c < cols; c++) trace(c, 0);
  else if (dy < -1e-12) for (let c = 0; c < cols; c++) trace(c, rows - 1);
  return out;
}

// Shade depth (0..255) → translucent cool dark with proportional alpha;
// sunlit / unknown → fully transparent. (Global translucency comes from the
// overlay's opacity slider on top of the per-pixel alpha.)
function shadowColorRamp(v) {
  return v ? [11, 18, 32, v] : [0, 0, 0, 0];
}

function shadowMaskToRGBA(grid, mask) {
  const n = grid.rows * grid.cols;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const c = shadowColorRamp(mask[i]);
    const o = i * 4;
    rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3];
  }
  return rgba;
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
// TERRAIN HORIZON PROFILE — max apparent elevation angle of the bare-earth
// skyline around the observer, one value per azimuth bin (stepDeg apart,
// bin 0 centered on North, clockwise). Computed from a WIDE, coarse DEM
// (several km — far beyond the viewshed grid) so a ridge on the sunrise
// bearing is known to block the actual sun. Bare earth only: trees would
// raise the true horizon, so glare can be over-reported near cover, never
// silently under-reported. Returns { stepDeg, angles: number[] } (degrees;
// -90 where no data) or null when the observer ground is unknown.
// ============================================================
// Optional `minDistM` skips terrain nearer than that distance — used to build
// a "beyond the viewshed grid" skyline that seeds the backdrop analysis.
function computeHorizonProfile(grid, demFlat, obsLat, obsLng, eyeM, stepDeg, minDistM) {
  if (!grid || !demFlat) return null;
  const step = stepDeg || 3;
  const eye = eyeM != null ? eyeM : PILOT_EYE_M;
  const g0 = sampleGridBilinear(grid, demFlat, obsLat, obsLng);
  if (!Number.isFinite(g0)) return null;
  const eyeZ = g0 + eye;
  const maxD = Math.hypot(
    Math.max(grid.north - obsLat, obsLat - grid.south) * grid.mPerDegLat,
    Math.max(grid.east - obsLng, obsLng - grid.west) * grid.mPerDegLng);
  const startD = Math.max(grid.resM, minDistM || 0);
  const n = Math.round(360 / step);
  const angles = new Array(n).fill(-90);
  for (let i = 0; i < n; i++) {
    const az = i * step * Math.PI / 180;
    const sinA = Math.sin(az), cosA = Math.cos(az);
    let best = -90;
    for (let d = startD; d <= maxD; d += grid.resM) {
      const z = sampleGridBilinear(grid, demFlat, obsLat + (cosA * d) / grid.mPerDegLat, obsLng + (sinA * d) / grid.mPerDegLng);
      if (!Number.isFinite(z)) continue; // nodata hole — keep walking to the edge
      const a = Math.atan2(z - eyeZ, d) * 180 / Math.PI;
      if (a > best) best = a;
    }
    angles[i] = best;
  }
  return { stepDeg: step, angles };
}

// ============================================================
// TERRAIN-BACKDROP SECTORS — for each of `sectors` compass sectors (default
// 16, sector 0 = North, clockwise), the fraction of in-VLOS drone positions
// along the sector's center ray that would appear BELOW the terrain/canopy
// skyline behind them, seen from the observer's eye. A drone against a
// terrain backdrop (instead of open sky) is far harder to keep in sight.
// Uses the same DSM the viewshed kernel tests against (terrain + canopy +
// buildings, NaN already replaced by the sentinel).
// opts.farHorizonDeg — per-sector skyline angle (deg) of terrain BEYOND the
//   grid edge (computeHorizonProfile with minDistM), so a mountain rising
//   past VLOS still backdrops the drone. Without it the skyline is only
//   known to the grid edge.
// opts.mask — the viewshed mask on the same grid; when given, only positions
//   where the drone is actually VISIBLE are counted (a drone hidden behind a
//   crest is a coverage problem, not a backdrop problem).
// Returns Array(sectors) of fractions 0..1, or null when the observer's
// ground elevation is unknown.
// ============================================================
function computeBackdropSectors(opts) {
  const grid = opts.grid, dem = opts.dem, dsm = opts.dsm;
  const obsCol = opts.obsCol, obsRow = opts.obsRow, aglM = opts.aglM;
  const vlosRangeM = opts.vlosRangeM != null ? opts.vlosRangeM : VLOS_DEFAULT_M;
  const nSec = opts.sectors || 16;
  const eyeM = opts.pilotEyeM != null ? opts.pilotEyeM : PILOT_EYE_M;
  const far = opts.farHorizonDeg || null;
  const mask = opts.mask || null;
  const obsGround = dem[obsRow * grid.cols + obsCol];
  if (!Number.isFinite(obsGround)) return null;
  const eyeZ = obsGround + eyeM;
  const obsLat = gridRowToLat(grid, obsRow), obsLng = gridColToLng(grid, obsCol);
  const step = grid.resM;
  // Farthest possible in-grid distance from the observer (to walk each ray
  // all the way out — skyline BEYOND the VLOS ring still matters).
  const maxD = Math.hypot(
    Math.max((grid.north - obsLat), (obsLat - grid.south)) * grid.mPerDegLat,
    Math.max((grid.east - obsLng), (obsLng - grid.west)) * grid.mPerDegLng);
  const fracs = new Array(nSec).fill(0);
  for (let s = 0; s < nSec; s++) {
    const az = s * 2 * Math.PI / nSec; // 0 = north, clockwise
    const sinA = Math.sin(az), cosA = Math.cos(az);
    const terr = [], drone = [], dist = [], vis = [];
    for (let d = step; d <= maxD; d += step) {
      const lat = obsLat + (cosA * d) / grid.mPerDegLat;
      const lng = obsLng + (sinA * d) / grid.mPerDegLng;
      const z = sampleGridBilinear(grid, dsm, lat, lng);
      if (!Number.isFinite(z)) break; // sanitized DSM has no NaN → left the grid
      const g = sampleGridBilinear(grid, dem, lat, lng);
      terr.push(Math.atan2(z - eyeZ, d));                                  // skyline candidate
      drone.push(Number.isFinite(g) ? Math.atan2(g + aglM - eyeZ, d) : NaN); // drone apparent angle
      dist.push(d);
      vis.push(mask ? !!mask[gridLatToRow(grid, lat) * grid.cols + gridLngToCol(grid, lng)] : true);
    }
    // Walk far → near so each drone position is compared against the highest
    // terrain angle strictly BEYOND it — seeded with the beyond-grid skyline.
    let total = 0, hidden = 0;
    let skyline = (far && Number.isFinite(far[s])) ? far[s] * Math.PI / 180 : -Infinity;
    for (let i = terr.length - 1; i >= 0; i--) {
      if (dist[i] <= vlosRangeM && Number.isFinite(drone[i]) && vis[i]) {
        total++;
        if (drone[i] < skyline) hidden++;
      }
      if (terr[i] > skyline) skyline = terr[i];
    }
    fracs[s] = total ? hidden / total : 0;
  }
  return fracs;
}

// ============================================================
// Composite N computed viewsheds into ONE union grid + mask so several
// observers can drape through the app's single viewshed overlay (2D + 3D).
// The output mask holds the COUNT of observers that see each cell (0 = none),
// so the color ramp can shade overlap zones darker. Render-only: each record
// keeps its own full-resolution 0/1 grid/mask (exports are unaffected). Union
// resolution follows the finest member grid, capped at maxDim per axis so
// far-apart observers can't explode the canvas.
// ============================================================
function compositeViewsheds(records, maxDim) {
  const recs = (records || []).filter(r => r && r.grid && r.mask);
  if (!recs.length) return null;
  if (recs.length === 1) return { grid: recs[0].grid, mask: recs[0].mask };
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity, resM = Infinity;
  recs.forEach(r => {
    const b = r.grid.bounds;
    if (b.west < west) west = b.west;
    if (b.east > east) east = b.east;
    if (b.south < south) south = b.south;
    if (b.north > north) north = b.north;
    if (r.grid.resM < resM) resM = r.grid.resM;
  });
  const lat0 = (south + north) / 2, lng0 = (west + east) / 2;
  const mPerDegLat = 111320;
  const mPerDegLng = mPerDegLat * Math.cos(lat0 * Math.PI / 180);
  const cap = maxDim || 2 * MAX_GRID;
  let cols = Math.max(1, Math.ceil((east - west) * mPerDegLng / resM));
  let rows = Math.max(1, Math.ceil((north - south) * mPerDegLat / resM));
  const over = Math.max(rows, cols) / cap;
  if (over > 1) {
    rows = Math.max(1, Math.round(rows / over));
    cols = Math.max(1, Math.round(cols / over));
  }
  const grid = {
    lat0, lng0, west, east, south, north, rows, cols,
    resM: ((east - west) * mPerDegLng) / cols,
    mPerDegLat, mPerDegLng,
    bounds: { west, south, east, north },
  };
  const mask = new Uint8Array(rows * cols);
  recs.forEach(r => {
    const g = r.grid, m = r.mask;
    const r0 = gridLatToRow(grid, g.bounds.north);
    const r1 = gridLatToRow(grid, g.bounds.south);
    const c0 = gridLngToCol(grid, g.bounds.west);
    const c1 = gridLngToCol(grid, g.bounds.east);
    for (let row = r0; row <= r1; row++) {
      const lat = gridRowToLat(grid, row);
      const sy = Math.floor((g.north - lat) / (g.north - g.south) * g.rows);
      if (sy < 0 || sy >= g.rows) continue;
      for (let col = c0; col <= c1; col++) {
        const lng = gridColToLng(grid, col);
        const sx = Math.floor((lng - g.west) / (g.east - g.west) * g.cols);
        if (sx < 0 || sx >= g.cols) continue;
        if (m[sy * g.cols + sx]) {
          const idx = row * cols + col;
          if (mask[idx] < 255) mask[idx]++; // count of observers seeing this cell
        }
      }
    }
  });
  return { grid, mask };
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

// v = number of observers that see the cell (composite masks carry counts;
// single-viewshed masks are 0/1). Overlap zones step to darker greens.
function viewshedColorRamp(v) {
  if (!v) return [0, 0, 0, 0];
  if (v === 1) return [34, 197, 94, 255]; // --accent-green (green-500)
  if (v === 2) return [21, 128, 61, 255]; // 2 observers overlap (green-700)
  return [20, 83, 45, 255];               // 3+ observers overlap (green-900)
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
// CANOPY EDITING — user corrections to the canopy raster (delete polygons +
// paint strokes). Edits are stored as geographic OPERATIONS, not rasters, so
// they replay identically onto any grid (overlay, viewshed, 3D, export).
// Op shapes (plain JSON):
//   { t:'del',   poly: [[lat,lng],...] }               zero cells inside polygon
//   { t:'paint', pts: [[lat,lng],...], rM, hM }        stamp stroke at height hM
// ============================================================
const CANOPY_PAINT_DEFAULT_M = 10; // paint height when the raster has no trees to average

// Mean height of tree cells (finite, >0). count 0 → default paint height.
function canopyAvgHeight(canopyFlat) {
  let sum = 0, count = 0;
  if (canopyFlat) {
    for (let i = 0; i < canopyFlat.length; i++) {
      const v = canopyFlat[i];
      if (Number.isFinite(v) && v > 0) { sum += v; count++; }
    }
  }
  return { avgM: count ? sum / count : CANOPY_PAINT_DEFAULT_M, count };
}

// Circular brush stamp. Mutates canopyFlat; records FIRST-TOUCH old values into
// `diff` (Map<idx, oldVal>) so a whole stroke reverts to pre-stroke state.
// Guarantees >=1 cell when the point is inside the grid (radius may be < resM).
// Returns the number of cells painted by this stamp.
function canopyStampBrush(grid, canopyFlat, lat, lng, radiusM, heightM, diff) {
  const dLat = radiusM / grid.mPerDegLat;
  const dLng = radiusM / grid.mPerDegLng;
  const r0 = gridLatToRow(grid, lat + dLat), r1 = gridLatToRow(grid, lat - dLat);
  const c0 = gridLngToCol(grid, lng - dLng), c1 = gridLngToCol(grid, lng + dLng);
  const r2 = radiusM * radiusM;
  let painted = 0;
  for (let row = r0; row <= r1; row++) {
    const dy = (gridRowToLat(grid, row) - lat) * grid.mPerDegLat;
    for (let col = c0; col <= c1; col++) {
      const dx = (gridColToLng(grid, col) - lng) * grid.mPerDegLng;
      if (dx * dx + dy * dy > r2) continue;
      const idx = row * grid.cols + col;
      if (diff && !diff.has(idx)) diff.set(idx, canopyFlat[idx]);
      canopyFlat[idx] = heightM;
      painted++;
    }
  }
  if (!painted && lat >= grid.south && lat <= grid.north && lng >= grid.west && lng <= grid.east) {
    const idx = gridLatToRow(grid, lat) * grid.cols + gridLngToCol(grid, lng);
    if (diff && !diff.has(idx)) diff.set(idx, canopyFlat[idx]);
    canopyFlat[idx] = heightM;
    painted = 1;
  }
  return painted;
}

// Finalize a stroke's Map diff into compact typed arrays for the undo stack.
function canopyDiffToSparse(diffMap) {
  const n = diffMap ? diffMap.size : 0;
  const indices = new Uint32Array(n), oldValues = new Float32Array(n);
  let i = 0;
  if (diffMap) for (const [idx, v] of diffMap) { indices[i] = idx; oldValues[i] = v; i++; }
  return { indices, oldValues };
}

// Stamp a full polyline stroke, interpolating between points at radiusM/2 steps
// so fast drags leave no gaps. Returns a sparse diff of pre-stroke values.
function canopyApplyStroke(grid, canopyFlat, pts, radiusM, heightM) {
  const diff = new Map();
  if (pts && pts.length) {
    canopyStampBrush(grid, canopyFlat, pts[0][0], pts[0][1], radiusM, heightM, diff);
    const step = Math.max(radiusM / 2, 0.5);
    for (let i = 1; i < pts.length; i++) {
      const aLat = pts[i - 1][0], aLng = pts[i - 1][1];
      const bLat = pts[i][0], bLng = pts[i][1];
      const dist = Math.hypot((bLat - aLat) * grid.mPerDegLat, (bLng - aLng) * grid.mPerDegLng);
      const nSteps = Math.max(1, Math.ceil(dist / step));
      for (let s = 1; s <= nSteps; s++) {
        const t = s / nSteps;
        canopyStampBrush(grid, canopyFlat, aLat + (bLat - aLat) * t, aLng + (bLng - aLng) * t, radiusM, heightM, diff);
      }
    }
  }
  return canopyDiffToSparse(diff);
}

// Zero every cell whose CENTER falls inside the polygon (loop bounded by the
// polygon bbox). insideFn(lat,lng,poly) is injectable for Node tests; in the
// browser it defaults to the global pointInPolygon from core.js.
// Returns a sparse diff listing only previously-nonzero cells.
function canopyApplyDelete(grid, canopyFlat, poly, insideFn) {
  const inside = insideFn || (typeof pointInPolygon !== 'undefined' ? pointInPolygon : null);
  const diff = new Map();
  if (poly && poly.length >= 3 && inside) {
    let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
    for (const p of poly) {
      if (p[0] < s) s = p[0]; if (p[0] > n) n = p[0];
      if (p[1] < w) w = p[1]; if (p[1] > e) e = p[1];
    }
    const r0 = gridLatToRow(grid, n), r1 = gridLatToRow(grid, s);
    const c0 = gridLngToCol(grid, w), c1 = gridLngToCol(grid, e);
    for (let row = r0; row <= r1; row++) {
      const lat = gridRowToLat(grid, row);
      for (let col = c0; col <= c1; col++) {
        const idx = row * grid.cols + col;
        const v = canopyFlat[idx];
        if (!(Number.isFinite(v) && v > 0)) continue;
        if (!inside(lat, gridColToLng(grid, col), poly)) continue;
        diff.set(idx, v);
        canopyFlat[idx] = 0;
      }
    }
  }
  return canopyDiffToSparse(diff);
}

// Restore pre-op values recorded in a sparse diff.
function canopyRevertDiff(canopyFlat, diff) {
  if (!diff || !diff.indices) return;
  for (let i = 0; i < diff.indices.length; i++) canopyFlat[diff.indices[i]] = diff.oldValues[i];
}

// Geographic bbox of an op (paint strokes inflated by their brush radius).
function canopyOpBBox(op) {
  const pts = op ? (op.t === 'del' ? op.poly : op.pts) : null;
  if (!pts || !pts.length) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of pts) {
    if (p[0] < s) s = p[0]; if (p[0] > n) n = p[0];
    if (p[1] < w) w = p[1]; if (p[1] > e) e = p[1];
  }
  if (op.t === 'paint' && op.rM > 0) {
    const dLat = op.rM / 111320;
    const dLng = op.rM / (111320 * Math.cos((s + n) / 2 * Math.PI / 180) || 111320);
    s -= dLat; n += dLat; w -= dLng; e += dLng;
  }
  return { west: w, south: s, east: e, north: n };
}

// Ordered replay of an op log onto a grid's raster, skipping ops whose bbox
// misses the grid entirely. Returns how many ops touched this grid.
function canopyApplyOps(grid, canopyFlat, ops, insideFn) {
  if (!ops || !ops.length || !canopyFlat) return 0;
  const gb = grid.bounds;
  let applied = 0;
  for (const op of ops) {
    const bb = canopyOpBBox(op);
    if (!bb || bb.west > gb.east || bb.east < gb.west || bb.south > gb.north || bb.north < gb.south) continue;
    if (op.t === 'del') canopyApplyDelete(grid, canopyFlat, op.poly, insideFn);
    else if (op.t === 'paint') canopyApplyStroke(grid, canopyFlat, op.pts, op.rM, op.hM);
    else continue;
    applied++;
  }
  return applied;
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
    buildingCount: Number.isFinite(+opts.buildingCount) ? +opts.buildingCount : null, // null = OSM buildings not included in this compute
    backdrop: Array.isArray(opts.backdrop) ? Array.from(opts.backdrop, Number) : null, // per-sector terrain-backdrop fractions (computeBackdropSectors)
    horizon: (opts.horizon && Array.isArray(opts.horizon.angles))
      ? { stepDeg: +opts.horizon.stepDeg || 3, angles: Array.from(opts.horizon.angles, Number) }
      : null, // terrain horizon per azimuth (computeHorizonProfile) — masks sun-glare windows
    computedAt: opts.computedAt != null ? opts.computedAt : null,
    visible: opts.visible !== false, // shown on the map (multiple may be on at once)
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
// `extras` (optional, app-supplied — they need core.js helpers):
//   glareText:    formatted sun-glare windows for the export day
//   backdropText: formatted terrain-backdrop compass ranges
function observerKmlDescription(rec, extras) {
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
    rec.buildingCount != null ? `Buildings: ${rec.buildingCount} OSM footprints as obstacles` : '',
    (extras && extras.glareText) ? `Sun glare (export day): ${extras.glareText} — near-overhead passes can glare any time the sun is up` : '',
    (extras && extras.backdropText) ? `Terrain backdrop toward ${extras.backdropText} — drone below skyline, hard to see` : '',
    rec.computedAt ? `Computed: ${new Date(rec.computedAt).toISOString()}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

// ============================================================
// VIEWSHED -> VECTOR POLYGONS (pure) — low-poly polygon outlines of a binary
// viewshed mask for KML/GeoJSON export. Pipeline: 4-connected component
// labeling -> exact cell-edge boundary tracing (axis-aligned staircase rings,
// holes classified by shoelace sign) -> Douglas-Peucker simplification in cell
// space (grid cells are square in metres, so no lat/lng anisotropy) -> lattice
// vertices to lat/lng on cell EDGES. Deliberately coarse: small blobs/holes are
// dropped and part counts capped so exports stay light — the raster export is
// the authoritative representation.
// ============================================================

const VIEWSHED_POLY_TOL_CELLS      = 1.25;  // DP tolerance: collapses staircases, outline stays within ~1 cell
const VIEWSHED_POLY_MIN_BLOB_CELLS = 12;    // absolute blob floor (~100 m2 at 3 m res — too small to act on)
const VIEWSHED_POLY_MIN_BLOB_FRAC  = 0.005; // also drop blobs < 0.5% of total visible area
const VIEWSHED_POLY_MIN_HOLE_CELLS = 12;    // smaller holes are filled (treated visible)
const VIEWSHED_POLY_MAX_BLOBS      = 12;    // parts per observer, largest first
const VIEWSHED_POLY_MAX_HOLES     = 8;      // holes per part, largest first

// Label 4-connected components of a mask (any value >= 1 counts as visible —
// composite masks hold observer counts). Iterative flood fill, no recursion.
// Returns { labels: Int32Array (0 = background, 1..count), count, areas } where
// areas[L] = cell count of component L (areas[0] unused).
function labelMaskComponents(mask, rows, cols) {
  const n = rows * cols;
  const labels = new Int32Array(n);
  const areas = [0];
  let count = 0;
  const stack = [];
  for (let i = 0; i < n; i++) {
    if (!mask[i] || labels[i]) continue;
    count++;
    let area = 0;
    labels[i] = count;
    stack.push(i);
    while (stack.length) {
      const idx = stack.pop();
      area++;
      const r = (idx / cols) | 0, c = idx - r * cols;
      if (c > 0        && mask[idx - 1]    && !labels[idx - 1])    { labels[idx - 1] = count;    stack.push(idx - 1); }
      if (c < cols - 1 && mask[idx + 1]    && !labels[idx + 1])    { labels[idx + 1] = count;    stack.push(idx + 1); }
      if (r > 0        && mask[idx - cols] && !labels[idx - cols]) { labels[idx - cols] = count; stack.push(idx - cols); }
      if (r < rows - 1 && mask[idx + cols] && !labels[idx + cols]) { labels[idx + cols] = count; stack.push(idx + cols); }
    }
    areas.push(area);
  }
  return { labels, count, areas: Int32Array.from(areas) };
}

// Signed shoelace area of an open ring of [x,y] points. With traceLabelRings'
// interior-left convention (x=col east, y=row south), outer rings are NEGATIVE
// and hole rings positive; |area| = enclosed cells.
function _ringSignedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// Ray-cast point-in-polygon on an open [x,y] ring.
function _pointInRing(p, ring) {
  const x = p[0], y = p[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Trace every closed boundary ring of one labeled component on the
// (rows+1)x(cols+1) vertex lattice. Each boundary cell side becomes a directed
// edge that keeps the component on the LEFT of travel; walking edges (left ->
// straight -> right turn preference at diagonal-pinch vertices, which keeps
// rings simple and deterministic) yields open rings of [col,row] lattice
// vertices with collinear vertices merged. Returns
// [{ ring, areaCells, isOuter }] — outers have negative shoelace sign.
function traceLabelRings(labels, rows, cols, label) {
  const VW = cols + 1;                     // lattice width
  const DR = [0, 1, 0, -1], DC = [1, 0, -1, 0]; // dir codes: 0=E 1=S 2=W 3=N
  const edges = new Map();                 // start vertex key -> outgoing dir codes
  const addEdge = (r, c, dir) => {
    const k = r * VW + c;
    const a = edges.get(k);
    if (a) a.push(dir); else edges.set(k, [dir]);
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (labels[r * cols + c] !== label) continue;
      if (r === 0        || labels[(r - 1) * cols + c] !== label) addEdge(r, c + 1, 2);     // N side: travel W
      if (r === rows - 1 || labels[(r + 1) * cols + c] !== label) addEdge(r + 1, c, 0);     // S side: travel E
      if (c === 0        || labels[r * cols + c - 1] !== label)   addEdge(r, c, 1);         // W side: travel S
      if (c === cols - 1 || labels[r * cols + c + 1] !== label)   addEdge(r + 1, c + 1, 3); // E side: travel N
    }
  }

  const rings = [];
  for (const startKey of edges.keys()) {
    for (let avail0 = edges.get(startKey); avail0.length; ) {
      const startR = (startKey / VW) | 0, startC = startKey - startR * VW;
      const ring = [[startC, startR]];
      let key = startKey, prevDir = -1, firstDir = -1;
      do {
        const avail = edges.get(key);
        let dir;
        if (prevDir < 0 || avail.length === 1) dir = avail[0];
        else {
          const pref = [(prevDir + 3) % 4, prevDir, (prevDir + 1) % 4]; // left, straight, right
          dir = pref.find(d => avail.includes(d));
          if (dir === undefined) dir = avail[0];
        }
        avail.splice(avail.indexOf(dir), 1);
        if (firstDir < 0) firstDir = dir;
        const r = (key / VW) | 0, c = key - r * VW;
        const nr = r + DR[dir], nc = c + DC[dir];
        if (dir === prevDir) ring[ring.length - 1] = [nc, nr]; // collinear merge
        else ring.push([nc, nr]);
        prevDir = dir;
        key = nr * VW + nc;
      } while (key !== startKey);
      ring.pop();                                        // last vertex duplicates the start
      if (prevDir === firstDir && ring.length) ring.shift(); // start vertex itself collinear
      if (ring.length < 3) continue;
      const a = _ringSignedArea(ring);
      rings.push({ ring, areaCells: Math.abs(a), isOuter: a < 0 });
    }
  }
  return rings;
}

// Endpoint-anchored Douglas-Peucker on an open chain of [x,y] points (iterative).
function _dpSimplify(pts, tol) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const tol2 = tol * tol;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const seg = stack.pop();
    const a = seg[0], b = seg[1];
    if (b - a < 2) continue;
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0], py = pts[i][1];
      let d2;
      if (!len2) { const ex = px - ax, ey = py - ay; d2 = ex * ex + ey * ey; }
      else { const cross = dx * (py - ay) - dy * (px - ax); d2 = cross * cross / len2; }
      if (d2 > maxD) { maxD = d2; maxI = i; }
    }
    if (maxD > tol2) { keep[maxI] = 1; stack.push([a, maxI], [maxI, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// Douglas-Peucker for a CLOSED ring (given open): split at the vertex farthest
// from vertex 0 into two anchored chains, simplify each, rejoin. `tol` in the
// ring's own units. Returns a simplified open ring, or null if it degenerates
// (fewer than 3 vertices or zero area).
function simplifyRing(ring, tol) {
  if (!ring || ring.length < 3) return null;
  if (!(tol > 0)) return ring.slice();
  let j = 0, best = -1;
  const x0 = ring[0][0], y0 = ring[0][1];
  for (let i = 1; i < ring.length; i++) {
    const dx = ring[i][0] - x0, dy = ring[i][1] - y0;
    const d = dx * dx + dy * dy;
    if (d > best) { best = d; j = i; }
  }
  const a = _dpSimplify(ring.slice(0, j + 1), tol);
  const b = _dpSimplify(ring.slice(j).concat([ring[0]]), tol);
  const out = a.slice(0, -1).concat(b.slice(0, -1));
  if (out.length < 3 || Math.abs(_ringSignedArea(out)) < 1e-9) return null;
  return out;
}

// Binary viewshed mask -> low-poly vector polygons in [lat,lng].
// opts (all optional): { tolCells, minBlobCells, minBlobFrac, minHoleCells, maxBlobs, maxHolesPerBlob }
// Returns [{ rings: [outerRing, ...holeRings], areaCells, areaM2 }] sorted
// largest first; each ring is an open array of [lat,lng] on CELL EDGES.
function viewshedToPolygons(grid, mask, opts) {
  if (!grid || !mask || !grid.rows || !grid.cols) return [];
  opts = opts || {};
  const rows = grid.rows, cols = grid.cols;
  const tol         = opts.tolCells        != null ? +opts.tolCells        : VIEWSHED_POLY_TOL_CELLS;
  const minBlobCells= opts.minBlobCells    != null ? +opts.minBlobCells    : VIEWSHED_POLY_MIN_BLOB_CELLS;
  const minBlobFrac = opts.minBlobFrac     != null ? +opts.minBlobFrac     : VIEWSHED_POLY_MIN_BLOB_FRAC;
  const minHoleCells= opts.minHoleCells    != null ? +opts.minHoleCells    : VIEWSHED_POLY_MIN_HOLE_CELLS;
  const maxBlobs    = opts.maxBlobs        != null ? +opts.maxBlobs        : VIEWSHED_POLY_MAX_BLOBS;
  const maxHoles    = opts.maxHolesPerBlob != null ? +opts.maxHolesPerBlob : VIEWSHED_POLY_MAX_HOLES;

  const comp = labelMaskComponents(mask, rows, cols);
  if (!comp.count) return [];
  let total = 0;
  for (let L = 1; L <= comp.count; L++) total += comp.areas[L];
  const minBlob = Math.max(minBlobCells, Math.ceil(minBlobFrac * total));
  const keep = [];
  for (let L = 1; L <= comp.count; L++) if (comp.areas[L] >= minBlob) keep.push(L);
  keep.sort((a, b) => comp.areas[b] - comp.areas[a]);
  if (keep.length > maxBlobs) keep.length = maxBlobs;

  const b = (grid.west != null) ? grid : (grid.bounds || {});
  const lngSpan = b.east - b.west, latSpan = b.north - b.south;
  // Lattice vertex -> lat/lng on cell EDGES (gridColToLng/gridRowToLat are +0.5 cell-CENTRE).
  const toLatLng = v => [b.north - (v[1] / rows) * latSpan, b.west + (v[0] / cols) * lngSpan];

  const parts = [];
  for (const L of keep) {
    const traced = traceLabelRings(comp.labels, rows, cols, L);
    const outers = traced.filter(t => t.isOuter);
    const holes = traced.filter(t => !t.isOuter && t.areaCells >= minHoleCells)
      .sort((a, b) => b.areaCells - a.areaCells);
    for (const outer of outers) {
      // A pinched component can yield several outers; give each hole to the
      // outer that contains it (offset off the lattice to dodge on-edge ties).
      const myHoles = (outers.length === 1 ? holes
        : holes.filter(h => _pointInRing([h.ring[0][0] + 0.25, h.ring[0][1] + 0.25], outer.ring))
      ).slice(0, maxHoles);
      const so = simplifyRing(outer.ring, tol);
      if (!so) continue;
      const rings = [so.map(toLatLng)];
      let holeArea = 0;
      for (const h of myHoles) {
        const sh = simplifyRing(h.ring, tol);
        if (sh) { rings.push(sh.map(toLatLng)); holeArea += h.areaCells; }
      }
      const areaCells = outer.areaCells - holeArea; // area of the polygon as drawn
      parts.push({ rings, areaCells, areaM2: (+grid.resM > 0) ? areaCells * grid.resM * grid.resM : null });
    }
  }
  parts.sort((a, b) => b.areaCells - a.areaCells);
  if (parts.length > maxBlobs) parts.length = maxBlobs;
  return parts;
}

// Plain-text KML/GeoJSON description for one viewshed polygon part.
// part = { index, count, areaM2 }.
function viewshedPolygonDescription(rec, part) {
  if (!rec) return '';
  part = part || {};
  const areaM2 = +part.areaM2;
  const areaTxt = Number.isFinite(areaM2)
    ? (areaM2 >= 1e6 ? `${(areaM2 / 1e6).toFixed(2)} km2` : `${(areaM2 / 1e4).toFixed(1)} ha`)
    : '';
  const lines = [
    `Viewshed (vector): ${rec.name || 'Observer'}`,
    part.count > 1 ? `Part ${part.index} of ${part.count} (largest visible regions)` : '',
    `Drone AGL: ${rec.aglFt} ft / VLOS range: ${rec.vlosFt} ft`,
    rec.coverage != null ? `Viewshed: ${Math.round(rec.coverage * 100)}% of VLOS visible` : '',
    rec.demSource ? `Terrain: ${rec.demSource}` : '',
    rec.canopySource ? `Canopy: ${rec.canopySource}` : '',
    areaTxt ? `Approx. area: ${areaTxt}` : '',
    'Simplified low-poly outline — small fragments and holes are dropped. The GeoTIFF/KMZ raster export is authoritative.',
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
    resampleToGrid, buildDSM, sanitizeForKernel, stampBuildingsOnDSM,
    curvatureDrop, isVisible, computeViewshed, viewshedCoverage, compositeViewsheds, computeBackdropSectors, computeHorizonProfile,
    computeShadowMask, shadowColorRamp, shadowMaskToRGBA,
    canopyColorRamp, viewshedColorRamp, canopyGridToRGBA, viewshedMaskToRGBA,
    CANOPY_PAINT_DEFAULT_M, canopyAvgHeight, canopyStampBrush, canopyDiffToSparse,
    canopyApplyStroke, canopyApplyDelete, canopyRevertDiff, canopyOpBBox, canopyApplyOps,
    decimateCanopyMesh, canopyMeshIndexed, normalFromSlopes,
    encodeGeoTiffRGBA, reprojectRgbaTo3857, worldFileForBounds, WGS84_WKT, WEBMERC_WKT, crc32, zipStore,
    makeViewshedRecord, viewshedFilenameSlug, uniqueViewshedName, observerKmlDescription,
    labelMaskComponents, traceLabelRings, simplifyRing, viewshedToPolygons, viewshedPolygonDescription,
    VIEWSHED_POLY_TOL_CELLS, VIEWSHED_POLY_MIN_BLOB_CELLS, VIEWSHED_POLY_MIN_BLOB_FRAC,
    VIEWSHED_POLY_MIN_HOLE_CELLS, VIEWSHED_POLY_MAX_BLOBS, VIEWSHED_POLY_MAX_HOLES,
  };
}

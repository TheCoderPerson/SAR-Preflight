// Regression tests for the November bug review, raster group (H17, M10-M12).
const {
  labelMaskComponents, traceLabelRings, viewshedToPolygons, makeGrid,
  computeShadowMask,
  makeVegAccumulator, accumulateVegTile, finalizeVegAccumulator, vegCandidateMask,
  makeViewshedRecord, observerKmlDescription,
  isVisible, computeViewshed,
  canopyApplyMask, packBitMask, maskDownsample,
  resampleUtmToGrid, latLngToUtm, gridRowToLat, gridColToLng,
} = require('../../sar-preflight-raster.js');
const { pointInPolygon } = require('../../sar-preflight-core.js');

function maskFromRows(rows) {
  const mask = new Uint8Array(rows.length * rows[0].length);
  rows.forEach((line, r) => {
    for (let c = 0; c < line.length; c++) if (line[c] === 'X') mask[r * line.length + c] = 1;
  });
  return { mask, rows: rows.length, cols: rows[0].length };
}

function ringsOf(pic) {
  const { mask, rows, cols } = maskFromRows(pic);
  const comp = labelMaskComponents(mask, rows, cols);
  const out = [];
  for (let L = 1; L <= comp.count; L++) out.push(...traceLabelRings(comp.labels, rows, cols, L));
  return out;
}

const isSimple = ring => new Set(ring.map(p => p.join(','))).size === ring.length;

describe('H17.1 traceLabelRings — diagonal pinch vertices', () => {
  it('a hole pinching a 1-cell notch yields separate simple rings', () => {
    const rings = ringsOf([
      'XXXXXXX',
      'X.XXXXX',
      'XX....X',
      'XX....X',
      'XX....X',
      'XX....X',
      'XXXXXXX']);
    rings.forEach(r => expect(isSimple(r.ring)).toBe(true));
    const holes = rings.filter(r => !r.isOuter).map(r => r.areaCells).sort((a, b) => a - b);
    expect(holes).toEqual([1, 16]);
  });

  it('a hole touching the exterior at one corner is its own simple hole ring', () => {
    const rings = ringsOf([
      '.XXXXX',
      'X....X',
      'X....X',
      'X....X',
      'XXXXXX']);
    rings.forEach(r => expect(isSimple(r.ring)).toBe(true));
    const outer = rings.filter(r => r.isOuter), holes = rings.filter(r => !r.isOuter);
    expect(outer.length).toBe(1);
    expect(holes.map(h => h.areaCells)).toEqual([12]);
    expect(outer[0].areaCells - holes[0].areaCells).toBe(17); // foreground cells
  });

  it('two diagonally pinching holes stay two holes (not one 18-cell figure-8)', () => {
    const pic = [
      'XXXXXXXXX',
      'X...XXXXX',
      'X...XXXXX',
      'X...XXXXX',
      'XXXX...XX',
      'XXXX...XX',
      'XXXX...XX',
      'XXXXXXXXX'];
    const rings = ringsOf(pic);
    rings.forEach(r => expect(isSimple(r.ring)).toBe(true));
    expect(rings.filter(r => !r.isOuter).map(r => r.areaCells)).toEqual([9, 9]);
    // ...so the minHoleCells filter judges each on its own size.
    const { mask, rows, cols } = maskFromRows(pic);
    const grid = { rows, cols, west: 0, east: cols, north: rows, south: 0, resM: 1 };
    const parts = viewshedToPolygons(grid, mask, { tolCells: 0, minBlobCells: 1, minBlobFrac: 0, minHoleCells: 12 });
    expect(parts.length).toBe(1);
    expect(parts[0].rings.length).toBe(1); // both 9-cell holes dropped
  });
});

describe('H17.2 computeShadowMask — sunlit plateau rim', () => {
  it('never shades a cell standing at the highest elevation in the grid', () => {
    const rows = 20, cols = 20;
    const grid = { rows, cols, resM: 10 };
    const dem = new Float32Array(rows * cols);
    for (let r = 5; r < 15; r++) for (let c = 5; c < 15; c++) dem[r * cols + c] = 200;
    for (const [az, el] of [[175, 30], [185, 30], [5, 25], [95, 20], [265, 15], [45, 10]]) {
      const m = computeShadowMask(grid, dem, az, el);
      for (let i = 0; i < rows * cols; i++) if (dem[i] === 200) expect(m[i]).toBe(0);
    }
  });

  it('still shades the lee of the plateau and keeps graded penumbra values', () => {
    const rows = 20, cols = 20;
    const grid = { rows, cols, resM: 10 };
    const dem = new Float32Array(rows * cols);
    for (let r = 5; r < 15; r++) for (let c = 5; c < 15; c++) dem[r * cols + c] = 200;
    const m = computeShadowMask(grid, dem, 175, 30);
    // Light travels north: the ground just north of the plateau is in its shadow.
    expect(m[3 * cols + 10]).toBe(255);
    expect(m[18 * cols + 10]).toBe(0);   // sun side stays lit
  });
});

describe('H17.3 vegCandidateMask ADD — missing imagery is never reclaimed', () => {
  const CONIFER = [60, 80, 45];
  const BOUNDS = { west: -121, east: -120.99, south: 38.68, north: 38.69 };
  it('a transparent tile hole inside forest stays unknown and unpainted', () => {
    const N = 12;
    const rgba = new Uint8ClampedArray(N * N * 4);
    const gap = (x, y) => x >= 4 && x < 8 && y >= 4 && y < 8;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const o = (y * N + x) * 4;
      rgba[o] = CONIFER[0]; rgba[o + 1] = CONIFER[1]; rgba[o + 2] = CONIFER[2];
      rgba[o + 3] = gap(x, y) ? 0 : 255;
    }
    const acc = makeVegAccumulator(N, N);
    accumulateVegTile(acc, rgba, N, N, 1, 0, 0);
    const p = finalizeVegAccumulator(acc, { textureRadiusCells: 1 });
    const add = vegCandidateMask(p, { bounds: BOUNDS, morphR: 1, textureGate: false, insideFn: pointInPolygon, direction: 'add' });
    let painted = 0, unknown = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (!gap(x, y)) continue;
      if (add.mask[y * N + x]) painted++;
      if (add.unknown[y * N + x]) unknown++;
    }
    expect(painted).toBe(0);
    expect(unknown).toBe(16);
  });
});

describe('M10 makeViewshedRecord — null stays null', () => {
  it('rejects a null observer position instead of placing it at 0,0', () => {
    expect(makeViewshedRecord({ observer: { lat: null, lng: null } })).toBe(null);
    expect(makeViewshedRecord({ observer: { lat: 38.7, lng: null } })).toBe(null);
    expect(makeViewshedRecord({ observer: { lat: '', lng: -120 } })).toBe(null);
  });

  it('keeps buildingCount null and defaults null AGL/VLOS instead of 0', () => {
    const r = makeViewshedRecord({ observer: { lat: 38.7, lng: -120.8 }, buildingCount: null, aglFt: null, vlosFt: null });
    expect(r.buildingCount).toBe(null);
    expect(r.aglFt).toBe(200);
    expect(r.vlosFt).toBe(2500);
    expect(makeViewshedRecord({ observer: { lat: 0, lng: 0 }, buildingCount: 0 }).buildingCount).toBe(0); // a real 0 survives
  });

  it('describes a computed viewshed without buildings as unavailable, never "0 OSM footprints"', () => {
    const r = makeViewshedRecord({ observer: { lat: 38.7, lng: -120.8 }, buildingCount: null, computedAt: 1e12 });
    const d = observerKmlDescription(r);
    expect(d).not.toMatch(/0 OSM footprints/);
    expect(d).toMatch(/Buildings: unavailable/);
    expect(observerKmlDescription(makeViewshedRecord({ observer: { lat: 1, lng: 2 } }))).not.toMatch(/Buildings/);
  });
});

describe('M11 isVisible / computeViewshed — drone inside an obstacle', () => {
  it('a target cell whose canopy/building is taller than the drone is not visible', () => {
    const cols = 5, rows = 1;
    const dsm = new Float32Array([100, 100, 100, 100, 140]); // 40 m obstacle at the target
    expect(isVisible(0, 0, 101.7, 4, 0, 115, dsm, cols, rows, 10)).toBe(false);
    expect(isVisible(0, 0, 101.7, 4, 0, 145, dsm, cols, rows, 10)).toBe(true); // drone above it
  });

  it('observer-adjacent cells inside tall trees are not visible; the observer cell still is', () => {
    const grid = { rows: 3, cols: 3, resM: 10 };
    const dem = new Float32Array(9).fill(100);
    const dsm = new Float32Array(9).fill(100);
    dsm[1] = 150; // 50 m tree north of the observer
    const out = computeViewshed({ grid, dem, dsm, obsCol: 1, obsRow: 1, aglM: 30, vlosRangeM: 50 });
    expect(out[4]).toBe(1);
    expect(out[1]).toBe(0);
    expect(out[3]).toBe(1);
  });
});

describe('M12 canopyApplyMask / maskDownsample / resampleUtmToGrid edges', () => {
  it('canopyApplyMask never edits a row that only touches the mask edge', () => {
    let leaks = 0, inside = 0;
    for (let rows = 3; rows < 30; rows++) for (let k = 1; k < rows - 1; k++) for (const north of [0.3, 1.7, 38.71]) {
      const dLat = 0.1;
      const grid = { north, south: north - rows * dLat, west: 0, east: 1, rows, cols: 1, resM: 10 };
      const sbN = north - k * dLat;
      const sb = { north: sbN, south: sbN - 0.35, west: 0, east: 1 };
      const data = packBitMask(new Uint8Array(7).fill(1), 7);
      const flat = new Float32Array(rows);
      canopyApplyMask(grid, flat, { t: 'mask', mode: 'add', data, srcCols: 1, srcRows: 7, srcBounds: sb, srcIsMercator: false, minFrac: 0, hM: 10, hMode: 'fill' });
      for (let r = 0; r < rows; r++) {
        if (r < k && flat[r]) leaks++;
        if (r === k && flat[r]) inside++;
      }
    }
    expect(leaks).toBe(0);
    expect(inside).toBeGreaterThan(0);
  });

  it("maskDownsample 'and' does not stretch a delete over padded pixels", () => {
    const m = new Uint8Array(9).fill(1); // 3x3 all-delete
    const bounds = { west: 0, east: 3, north: 10, south: 9 };
    const r = maskDownsample(m, 3, 3, bounds, 2, 'and');
    expect(r.cols).toBe(2);
    expect(Array.from(r.mask)).toEqual([1, 0, 0, 0]);
    // OR pooling (add) still keeps every partial cell.
    expect(Array.from(maskDownsample(m, 3, 3, bounds, 2, 'or').mask)).toEqual([1, 1, 1, 1]);
  });

  it('resampleUtmToGrid pools a west-edge cell over its own footprint, not one shifted east', () => {
    const grid = makeGrid(38.7, -120.99, 60, 6);
    const zone = 10, cols = 200, rows = 200;
    const u = latLngToUtm(gridRowToLat(grid, 0), gridColToLng(grid, 0), zone);
    const originX = u.x - 1, originY = u.y + 10; // first cell centre at fx≈1, fy≈10
    const data = new Float32Array(cols * rows);
    data[10 * cols + 5] = 40; // a tall pixel ~4 m east of cell 0's centre (outside its 6 m footprint)
    const out = resampleUtmToGrid(grid, { data, cols, rows, originX, originY, resX: 1, resY: 1, zone, nodata: -9999, scale: 1 });
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(40); // ...it belongs to the next cell east
  });
});

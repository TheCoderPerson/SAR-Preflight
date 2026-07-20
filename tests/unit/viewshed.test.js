const {
  curvatureDrop, isVisible, computeViewshed, viewshedCoverage, compositeViewsheds,
  buildDSM, sanitizeForKernel, makeGrid, latLngToCell, PILOT_EYE_M, KERNEL_SENTINEL,
} = require('../../sar-preflight-raster.js');

// ============================================================
// curvatureDrop
// ============================================================

describe('curvatureDrop(rangeM, t)', () => {
  it('is zero at the endpoints', () => {
    expect(curvatureDrop(1000, 0)).toBe(0);
    expect(curvatureDrop(1000, 1)).toBe(0);
  });
  it('is symmetric about the midpoint', () => {
    expect(curvatureDrop(1000, 0.3)).toBeCloseTo(curvatureDrop(1000, 0.7), 9);
  });
  it('matches d*(range-d)/(2R)', () => {
    const range = 2000, t = 0.4, d = t * range;
    expect(curvatureDrop(range, t)).toBeCloseTo(d * (range - d) / (2 * 6371008.8), 9);
  });
  it('is positive in the interior (drop below the chord)', () => {
    expect(curvatureDrop(5000, 0.5)).toBeGreaterThan(0);
  });
});

// ============================================================
// isVisible — synthetic 1-D DSMs (cols x 1 row)
// ============================================================

describe('isVisible', () => {
  const flat = (n) => new Float32Array(n); // all zeros

  it('flat terrain → target is visible', () => {
    const dsm = flat(5);
    expect(isVisible(0, 0, 2, 4, 0, 2, dsm, 5, 1, 1)).toBe(true);
  });

  it('a wall between observer and target blocks LOS', () => {
    const dsm = new Float32Array([0, 0, 10, 0, 0]); // wall at col 2
    expect(isVisible(0, 0, 2, 4, 0, 2, dsm, 5, 1, 1)).toBe(false);
  });

  it('a wall does NOT block a target in front of it', () => {
    const dsm = new Float32Array([0, 0, 10, 0, 0]);
    // target at col 1, before the wall — no intermediate cells
    expect(isVisible(0, 0, 2, 1, 0, 2, dsm, 5, 1, 1)).toBe(true);
  });

  it('a ridge hides a far target, and raising the target (AGL) reveals it', () => {
    const dsm = new Float32Array([0, 5, 0, 0, 0]); // 5 m ridge at col 1
    // low target just above ground → blocked by the ridge
    expect(isVisible(0, 0, PILOT_EYE_M, 4, 0, 2, dsm, 5, 1, 1)).toBe(false);
    // raise the target to 20 m → clears the ridge
    expect(isVisible(0, 0, PILOT_EYE_M, 4, 0, 20, dsm, 5, 1, 1)).toBe(true);
  });

  it('off-grid intermediate cells are treated as blocked', () => {
    const dsm = flat(5);
    // ty out of the single row → the line leaves the grid
    expect(isVisible(0, 0, 2, 4, 5, 2, dsm, 5, 1, 1)).toBe(false);
  });
});

// ============================================================
// DSM / canopy interaction
// ============================================================

describe('buildDSM + isVisible (vegetation blocks via the surface model)', () => {
  it('a tree taller than the terrain blocks LOS where bare earth would not', () => {
    const dem = new Float32Array([0, 0, 0, 0, 0]);
    const canopy = new Float32Array([0, 8, 0, 0, 0]); // 8 m tree at col 1
    const bare = buildDSM(dem, null, 5);
    const withVeg = buildDSM(dem, canopy, 5);
    // bare earth → visible; with the tree → blocked
    expect(isVisible(0, 0, PILOT_EYE_M, 4, 0, 2, bare, 5, 1, 1)).toBe(true);
    expect(isVisible(0, 0, PILOT_EYE_M, 4, 0, 2, withVeg, 5, 1, 1)).toBe(false);
  });
});

describe('buildDSM', () => {
  it('adds positive canopy to the DEM', () => {
    expect(Array.from(buildDSM(new Float32Array([100, 100, 100]), new Float32Array([0, 5, 12]), 3)))
      .toEqual([100, 105, 112]);
  });
  it('clips negative and NaN canopy to zero', () => {
    expect(Array.from(buildDSM(new Float32Array([100, 100, 100]), new Float32Array([-3, NaN, 0]), 3)))
      .toEqual([100, 100, 100]);
  });
  it('null canopy yields a bare-earth copy of the DEM', () => {
    expect(Array.from(buildDSM(new Float32Array([1, 2, 3]), null, 3))).toEqual([1, 2, 3]);
  });
});

describe('sanitizeForKernel', () => {
  it('replaces NaN with the sentinel and preserves finite values', () => {
    expect(Array.from(sanitizeForKernel([1, NaN, 3], 3))).toEqual([1, KERNEL_SENTINEL, 3]);
  });
});

// ============================================================
// computeViewshed
// ============================================================

describe('computeViewshed', () => {
  it('on flat terrain marks every in-range cell visible and out-of-range cell hidden', () => {
    const grid = { rows: 9, cols: 9, resM: 1 };
    const dem = new Float32Array(81);
    const dsm = new Float32Array(81);
    const mask = computeViewshed({ grid, dem, dsm, obsCol: 4, obsRow: 4, aglM: 2, vlosRangeM: 3 });
    expect(mask[4 * 9 + 4]).toBe(1);          // observer cell
    expect(mask[4 * 9 + 7]).toBe(1);          // dc=3, in range, flat → visible
    expect(mask[4 * 9 + 8]).toBe(0);          // dc=4, out of VLOS radius
    expect(mask[0]).toBe(0);                  // far corner, out of range
  });

  it('a ridge occludes far cells; increasing AGL reveals them (monotonic)', () => {
    const grid = { rows: 1, cols: 9, resM: 1 };
    const dem = new Float32Array(9);
    const dsm = new Float32Array(9); dsm[3] = 5; // ridge at col 3
    const low = computeViewshed({ grid, dem, dsm, obsCol: 0, obsRow: 0, aglM: 2, vlosRangeM: 9 });
    const high = computeViewshed({ grid, dem, dsm, obsCol: 0, obsRow: 0, aglM: 30, vlosRangeM: 9 });
    expect(low[5]).toBe(0);   // hidden behind the ridge at low AGL
    expect(high[5]).toBe(1);  // visible once the drone climbs
  });

  it('returns an all-zero mask when the observer ground is unknown', () => {
    const grid = { rows: 5, cols: 5, resM: 1 };
    const dem = new Float32Array(25).fill(0); dem[2 * 5 + 2] = NaN;
    const dsm = new Float32Array(25);
    const mask = computeViewshed({ grid, dem, dsm, obsCol: 2, obsRow: 2, aglM: 2, vlosRangeM: 3 });
    expect(Array.from(mask).every(v => v === 0)).toBe(true);
  });

  it('skips cells with unknown terrain', () => {
    const grid = { rows: 1, cols: 5, resM: 1 };
    const dem = new Float32Array([0, 0, NaN, 0, 0]);
    const dsm = sanitizeForKernel(dem, 5);
    const mask = computeViewshed({ grid, dem, dsm, obsCol: 0, obsRow: 0, aglM: 2, vlosRangeM: 5 });
    expect(mask[2]).toBe(0); // NaN-terrain target not assessed
  });
});

describe('viewshedCoverage', () => {
  it('reports the visible fraction of in-range cells', () => {
    const grid = { rows: 9, cols: 9, resM: 1 };
    const dem = new Float32Array(81);
    const dsm = new Float32Array(81);
    const mask = computeViewshed({ grid, dem, dsm, obsCol: 4, obsRow: 4, aglM: 2, vlosRangeM: 3 });
    // flat terrain → everything in range is visible → coverage 1.0
    expect(viewshedCoverage(grid, mask, 4, 4, 3)).toBeCloseTo(1, 5);
  });
});

// ============================================================
// compositeViewsheds — union of several observers' masks for the single overlay
// ============================================================

describe('compositeViewsheds', () => {
  // A record whose whole grid is visible (mask all 1s).
  const fullRec = (lat, lng, halfM, resM) => {
    const grid = makeGrid(lat, lng, halfM, resM);
    return { grid, mask: new Uint8Array(grid.rows * grid.cols).fill(1) };
  };

  it('returns null with no computed records', () => {
    expect(compositeViewsheds([])).toBeNull();
    expect(compositeViewsheds(null)).toBeNull();
    expect(compositeViewsheds([{ grid: null, mask: null }])).toBeNull();
  });

  it('passes a single record through untouched (no resample)', () => {
    const rec = fullRec(38.7, -120.9, 500, 10);
    const out = compositeViewsheds([rec]);
    expect(out.grid).toBe(rec.grid);
    expect(out.mask).toBe(rec.mask);
  });

  it('unions two disjoint viewsheds into one covering grid', () => {
    const a = fullRec(38.70, -120.90, 500, 10);
    const b = fullRec(38.73, -120.90, 500, 10); // ~3.3 km north — no overlap
    const out = compositeViewsheds([a, b]);
    expect(out.grid.bounds.south).toBeCloseTo(a.grid.bounds.south, 9);
    expect(out.grid.bounds.north).toBeCloseTo(b.grid.bounds.north, 9);
    // Cells inside each source grid are visible…
    const inA = latLngToCell(out.grid, 38.70, -120.90);
    const inB = latLngToCell(out.grid, 38.73, -120.90);
    expect(out.mask[inA.row * out.grid.cols + inA.col]).toBe(1);
    expect(out.mask[inB.row * out.grid.cols + inB.col]).toBe(1);
    // …and the gap between them stays empty.
    const between = latLngToCell(out.grid, 38.715, -120.90);
    expect(out.mask[between.row * out.grid.cols + between.col]).toBe(0);
  });

  it('counts overlapping observers per cell (2 in a pairwise overlap, 3 where all see)', () => {
    const a = fullRec(38.70, -120.90, 500, 10);
    const b = fullRec(38.70, -120.90, 500, 10);   // fully overlaps a
    const c = fullRec(38.703, -120.90, 500, 10);  // offset north — partial overlap
    const out = compositeViewsheds([a, b, c]);
    const center = latLngToCell(out.grid, 38.70, -120.90); // inside a, b, AND c (c spans 38.6985..38.7075)
    expect(out.mask[center.row * out.grid.cols + center.col]).toBe(3);
    const southEdge = latLngToCell(out.grid, 38.6962, -120.90); // inside a+b only, south of c
    expect(out.mask[southEdge.row * out.grid.cols + southEdge.col]).toBe(2);
    const northEdge = latLngToCell(out.grid, 38.707, -120.90);  // inside c only
    expect(out.mask[northEdge.row * out.grid.cols + northEdge.col]).toBe(1);
  });

  it('a hidden cell in one viewshed shows if any other viewshed sees it', () => {
    const a = fullRec(38.70, -120.90, 500, 10);
    const b = fullRec(38.70, -120.90, 500, 10);
    b.mask = new Uint8Array(b.grid.rows * b.grid.cols); // b sees nothing
    const out = compositeViewsheds([b, a]);
    const c = latLngToCell(out.grid, 38.70, -120.90);
    expect(out.mask[c.row * out.grid.cols + c.col]).toBe(1); // a still wins
  });

  it('caps the union grid dimension for far-apart observers', () => {
    const a = fullRec(38.5, -120.9, 500, 5);
    const b = fullRec(39.0, -120.9, 500, 5); // ~55 km apart at 5 m res → way past cap
    const out = compositeViewsheds([a, b], 256);
    expect(Math.max(out.grid.rows, out.grid.cols)).toBeLessThanOrEqual(256);
    const inA = latLngToCell(out.grid, 38.5, -120.9);
    expect(out.mask[inA.row * out.grid.cols + inA.col]).toBe(1);
  });
});

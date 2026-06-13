const {
  makeGrid, gridColToLng, gridRowToLat, latLngToCell,
  resampleToGrid, MAX_GRID,
} = require('../../sar-preflight-raster.js');

// ============================================================
// makeGrid geometry
// ============================================================

describe('makeGrid', () => {
  it('sizes the grid to halfWidth / resolution', () => {
    const g = makeGrid(38.685, -120.99, 762, 3); // ~1524 m / 3 m = 508
    expect(g.rows).toBe(g.cols);
    expect(g.rows).toBe(Math.ceil(1524 / 3));
    expect(g.resM).toBeCloseTo(3, 1);
  });

  it('caps the grid dimension at MAX_GRID and coarsens resolution', () => {
    const g = makeGrid(38.685, -120.99, 5000, 1); // would be 10000 → capped
    expect(g.rows).toBe(MAX_GRID);
    expect(g.resM).toBeGreaterThan(1);
    expect(g.resM).toBeCloseTo(10000 / MAX_GRID, 5);
  });

  it('bounds straddle the centre', () => {
    const g = makeGrid(38.685, -120.99, 762, 3);
    expect(g.west).toBeLessThan(-120.99);
    expect(g.east).toBeGreaterThan(-120.99);
    expect(g.south).toBeLessThan(38.685);
    expect(g.north).toBeGreaterThan(38.685);
  });
});

describe('cell <-> lat/lng mapping', () => {
  const g = makeGrid(38.685, -120.99, 762, 3);

  it('round-trips the centre to roughly the middle cell', () => {
    const { col, row } = latLngToCell(g, 38.685, -120.99);
    expect(col).toBeGreaterThanOrEqual(Math.floor(g.cols / 2) - 1);
    expect(col).toBeLessThanOrEqual(Math.floor(g.cols / 2) + 1);
    expect(row).toBeGreaterThanOrEqual(Math.floor(g.rows / 2) - 1);
    expect(row).toBeLessThanOrEqual(Math.floor(g.rows / 2) + 1);
  });

  it('row 0 is the north edge, col 0 is the west edge', () => {
    expect(gridRowToLat(g, 0)).toBeGreaterThan(gridRowToLat(g, g.rows - 1));
    expect(gridColToLng(g, 0)).toBeLessThan(gridColToLng(g, g.cols - 1));
  });

  it('cell centres round-trip back to the same cell', () => {
    for (const [r, c] of [[0, 0], [5, 9], [g.rows - 1, g.cols - 1]]) {
      const lat = gridRowToLat(g, r), lng = gridColToLng(g, c);
      expect(latLngToCell(g, lat, lng)).toEqual({ col: c, row: r });
    }
  });
});

// ============================================================
// resampleToGrid (nearest-neighbour)
// ============================================================

describe('resampleToGrid', () => {
  // A 2x2 plate-carrée source: NW=10, NE=20, SW=30, SE=40 over [0,1]x[0,1].
  const src = {
    data: new Float32Array([10, 20, 30, 40]),
    srcCols: 2, srcRows: 2,
    srcBounds: { west: 0, south: 0, east: 1, north: 1 },
    srcIsMercator: false,
    nodata: null,
  };

  it('picks the nearest source pixel for each grid cell', () => {
    const g = makeGrid(0.5, 0.5, 55660, 55660); // ~1° box → 2x2 grid
    const out = resampleToGrid(g, src);
    expect(out).toHaveLength(4);
    // grid row0=north, col0=west → NW=10, NE=20, SW=30, SE=40
    expect(out[0]).toBe(10);
    expect(out[1]).toBe(20);
    expect(out[2]).toBe(30);
    expect(out[3]).toBe(40);
  });

  it('maps nodata values to NaN', () => {
    const g = makeGrid(0.5, 0.5, 55660, 55660);
    const out = resampleToGrid(g, { ...src, data: new Float32Array([10, -9999, 30, 40]), nodata: -9999 });
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[0]).toBe(10);
  });
});

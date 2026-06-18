// Canopy COG strip-wise read — must bound the per-call decode window (the
// 1.8 GB single read that crashed the iOS PWA) while still covering the grid.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }) };

const { _cogTileToGrid } = require('../../sar-preflight.js');

// The budget baked into sar-preflight.js (CANOPY_DECODE_BUDGET_PX). Each native
// read window must stay within it.
const BUDGET_PX = 32000000;

// Fake COG whose mercator bbox exactly matches the grid bounds, at a large
// native resolution so the window exceeds the budget and must be split.
function makeMockTiff(grid, nativePx, windows, fill) {
  const bbox = [
    lngToMercX(grid.bounds.west), latToMercY(grid.bounds.south),
    lngToMercX(grid.bounds.east), latToMercY(grid.bounds.north),
  ];
  const img = {
    getWidth: () => nativePx,
    getHeight: () => nativePx,
    getBoundingBox: () => bbox,
    readRasters: async ({ window, width, height }) => {
      windows.push(window);
      return [new Float32Array(width * height).fill(fill)];
    },
  };
  return { getImageCount: async () => 1, getImage: async () => img };
}

describe('_cogTileToGrid strip-wise read', () => {
  it('splits a huge window into budget-bounded native reads and covers the grid', async () => {
    const grid = makeGrid(0, 0, 1000, 50); // small 40x40 grid at the equator
    const windows = [];
    const nativePx = 8000;                  // 8000x8000 = 64M px window > budget
    const tiff = makeMockTiff(grid, nativePx, windows, 7);

    const out = await _cogTileToGrid(tiff, grid);

    // More than one strip (64M / 32M budget => 2)
    expect(windows.length).toBeGreaterThan(1);
    // Every native read window stays within the decode budget
    for (const w of windows) {
      const area = (w[2] - w[0]) * (w[3] - w[1]);
      expect(area).toBeLessThanOrEqual(BUDGET_PX);
    }
    // The strips together cover the full native row range [0, 8000)
    const rowsCovered = windows.reduce((a, w) => a + (w[3] - w[1]), 0);
    expect(rowsCovered).toBe(nativePx);
    // Output grid is fully populated with the (clamped) canopy value
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(grid.rows * grid.cols);
    const finite = Array.from(out).filter(Number.isFinite);
    expect(finite.length).toBe(out.length);          // full coverage, no gaps
    expect(finite.every(v => v === 7)).toBe(true);   // value preserved
  });

  it('reads a small window in a single strip (no regression for zoomed-in AOIs)', async () => {
    const grid = makeGrid(0, 0, 1000, 50);
    const windows = [];
    const nativePx = 1000;                  // 1M px window << budget
    const tiff = makeMockTiff(grid, nativePx, windows, 3);

    const out = await _cogTileToGrid(tiff, grid);
    expect(windows.length).toBe(1);
    expect(Array.from(out).every(v => v === 3)).toBe(true);
  });
});

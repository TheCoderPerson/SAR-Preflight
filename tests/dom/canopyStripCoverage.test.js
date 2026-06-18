// Realistic coverage check: the grid is a SUB-WINDOW of a much larger COG tile
// (as in the field). Verifies the read covers the WHOLE grid (no "band" gaps)
// and maps north->south correctly, in BOTH modes:
//   - mobile (constrained): bounded strip read -> multiple readRasters calls
//   - desktop (unconstrained): single read -> one readRasters call (fewest
//     proxy requests)
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }), Browser: { mobile: true } };

const { _cogTileToGrid } = require('../../sar-preflight.js');

function rowAvg(out, row, cols) {
  let s = 0, n = 0;
  for (let c = 0; c < cols; c++) { const v = out[row * cols + c]; if (Number.isFinite(v)) { s += v; n++; } }
  return n ? s / n : NaN;
}

// Build a fake tiff whose mercator bbox is 3x the grid extent (grid = central
// third) at a large native resolution, and run _cogTileToGrid against it.
async function runCoverage(grid, native) {
  const gW = lngToMercX(grid.bounds.west), gE = lngToMercX(grid.bounds.east);
  const gS = latToMercY(grid.bounds.south), gN = latToMercY(grid.bounds.north);
  const dx = gE - gW, dy = gN - gS;
  const bbox = [gW - dx, gS - dy, gE + dx, gN + dy];
  const windows = [];
  const img = {
    getWidth: () => native, getHeight: () => native, getBoundingBox: () => bbox,
    readRasters: async ({ window, width, height }) => {
      windows.push(window);
      const [, y0, , y1] = window;
      const data = new Float32Array(width * height);
      for (let r = 0; r < height; r++) {
        const val = ((y0 + (r + 0.5) / height * (y1 - y0)) / native) * 30; // 0..30 m, encodes native row
        for (let c = 0; c < width; c++) data[r * width + c] = val;
      }
      return [data];
    },
  };
  const tiff = { getImageCount: async () => 1, getImage: async () => img };
  const out = await _cogTileToGrid(tiff, grid);
  return { out, windows };
}

function assertFullCoverageAndOrientation(out, grid) {
  const finite = Array.from(out).filter(Number.isFinite);
  expect(finite.length).toBe(out.length); // no missing band
  const top = rowAvg(out, 0, grid.cols);
  const mid = rowAvg(out, Math.floor(grid.rows / 2), grid.cols);
  const bot = rowAvg(out, grid.rows - 1, grid.cols);
  expect(mid).toBeGreaterThan(top);
  expect(bot).toBeGreaterThan(mid);
}

describe('_cogTileToGrid coverage', () => {
  it('mobile: splits a huge window into multiple strips and covers the full grid', async () => {
    globalThis.L.Browser.mobile = true;
    const grid = makeGrid(0, 0, 5000, 50); // 200x200 grid at the equator
    const { out, windows } = await runCoverage(grid, 60000); // AOI window ~20k px -> many strips
    expect(windows.length).toBeGreaterThan(1);
    assertFullCoverageAndOrientation(out, grid);
  });

  it('desktop: reads the whole window in a single pass (fewest requests) and still covers the grid', async () => {
    globalThis.L.Browser.mobile = false;
    const grid = makeGrid(0, 0, 5000, 50);
    const { out, windows } = await runCoverage(grid, 60000);
    expect(windows.length).toBe(1); // single read on desktop
    assertFullCoverageAndOrientation(out, grid);
    globalThis.L.Browser.mobile = true; // restore for other tests
  });
});

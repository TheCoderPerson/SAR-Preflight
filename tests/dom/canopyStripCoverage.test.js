// Realistic coverage check: the grid is a SUB-WINDOW of a much larger COG tile
// (as in the field). Verifies the read covers the WHOLE grid (no "band" gaps)
// and maps north->south correctly, in BOTH modes:
//   - mobile (constrained): bounded strip read -> multiple readRasters calls
//   - desktop: ALSO bounded. It used to read the whole window in one pass to
//     save proxy requests; measured against the real 1.08 GB tile that saved
//     almost nothing (geotiff.js coalesces contiguous strips, so striping cost
//     ~10 requests, not thousands) while the longest uninterruptible chunk was
//     4.5 s — and a full-view AOI locked the tab for over 90 s.
// Also pins the per-row cost model: these COGs are STRIPPED with
// RowsPerStrip = 1, so decoding a row costs the FILE's full width, not the
// window's. Budgeting by window width made the guard vanish on narrow windows.
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
async function runCoverage(grid, native, fileDirectory) {
  const gW = lngToMercX(grid.bounds.west), gE = lngToMercX(grid.bounds.east);
  const gS = latToMercY(grid.bounds.south), gN = latToMercY(grid.bounds.north);
  const dx = gE - gW, dy = gN - gS;
  const bbox = [gW - dx, gS - dy, gE + dx, gN + dy];
  const windows = [];
  const img = {
    fileDirectory: fileDirectory || {},   // {} = stripped (no TileWidth)
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

  // Desktop used to take this window in ONE readRasters. Measured on the real
  // 1.08 GB tile that meant a 4.5 s uninterruptible chunk (90 s+ at full view)
  // to save ~9 HTTP requests. It must be bounded like mobile.
  it('desktop: also splits the window, so no single read can lock the tab', async () => {
    globalThis.L.Browser.mobile = false;
    const grid = makeGrid(0, 0, 5000, 50);
    const { out, windows } = await runCoverage(grid, 60000);
    expect(windows.length).toBeGreaterThan(1);
    assertFullCoverageAndOrientation(out, grid);
    globalThis.L.Browser.mobile = true;
  });

  // A STRIPPED row costs the file's full width to inflate however narrow the
  // AOI is; a TILED one only costs the window. Budgeting by window width for
  // both is what let a narrow window compute ~26k rows per strip — no bound at
  // all — which is why the mobile guard only ever bit on wide AOIs.
  it('charges a stripped row at the FILE width, not the window width', async () => {
    globalThis.L.Browser.mobile = false;
    const grid = makeGrid(0, 0, 5000, 50);
    const stripped = await runCoverage(grid, 60000, {});
    const tiled = await runCoverage(grid, 60000, { TileWidth: 256, TileLength: 256 });
    expect(stripped.windows.length).toBeGreaterThan(tiled.windows.length);
    assertFullCoverageAndOrientation(stripped.out, grid);
    assertFullCoverageAndOrientation(tiled.out, grid);
    globalThis.L.Browser.mobile = true;
  });
});

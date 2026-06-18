// Realistic strip-read coverage check: the grid is a SUB-WINDOW of a much
// larger COG tile (as in the field), spanning many strips. Verifies the read
// covers the WHOLE grid (no "band at the bottom" gaps) and maps north->south
// correctly. Guards the -f strip rewrite against partial-coverage regressions.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }) };

const { _cogTileToGrid } = require('../../sar-preflight.js');

function rowAvg(out, row, cols) {
  let s = 0, n = 0;
  for (let c = 0; c < cols; c++) { const v = out[row * cols + c]; if (Number.isFinite(v)) { s += v; n++; } }
  return n ? s / n : NaN;
}

it('covers the full grid from a large sub-window across many strips', async () => {
  const grid = makeGrid(0, 0, 5000, 50); // 200x200 grid at the equator
  // COG bbox = 3x the grid extent in mercator (grid is the central third).
  const gW = lngToMercX(grid.bounds.west), gE = lngToMercX(grid.bounds.east);
  const gS = latToMercY(grid.bounds.south), gN = latToMercY(grid.bounds.north);
  const dx = gE - gW, dy = gN - gS;
  const bbox = [gW - dx, gS - dy, gE + dx, gN + dy];
  const native = 60000; // huge tile → AOI window ~20k px → many strips
  const windows = [];
  const img = {
    getWidth: () => native,
    getHeight: () => native,
    getBoundingBox: () => bbox,
    readRasters: async ({ window, width, height }) => {
      windows.push(window);
      const [, y0, , y1] = window;
      const data = new Float32Array(width * height);
      for (let r = 0; r < height; r++) {
        const nativeRow = y0 + (r + 0.5) / height * (y1 - y0);
        const val = (nativeRow / native) * 30; // 0..30 m, survives the clamp, encodes row
        for (let c = 0; c < width; c++) data[r * width + c] = val;
      }
      return [data];
    },
  };
  const tiff = { getImageCount: async () => 1, getImage: async () => img };

  const out = await _cogTileToGrid(tiff, grid);

  expect(windows.length).toBeGreaterThan(1); // genuinely multi-strip
  // FULL coverage — every grid cell got data (no missing band)
  const finite = Array.from(out).filter(Number.isFinite);
  expect(finite.length).toBe(out.length);
  // Correct orientation: north (row 0) < middle < south (last row)
  const top = rowAvg(out, 0, grid.cols);
  const mid = rowAvg(out, Math.floor(grid.rows / 2), grid.cols);
  const bot = rowAvg(out, grid.rows - 1, grid.cols);
  expect(mid).toBeGreaterThan(top);
  expect(bot).toBeGreaterThan(mid);
});

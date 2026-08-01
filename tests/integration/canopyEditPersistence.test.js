// Saved canopy edits must be replayed by fetchCanopyRaster onto ANY grid —
// the view overlay grid AND the (differently-sized, differently-keyed)
// viewshed grids — while the cached pristine raster stays untouched.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

globalThis.L = {
  layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }),
  Browser: { mobile: false },
};

const { S, fetchCanopyRaster, _applyCanopyEdits } = require('../../sar-preflight.js');

// Grids mirroring real call sites: view overlay vs observer viewshed.
const overlayGrid = makeGrid(38.7, -120.99, 500, 10);
const viewshedGrid = makeGrid(38.7002, -120.9898, 250, 5);
const cellOf = (grid, lat, lng) => { const { col, row } = latLngToCell(grid, lat, lng); return row * grid.cols + col; };

// A delete polygon around the shared target point.
const TGT = { lat: 38.7, lng: -120.99 };
const d = 0.0004;
const DEL_OP = { t: 'del', poly: [[TGT.lat + d, TGT.lng - d], [TGT.lat + d, TGT.lng + d], [TGT.lat - d, TGT.lng + d], [TGT.lat - d, TGT.lng - d]] };

function installCacheMock({ ops }) {
  const store = new Map();
  for (const grid of [overlayGrid, viewshedGrid]) {
    const b = grid.bounds;
    const key = 'canopy_' + [b.west, b.south, b.east, b.north].map(v => v.toFixed(3)).join('_') + '_' + grid.cols + 'x' + grid.rows;
    store.set('canopy|' + key, { canopyArr: new Float32Array(grid.rows * grid.cols).fill(20) });
  }
  if (ops) store.set('canopyedit|global', { ops });
  globalThis.getCachedRaster = async (kind, key) => {
    const data = store.get(kind + '|' + key);
    return data ? { data } : null;
  };
  globalThis.cacheRaster = async () => {};
  return store;
}

beforeEach(() => {
  globalThis.isOnline = () => false; // force the cached path (no proxy fetch)
});
afterEach(() => {
  delete globalThis.isOnline;
  delete globalThis.getCachedRaster;
  delete globalThis.cacheRaster;
});

describe('fetchCanopyRaster replays saved edits', () => {
  it('applies edits on the overlay grid AND a differently-keyed viewshed grid', async () => {
    installCacheMock({ ops: [DEL_OP] });
    for (const grid of [overlayGrid, viewshedGrid]) {
      const { canopyFlat, source } = await fetchCanopyRaster(grid);
      expect(canopyFlat).toBeTruthy();
      expect(source).toContain('(edited)');
      expect(canopyFlat[cellOf(grid, TGT.lat, TGT.lng)]).toBe(0); // deleted tree
      expect(canopyFlat[0]).toBe(20); // far corner untouched
    }
  });

  it('leaves the cached pristine raster unmutated (edits work on a copy)', async () => {
    const store = installCacheMock({ ops: [DEL_OP] });
    await fetchCanopyRaster(overlayGrid);
    for (const [k, v] of store) {
      if (k.startsWith('canopy|')) expect(v.canopyArr.every(x => x === 20)).toBe(true);
    }
  });

  it('returns the raster unchanged when there are no saved edits', async () => {
    installCacheMock({ ops: null });
    const { canopyFlat, source } = await fetchCanopyRaster(overlayGrid);
    expect(source).toBe('Meta 1 m (cached)');
    expect(canopyFlat.every(x => x === 20)).toBe(true);
  });

  it('an empty op log (after Clear Canopy Edits) restores original data', async () => {
    installCacheMock({ ops: [] });
    const { canopyFlat, source } = await fetchCanopyRaster(overlayGrid);
    expect(source).toBe('Meta 1 m (cached)');
    expect(canopyFlat.every(x => x === 20)).toBe(true);
  });
});

// A baked imagery mask op has to survive the same round trip as the geometric
// ops: structured-cloned into IndexedDB, then replayed onto whatever grid the
// caller happens to be building. Its payload is a typed array, which is the
// part most likely to be broken by a future storage change.
describe('mask ops replay from the saved op log', () => {
  // Covers the west half of the overlay grid's extent, at ~1.9 m.
  function maskOp(mode) {
    const b = overlayGrid.bounds;
    const cols = 64, rows = 64;
    const m = new Uint8Array(cols * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols / 2; x++) m[y * cols + x] = 1;
    return makeCanopyMaskOp({
      mask: m, cols, rows, bounds: b, mode, hM: 25, z: 18,
    }).op;
  }
  const westCell = grid => cellOf(grid, grid.lat0, grid.west + (grid.east - grid.west) * 0.25);
  const eastCell = grid => cellOf(grid, grid.lat0, grid.west + (grid.east - grid.west) * 0.75);

  it('replays an add-mask onto both the overlay and the viewshed grid', async () => {
    installCacheMock({ ops: [maskOp('add')] });
    for (const grid of [overlayGrid, viewshedGrid]) {
      const { canopyFlat, source } = await fetchCanopyRaster(grid);
      expect(source).toContain('(edited)');
      // hMode 'fill' preserves the measured 20 m everywhere — nothing is lowered.
      expect(canopyFlat[westCell(grid)]).toBe(20);
      expect(canopyFlat[eastCell(grid)]).toBe(20);
    }
  });

  it('replays a delete-mask, clearing only the masked half', async () => {
    installCacheMock({ ops: [maskOp('del')] });
    const { canopyFlat } = await fetchCanopyRaster(overlayGrid);
    expect(canopyFlat[westCell(overlayGrid)]).toBe(0);
    expect(canopyFlat[eastCell(overlayGrid)]).toBe(20);
  });

  it('fills genuine gaps at the op height', async () => {
    const store = installCacheMock({ ops: [maskOp('add')] });
    for (const [k, v] of store) if (k.startsWith('canopy|')) v.canopyArr.fill(0);
    const { canopyFlat } = await fetchCanopyRaster(overlayGrid);
    expect(canopyFlat[westCell(overlayGrid)]).toBeCloseTo(25, 4);
    expect(canopyFlat[eastCell(overlayGrid)]).toBe(0);
  });

  it('leaves the cached pristine raster unmutated', async () => {
    const store = installCacheMock({ ops: [maskOp('del')] });
    await fetchCanopyRaster(overlayGrid);
    for (const [k, v] of store) {
      if (k.startsWith('canopy|')) expect(v.canopyArr.every(x => x === 20)).toBe(true);
    }
  });

  it('mixes with geometric ops in one log, applied in order', async () => {
    installCacheMock({ ops: [maskOp('del'), DEL_OP] });
    const { canopyFlat, source } = await fetchCanopyRaster(overlayGrid);
    expect(source).toContain('(edited)');
    expect(canopyFlat[westCell(overlayGrid)]).toBe(0);           // from the mask
    expect(canopyFlat[cellOf(overlayGrid, TGT.lat, TGT.lng)]).toBe(0); // from the polygon
  });

  // A truncated op must not take the whole log down with it: _applyCanopyEdits
  // has one try/catch, so an exception here would silently disable every edit
  // the operator ever saved.
  it('skips a corrupt mask op but still applies the rest of the log', async () => {
    installCacheMock({ ops: [{ t: 'mask', mode: 'add', srcCols: 64, srcRows: 64 }, DEL_OP] });
    const { canopyFlat, source } = await fetchCanopyRaster(overlayGrid);
    expect(source).toContain('(edited)');
    expect(canopyFlat[cellOf(overlayGrid, TGT.lat, TGT.lng)]).toBe(0);
  });
});

describe('_applyCanopyEdits', () => {
  it('skips grids the ops do not touch (source stays unedited)', async () => {
    installCacheMock({ ops: [{ t: 'del', poly: [[45.0, -100.0], [45.1, -100.0], [45.05, -99.9]] }] });
    const flat = new Float32Array(overlayGrid.rows * overlayGrid.cols).fill(20);
    const res = await _applyCanopyEdits(overlayGrid, flat);
    expect(res.edited).toBe(false);
    expect(res.flat).toBe(flat); // no copy made
  });

  it('survives a broken cache layer', async () => {
    globalThis.getCachedRaster = async () => { throw new Error('idb dead'); };
    const flat = new Float32Array(4).fill(1);
    const res = await _applyCanopyEdits(overlayGrid, flat);
    expect(res.edited).toBe(false);
    expect(res.flat).toBe(flat);
  });
});

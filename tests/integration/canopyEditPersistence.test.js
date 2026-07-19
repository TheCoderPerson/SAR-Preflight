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

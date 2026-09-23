// Canopy SOURCE selector: fetchCanopyRaster dispatches on the setting (CHMv2 vs
// NAIP-CHM), falls back to CHMv2 when NAIP-CHM has nothing, and reports
// `structures` from the data actually used — which is what decides whether
// runViewshed stamps OSM building footprints onto the DSM.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

globalThis.L = {
  layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }),
  Browser: { mobile: false },
};

const {
  S, fetchCanopyRaster, getCanopySourceSetting, setCanopySource, canopyDatasetLabel,
  _naipIndexForBlock, _fetchNaipChmFromProxy, _naipTileToGrid, runViewshed, NAIP_CHM_PROXY_ROUTE,
  _rasterGridKey, _rasterGridRef,
} = require('../../sar-preflight.js');

// Exact-grid raster cache identity; entries carry their own grid reference.
const keyFor = (prefix, grid) => _rasterGridKey(prefix.replace(/_$/, ''), grid);
const entry = (grid, data) => Object.assign(data, _rasterGridRef(grid));
const cellOf = (grid, lat, lng) => { const { col, row } = latLngToCell(grid, lat, lng); return row * grid.cols + col; };

// ---- a synthetic NAIP-CHM COG: one level, NAD83/UTM 10N, 3 m px, uint16 cm ----
function fakeNaipTiff({ grid, fill = 1500, zone = 10, res = 3, size = 400, mutate }) {
  const nw = latLngToUtm(grid.north, grid.west, zone);
  const originX = nw.x - 150, originY = nw.y + 150;
  const data = new Uint16Array(size * size).fill(fill);
  if (mutate) mutate(data, { originX, originY, res, size, zone });
  const img = {
    fileDirectory: { TileWidth: 512, BitsPerSample: 16 },
    getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 26900 + zone }),
    getOrigin: () => [originX, originY, 0],
    getResolution: () => [res, -res, 0],
    getWidth: () => size, getHeight: () => size,
    readRasters: async ({ window: [x0, y0, x1, y1] }) => {
      const w = x1 - x0, out = new Uint16Array(w * (y1 - y0));
      for (let y = y0; y < y1; y++) out.set(data.subarray(y * size + x0, y * size + x1), (y - y0) * w);
      return [out];
    },
  };
  return { getImageCount: async () => 1, getImage: async () => img };
}

// Block index covering every quarter-quad of the 38120 block on one flight day.
function fullBlockIndex() {
  const e = {};
  for (let q = 1; q <= 64; q++) for (const qq of ['nw', 'ne', 'sw', 'se']) e[String(q).padStart(2, '0') + qq] = '2022/10_060_20220721';
  return { v: 1, e };
}

let fetchLog;
function installFetch({ index = fullBlockIndex(), indexStatus = 200 } = {}) {
  fetchLog = [];
  globalThis.fetch = async (url, opts) => {
    fetchLog.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    const u = String(url);
    if (u.includes('data/naipchm/')) {
      if (indexStatus !== 200) return { ok: false, status: indexStatus };
      return { ok: true, status: 200, json: async () => index };
    }
    if (u.includes('exportImage')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
    if (u.includes('overpass') || u.includes('interpreter')) return { ok: true, status: 200, json: async () => ({ elements: [] }) };
    return { ok: false, status: 404, headers: { get: () => null } };
  };
}

const store = new Map();
function installCache() {
  store.clear();
  globalThis.getCachedRaster = async (kind, key) => { const d = store.get(kind + '|' + key); return d ? { data: d } : null; };
  globalThis.cacheRaster = async (kind, key, payload) => { store.set(kind + '|' + key, payload); };
  globalThis.getCachedApiResponse = async () => null;
  globalThis.cacheApiResponse = async () => {};
}

beforeEach(() => {
  installCache();
  installFetch();
  S._naipIndex = {};
  S._canopyTileError = null;
  S.canopy = null;
  S.map = null;
  localStorage.clear();
  globalThis.isOnline = () => true;
  globalThis.GeoTIFF = {
    fromUrl: async () => { throw new Error('no fake tiff installed'); },
    fromArrayBuffer: async () => ({ getImage: async () => ({ getWidth: () => 1, getHeight: () => 1, readRasters: async () => [new Float32Array([1000])] }) }),
  };
});
afterEach(() => {
  delete globalThis.fetch; delete globalThis.isOnline; delete globalThis.GeoTIFF;
  delete globalThis.getCachedRaster; delete globalThis.cacheRaster;
  delete globalThis.getCachedApiResponse; delete globalThis.cacheApiResponse;
});

describe('canopy source setting', () => {
  it('defaults to chmv2 and persists naip in localStorage', () => {
    expect(getCanopySourceSetting()).toBe('chmv2');
    setCanopySource('naip');
    expect(localStorage.getItem('sar_canopy_source')).toBe('naip');
    expect(getCanopySourceSetting()).toBe('naip');
    setCanopySource('bogus');
    expect(getCanopySourceSetting()).toBe('chmv2');
  });

  it('pill tag follows the RESULT label, never the setting', () => {
    expect(canopyDatasetLabel('NAIP-CHM')).toBe('NAIP-CHM');
    expect(canopyDatasetLabel('NAIP-CHM (cached) (edited)')).toBe('NAIP-CHM');
    expect(canopyDatasetLabel('Meta CHMv2')).toBe('CHMv2');
    expect(canopyDatasetLabel('Meta CHMv2 (NAIP-CHM unavailable) (cached)')).toBe('CHMv2 · NO NAIP-CHM');
  });
});

describe('_naipIndexForBlock', () => {
  it('memoizes a fetched block and a 404 (no coverage), but not a network fault', async () => {
    const a = await _naipIndexForBlock('38120');
    expect(a.e['17sw']).toBe('2022/10_060_20220721');
    await _naipIndexForBlock('38120');
    expect(fetchLog.filter(f => f.url.includes('38120.json'))).toHaveLength(1);

    installFetch({ indexStatus: 404 });
    const none = await _naipIndexForBlock('45110');
    expect(none.e).toEqual({});
    await _naipIndexForBlock('45110');
    expect(fetchLog).toHaveLength(1);

    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    expect(await _naipIndexForBlock('40105')).toBeNull();
    expect(S._naipIndex).not.toHaveProperty('40105');
  });
});

describe('_naipTileToGrid + _fetchNaipChmFromProxy', () => {
  const grid = makeGrid(38.7, -120.99, 300, 6);

  it('reads the UTM window, max-pools onto the grid, converts cm → m, clamps, and maps nodata to NaN', async () => {
    const tiff = fakeNaipTiff({
      grid, fill: 1500,
      mutate: (data, g) => {
        const px = (lat, lng) => { const u = latLngToUtm(lat, lng, g.zone); return { x: Math.floor((u.x - g.originX) / g.res), y: Math.floor((g.originY - u.y) / g.res) }; };
        const t = px(38.7, -120.99); data[t.y * g.size + t.x] = 20000;               // 200 m → clamped to 120
        const n = px(38.702, -120.988);
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) data[(n.y + dy) * g.size + (n.x + dx)] = 65535;
      },
    });
    const r = await _naipTileToGrid(tiff, grid);
    expect(r.arr.length).toBe(grid.rows * grid.cols);
    expect(r.arr[0]).toBeCloseTo(15, 4);
    expect(r.arr[cellOf(grid, 38.7, -120.99)]).toBe(120);
    expect(Number.isNaN(r.arr[cellOf(grid, 38.702, -120.988)])).toBe(true);
    expect(r.maskedPx).toBe(0);
  });

  it('returns null for a file that does not overlap the grid', async () => {
    const far = makeGrid(37.2, -119.5, 300, 6);
    expect(await _naipTileToGrid(fakeNaipTiff({ grid: far }), grid)).toBeNull();
  });

  it('resolves quarter-quads through the block index and requests the exact asset path via /naipchm/', async () => {
    const urls = [];
    globalThis.GeoTIFF.fromUrl = async (url, opts) => { urls.push({ url, opts }); return fakeNaipTiff({ grid, fill: 800 }); };
    const res = await _fetchNaipChmFromProxy('https://proxy.example', grid);
    expect(res.tilesTotal).toBeGreaterThanOrEqual(1);
    expect(res.tilesFailed).toBe(0);
    expect(res.tilesLoaded).toBe(res.tilesTotal);
    expect(urls[0].url).toBe('https://proxy.example' + NAIP_CHM_PROXY_ROUTE + '2022/10/m_3812017_nw_10_060_20220721_chm.tif');
    expect(urls[0].opts.blockSize).toBe(1048576); // CANOPY_COG_BLOCK_BYTES must stay explicit
    expect(res.canopy[cellOf(grid, 38.7, -120.99)]).toBeCloseTo(8, 4);
  });

  it('no index coverage → null with a reason (the caller falls back to CHMv2)', async () => {
    installFetch({ indexStatus: 404 });
    expect(await _fetchNaipChmFromProxy('https://proxy.example', grid)).toBeNull();
    expect(S._canopyTileError).toMatch(/no NAIP-CHM coverage/);
  });
});

describe('fetchCanopyRaster dispatch', () => {
  const grid = makeGrid(38.7, -120.99, 300, 6);

  it('chmv2 setting: structures:false, never consults the NAIP index', async () => {
    globalThis.isOnline = () => false;
    store.set('canopy|' + keyFor('canopy2_', grid), entry(grid, { canopyArr: new Float32Array(grid.rows * grid.cols).fill(20) }));
    const r = await fetchCanopyRaster(grid);
    expect(r.source).toBe('Meta CHMv2 (cached)');
    expect(r.structures).toBe(false);
    expect(fetchLog.some(f => f.url.includes('naipchm'))).toBe(false);
  });

  it('naip setting online: NAIP-CHM data, structures:true, cached under the naipchm_ key', async () => {
    setCanopySource('naip');
    globalThis.GeoTIFF.fromUrl = async () => fakeNaipTiff({ grid, fill: 1500 });
    const r = await fetchCanopyRaster(grid);
    expect(r.source).toBe('NAIP-CHM');
    expect(r.structures).toBe(true);
    expect(r.cloudFrac).toBe(0);
    expect(r.canopyFlat[0]).toBeCloseTo(15, 4);
    const saved = store.get('canopy|' + keyFor('naipchm_', grid));
    expect(saved && saved.structures).toBe(true);
    expect(store.has('canopy|' + keyFor('canopy2_', grid))).toBe(false);
  });

  it('naip setting offline with a cached NAIP grid: "(cached)" label keeps structures:true', async () => {
    setCanopySource('naip');
    globalThis.isOnline = () => false;
    store.set('canopy|' + keyFor('naipchm_', grid), entry(grid, { canopyArr: new Float32Array(grid.rows * grid.cols).fill(9), structures: true }));
    const r = await fetchCanopyRaster(grid);
    expect(r.source).toBe('NAIP-CHM (cached)');
    expect(r.structures).toBe(true);
    expect(canopySourceIncludesStructures(r.source)).toBe(true);
  });

  it('naip setting with no NAIP data → CHMv2 fallback, labeled, structures:false', async () => {
    setCanopySource('naip');
    installFetch({ indexStatus: 404 }); // no coverage
    globalThis.isOnline = () => false;   // CHMv2 comes from its cache
    store.set('canopy|' + keyFor('canopy2_', grid), entry(grid, { canopyArr: new Float32Array(grid.rows * grid.cols).fill(20) }));
    const r = await fetchCanopyRaster(grid);
    expect(r.canopyFlat[0]).toBe(20);
    expect(r.source).toContain('Meta CHMv2 (NAIP-CHM unavailable)');
    expect(r.source).toContain('(cached)');
    expect(r.structures).toBe(false);
    expect(r.naipFallback).toBe(true);
    expect(canopyDatasetLabel(r.source)).toBe('CHMv2 · NO NAIP-CHM');
  });

  it('nothing anywhere → null canopy, structures:false', async () => {
    setCanopySource('naip');
    installFetch({ indexStatus: 404 });
    globalThis.isOnline = () => false;
    const r = await fetchCanopyRaster(grid);
    expect(r.canopyFlat).toBeNull();
    expect(r.structures).toBe(false);
  });
});

describe('runViewshed building stamping follows the canopy data actually used', () => {
  // Small VLOS keeps the kernel cheap: 300 ft → ~140 m half-width → 94² cells.
  const obs = { lat: 38.7, lng: -120.99 };
  const vlosFt = 300, aglFt = 200;
  const halfWidthM = ftToM(vlosFt) + 50;
  const vsGrid = makeGrid(obs.lat, obs.lng, halfWidthM, Math.max(WORK_RES_M, (2 * halfWidthM) / MAX_GRID));
  let stampCalls;
  const origStamp = raster.stampBuildingsOnDSM;
  beforeEach(() => {
    stampCalls = [];
    globalThis.stampBuildingsOnDSM = (...a) => { stampCalls.push(a); return origStamp(...a); };
    S.viewsheds = [makeViewshedRecord({ id: 'v1', observer: obs, aglFt, vlosFt, name: 'T' })];
    S._viewshedRunningId = null;
    S.activeViewshedId = 'v1';
    globalThis.isOnline = () => true;
    jest_silence();
  });
  afterEach(() => { globalThis.stampBuildingsOnDSM = origStamp; console.error = origError; });
  const origError = console.error;
  function jest_silence() { console.error = () => {}; } // render paths need a map; their errors are expected here

  it('NAIP-CHM canopy → OSM footprints neither fetched nor stamped; record says structures are in the canopy', async () => {
    setCanopySource('naip');
    store.set('canopy|' + keyFor('naipchm_', vsGrid), entry(vsGrid, { canopyArr: new Float32Array(vsGrid.rows * vsGrid.cols).fill(12), structures: true }));
    globalThis.GeoTIFF.fromUrl = async () => { throw new Error('offline tile'); }; // force the cached NAIP grid
    installFetch({ indexStatus: 404 });
    await runViewshed('v1');
    const rec = S.viewsheds[0];
    expect(rec.grid).toBeTruthy();
    expect(rec.canopySource).toBe('NAIP-CHM (cached)');
    expect(rec.structuresInCanopy).toBe(true);
    expect(rec.buildingCount).toBeNull();
    expect(stampCalls).toHaveLength(0);
    expect(fetchLog.some(f => f.url.includes('overpass') || f.url.includes('interpreter'))).toBe(false);
  });

  it('NAIP-CHM selected but unavailable → CHMv2 fallback, footprints fetched late and stamped', async () => {
    setCanopySource('naip');
    installFetch({ indexStatus: 404 });
    store.set('canopy|' + keyFor('canopy2_', vsGrid), entry(vsGrid, { canopyArr: new Float32Array(vsGrid.rows * vsGrid.cols).fill(12) }));
    globalThis.GeoTIFF.fromUrl = async () => { throw new Error('offline tile'); };
    await runViewshed('v1');
    const rec = S.viewsheds[0];
    expect(rec.canopySource).toContain('(NAIP-CHM unavailable)');
    expect(rec.structuresInCanopy).toBe(false);
    expect(stampCalls).toHaveLength(1);
    expect(rec.buildingCount).toBe(0); // Overpass answered with no buildings
    expect(fetchLog.some(f => f.url.includes('overpass') || f.url.includes('interpreter'))).toBe(true);
  });

  it('CHMv2 setting → footprints fetched up front and stamped (unchanged behaviour)', async () => {
    store.set('canopy|' + keyFor('canopy2_', vsGrid), entry(vsGrid, { canopyArr: new Float32Array(vsGrid.rows * vsGrid.cols).fill(12) }));
    globalThis.GeoTIFF.fromUrl = async () => { throw new Error('offline tile'); };
    await runViewshed('v1');
    const rec = S.viewsheds[0];
    expect(rec.canopySource).toBe('Meta CHMv2 (cached)');
    expect(rec.structuresInCanopy).toBe(false);
    expect(stampCalls).toHaveLength(1);
    expect(rec.buildingCount).toBe(0);
  });
});

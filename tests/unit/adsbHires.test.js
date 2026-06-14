const core = require('../../sar-preflight-core.js');
const raster = require('../../sar-preflight-raster.js');
// The app reads raster/core helpers as browser globals; expose them for Node.
Object.assign(globalThis, core, raster);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }) };

const {
  S, _parseGetSamples, _adsbHiresKey, _isAdsbLowClose, adsbGroundElevFnFt,
} = require('../../sar-preflight.js');
const { makeGrid } = raster;

describe('_parseGetSamples (3DEP getSamples response join)', () => {
  const points = [
    { lat: 38.685, lng: -120.99, key: 'a' },
    { lat: 38.90, lng: -120.80, key: 'b' },
    { lat: 38.50, lng: -121.00, key: 'c' },
  ];

  it('joins by locationId even when samples are out of input order', () => {
    // Real 3DEP responses come back shuffled (observed: 2, 0, 1).
    const json = { samples: [
      { locationId: 2, value: '127.00' },
      { locationId: 0, value: '382.13' },
      { locationId: 1, value: '814.76' },
    ] };
    const out = _parseGetSamples(json, points);
    expect(out.a).toBeCloseTo(382.13, 2);
    expect(out.b).toBeCloseTo(814.76, 2);
    expect(out.c).toBeCloseTo(127.00, 2);
  });

  it('treats NoData points (silently dropped from the array) as uncached', () => {
    const json = { samples: [
      { locationId: 0, value: '382.13' },
      { locationId: 2, value: '127.00' },
      // locationId 1 absent — over NoData/water
    ] };
    const out = _parseGetSamples(json, points);
    expect(out.a).toBeCloseTo(382.13, 2);
    expect(out.c).toBeCloseTo(127.00, 2);
    expect('b' in out).toBe(false);   // missing → left to coarse-raster fallback
  });

  it('ignores non-finite values and out-of-range ids', () => {
    const json = { samples: [
      { locationId: 0, value: 'NoData' },
      { locationId: 5, value: '999' },   // out of range
      { locationId: 1, value: '814.76' },
    ] };
    const out = _parseGetSamples(json, points);
    expect('a' in out).toBe(false);
    expect(out.b).toBeCloseTo(814.76, 2);
    expect(Object.keys(out)).toEqual(['b']);
  });

  it('handles an empty / malformed response', () => {
    expect(_parseGetSamples(null, points)).toEqual({});
    expect(_parseGetSamples({}, points)).toEqual({});
    expect(_parseGetSamples({ samples: [] }, points)).toEqual({});
  });
});

describe('_isAdsbLowClose (deconfliction gate)', () => {
  it('selects only aircraft that are both low and close', () => {
    expect(_isAdsbLowClose({ agl: 800, distNm: 3 })).toBe(true);
    expect(_isAdsbLowClose({ agl: 800, distNm: 8 })).toBe(false);   // far
    expect(_isAdsbLowClose({ agl: 3000, distNm: 3 })).toBe(false);  // high
    expect(_isAdsbLowClose({ agl: 0, distNm: 1 })).toBe(false);     // on ground
    expect(_isAdsbLowClose({ agl: 800, distNm: null })).toBe(false);
  });
});

describe('adsbGroundElevFnFt resolution order (hi-res > raster > fallback)', () => {
  const M2FT = 3.28084;
  // 2x2 coarse raster: every cell = 500 m.
  const grid = makeGrid(38.7, -120.9, 20000, 20000);
  const flat = new Float32Array(grid.rows * grid.cols).fill(500);

  beforeEach(() => {
    S.adsbDem = null; S._adsbHiresCache = null;
    S.elev = { center: 1500 }; // ft
  });

  it('falls back to the AOI-centre elevation when nothing else is available', () => {
    const fn = adsbGroundElevFnFt();
    expect(fn(38.7, -120.9)).toBe(1500);
  });

  it('uses the coarse raster when present (metres → feet)', () => {
    S.adsbDem = { grid, demFlat: flat };
    const fn = adsbGroundElevFnFt();
    expect(fn(38.7, -120.9)).toBeCloseTo(500 * M2FT, 2);
  });

  it('prefers a cached high-res point sample over the raster', () => {
    S.adsbDem = { grid, demFlat: flat };
    S._adsbHiresCache = new Map();
    S._adsbHiresCache.set(_adsbHiresKey(38.7, -120.9), 612.5); // metres, native 3DEP
    const fn = adsbGroundElevFnFt();
    expect(fn(38.7, -120.9)).toBeCloseTo(612.5 * M2FT, 2);     // hi-res wins
    // A position without a cached sample still uses the raster.
    expect(fn(38.71, -120.91)).toBeCloseTo(500 * M2FT, 2);
  });
});

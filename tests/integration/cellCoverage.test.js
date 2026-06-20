const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = { map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() }, Draw: { Event: {} }, FeatureGroup: vi.fn() };

const { cellCoverageReadout, _pointInRegion, S } = require('../../sar-preflight.js');

const UNIT = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]; // [lat,lng]
const REGION = { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 };

describe('_pointInRegion', () => {
  it('is true inside and false outside the bbox', () => {
    expect(_pointInRegion(0.5, 0.5, REGION)).toBe(true);
    expect(_pointInRegion(9, 9, REGION)).toBe(false);
    expect(_pointInRegion(0.5, 0.5, null)).toBe(false);
  });
});

describe('cellCoverageReadout (FCC overlay vs elevation fallback)', () => {
  afterEach(() => { S.cellCoverage = null; });

  it('reports green when 2+ carriers cover the center', () => {
    S.cellCoverage = { att: [UNIT], tmobile: [UNIT], verizon: [], region: REGION };
    const r = cellCoverageReadout(0.5, 0.5, 1000);
    expect(r.level).toBe('green');
    expect(r.count).toBe(2);
    expect(r.inRegion).toBe(true);
  });

  it('reports amber when exactly one carrier covers the center', () => {
    S.cellCoverage = { att: [UNIT], tmobile: [], verizon: [], region: REGION };
    const r = cellCoverageReadout(0.5, 0.5, 1000);
    expect(r.level).toBe('amber');
    expect(r.count).toBe(1);
  });

  it('reports red (no coverage) when in-region but no carrier covers', () => {
    S.cellCoverage = { att: [UNIT], tmobile: [], verizon: [], region: REGION };
    const r = cellCoverageReadout(5, 5, 1000); // inside region bbox? no — fall back
    expect(r.inRegion).toBe(false); // (5,5) is outside REGION, so falls back
  });

  it('flags red no-coverage for a point inside the region but outside all polygons', () => {
    // Region larger than the single coverage polygon; point in region, not in polygon.
    S.cellCoverage = { att: [UNIT], tmobile: [], verizon: [], region: { minLat: 0, minLng: 0, maxLat: 5, maxLng: 5 } };
    const r = cellCoverageReadout(4, 4, 1000);
    expect(r.inRegion).toBe(true);
    expect(r.count).toBe(0);
    expect(r.level).toBe('red');
  });

  it('falls back to the elevation estimate when no overlay is loaded', () => {
    S.cellCoverage = null;
    const high = cellCoverageReadout(0.5, 0.5, 7000); // >6000 ft -> red estimate
    expect(high.inRegion).toBe(false);
    expect(high.level).toBe('red');
    const low = cellCoverageReadout(0.5, 0.5, 1000);
    expect(low.level).toBe('green');
  });
});

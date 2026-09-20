// NAIP-CHM pure helpers (sar-preflight-raster.js): UTM forward projection, USGS
// quarter-quad numbering, asset-path construction, UTM→grid max-pool resample.
// Layout facts verified against live tiles (Sept 2026) — see CLAUDE.md.
const {
  latLngToUtm, naipIndexBlockKey, naipQuadBounds, naipQuarterQuadFor, naipQuarterQuadsForBBox,
  naipChmPathFor, resampleUtmToGrid, canopySourceIncludesStructures, makeGrid, latLngToCell,
  NAIP_CHM_LABEL, NAIP_CHM_NODATA, NAIP_CHM_SCALE,
} = require('../../sar-preflight-raster.js');

describe('latLngToUtm (NAD83 / GRS80 forward Transverse Mercator)', () => {
  it('matches a published reference point (Lower Manhattan, zone 18)', () => {
    const u = latLngToUtm(40.7128, -74.0060, 18);
    expect(Math.abs(u.x - 583959.4)).toBeLessThan(1.5);
    expect(Math.abs(u.y - 4507351.0)).toBeLessThan(1.5);
  });

  it('agrees with the real tile m_3812001_ne (UL tie point 678528.6 E / 4318996.8 N, zone 10)', () => {
    // The file carries a ~200 m buffer beyond the nominal quarter-quad, so its UL
    // corner lies ~0.0018° north and ~0.0008° west of the nominal corner (39, -120.9375).
    const b = naipQuadBounds('3812001', 'ne');
    const u = latLngToUtm(b.north, b.west, 10);
    expect(u.x).toBeGreaterThan(678528.6);        // nominal corner is EAST of the buffered UL
    expect(u.x - 678528.6).toBeLessThan(120);
    expect(u.y).toBeLessThan(4318996.8);          // ...and SOUTH of it
    expect(4318996.8 - u.y).toBeLessThan(260);
  });

  it('projects a zone-10 point into zone 11 finitely (quads on the -120° seam live in either zone)', () => {
    const u10 = latLngToUtm(39.0, -120.0, 10), u11 = latLngToUtm(39.0, -120.0, 11);
    expect(Number.isFinite(u11.x) && Number.isFinite(u11.y)).toBe(true);
    expect(u10.x).toBeGreaterThan(500000);        // east of zone 10's central meridian (-123)
    expect(u11.x).toBeLessThan(500000);           // west of zone 11's (-117)
    expect(Math.abs(u10.y - u11.y)).toBeLessThan(2500); // northing nearly zone-independent at this scale
  });

  it('is monotonic: north → larger y, east → larger x', () => {
    const a = latLngToUtm(38.7, -120.99, 10), n = latLngToUtm(38.8, -120.99, 10), e = latLngToUtm(38.7, -120.9, 10);
    expect(n.y).toBeGreaterThan(a.y);
    expect(e.x).toBeGreaterThan(a.x);
    expect(Math.abs((n.y - a.y) - 11100)).toBeLessThan(150); // 0.1° lat ≈ 11.1 km
  });
});

describe('USGS quarter-quad numbering (row-major from the NW corner)', () => {
  it('block key: lat° + lon°W, zero-padded', () => {
    expect(naipIndexBlockKey(38.685, -120.99)).toBe('38120');
    expect(naipIndexBlockKey(24.95, -80.8)).toBe('24080');
    expect(naipIndexBlockKey(38.685, 120.99)).toBeNull();   // east hemisphere: not CONUS
    expect(naipIndexBlockKey(-38.685, -120.99)).toBeNull();
  });

  it('El Dorado default centre (38.685, -120.99) → 3812017 sw', () => {
    const q = naipQuarterQuadFor(38.685, -120.99);
    expect(q.block).toBe('38120');
    expect(q.quadId).toBe('3812017');
    expect(q.qq).toBe('sw');
    expect(q.key).toBe('17sw');
    expect(q.bounds).toEqual({ west: -121, south: 38.625, east: -120.9375, north: 38.6875 });
  });

  it('quad positions match the verified tie points of five real files', () => {
    // [quadId, qq, file UL lat, file UL lng] — files buffer ~200 m beyond nominal
    const cases = [
      ['3812001', 'nw', 39.0018, -121.0008], // NW corner of the block
      ['3812002', 'nw', 39.0019, -120.8758], // east neighbour → columns run west→east
      ['3812009', 'nw', 38.8768, -121.0008], // south neighbour → rows run north→south, 8 per row
      ['3812008', 'ne', 39.0023, -120.0632], // NE corner
      ['3812064', 'se', 38.0648, -120.0633], // SE corner
    ];
    for (const [id, qq, lat, lng] of cases) {
      const b = naipQuadBounds(id, qq);
      expect(Math.abs(b.north - lat)).toBeLessThan(0.003);
      expect(Math.abs(b.west - lng)).toBeLessThan(0.003);
      // and the inverse: a point just inside that corner resolves to the same quad
      const q = naipQuarterQuadFor(b.north - 0.001, b.west + 0.001);
      expect(q.quadId + q.qq).toBe(id + qq);
    }
    expect(naipQuadBounds('3812065', 'nw')).toBeNull();
  });

  it('bbox cover: dedupes and includes every touched quarter-quad', () => {
    const list = naipQuarterQuadsForBBox(-121.0, 38.93, -120.93, 39.0).map(q => q.quadId + q.qq).sort();
    expect(list).toEqual(['3812001ne', '3812001nw', '3812001se', '3812001sw']);
    const seam = naipQuarterQuadsForBBox(-120.01, 38.99, -119.99, 39.01).map(q => q.quadId + q.qq).sort();
    // four blocks meet at (39, -120): SE quad of 39120, SW quad of 39119, NE quad of 38120, NW quad of 38119
    expect(seam).toEqual(['3811901nw', '3812008ne', '3911957sw', '3912064se']);
    expect(naipQuarterQuadsForBBox(-125, 32, -114, 42, 5)).toHaveLength(5); // cap honoured
  });
});

describe('naipChmPathFor', () => {
  it('rebuilds the dataset path from a block-index value', () => {
    expect(naipChmPathFor('2022/10_060_20220721', '3812017', 'sw')).toBe('2022/10/m_3812017_sw_10_060_20220721_chm.tif');
    expect(naipChmPathFor('2023/17_030_20230111_20230530', '2408002', 'ne')).toBe('2023/17/m_2408002_ne_17_030_20230111_20230530_chm.tif');
    expect(naipChmPathFor('2016/11_h_20160703', '3411701', 'ne')).toBe('2016/11/m_3411701_ne_11_h_20160703_chm.tif');
  });

  it('rejects malformed entries so the proxy is never asked for a bogus path', () => {
    expect(naipChmPathFor('../etc/passwd', '3812017', 'sw')).toBeNull();
    expect(naipChmPathFor('2022/10_060_20220721', '381201', 'sw')).toBeNull();
    expect(naipChmPathFor('2022/10_060_20220721', '3812017', 'xx')).toBeNull();
    expect(naipChmPathFor(null, '3812017', 'sw')).toBeNull();
  });
});

describe('canopySourceIncludesStructures', () => {
  it('is true for every NAIP-CHM label form and false for CHMv2 — including the fallback label', () => {
    expect(canopySourceIncludesStructures('NAIP-CHM')).toBe(true);
    expect(canopySourceIncludesStructures('NAIP-CHM (cached) (edited)')).toBe(true);
    expect(canopySourceIncludesStructures(NAIP_CHM_LABEL)).toBe(true);
    expect(canopySourceIncludesStructures('Meta CHMv2')).toBe(false);
    expect(canopySourceIncludesStructures('Meta CHMv2 (NAIP-CHM unavailable) (cached)')).toBe(false);
    expect(canopySourceIncludesStructures(null)).toBe(false);
    expect(canopySourceIncludesStructures(undefined)).toBe(false);
  });
});

describe('resampleUtmToGrid (UTM window → lat/lng grid, max-pooled)', () => {
  // 6 m grid over El Dorado; 3 m synthetic source so each cell pools 2×2 px.
  const grid = makeGrid(38.7, -120.99, 300, 6);
  const zone = 10, res = 3, cols = 300, rows = 300;
  const nw = latLngToUtm(grid.north, grid.west, zone);
  const originX = nw.x - 150, originY = nw.y + 150;
  const pxOf = (lat, lng) => { const u = latLngToUtm(lat, lng, zone); return { x: Math.floor((u.x - originX) / res), y: Math.floor((originY - u.y) / res) }; };
  function makeSrc(fill) {
    const data = new Uint16Array(cols * rows).fill(fill);
    return { data, cols, rows, originX, originY, resX: res, resY: res, zone, nodata: NAIP_CHM_NODATA, scale: NAIP_CHM_SCALE };
  }

  it('converts centimetres to metres and covers every cell', () => {
    const out = resampleUtmToGrid(grid, makeSrc(1500));
    expect(out.length).toBe(grid.rows * grid.cols);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(15, 5);
  });

  it('max-pools: one tall source pixel lifts the whole cell (safe direction for VLOS)', () => {
    const src = makeSrc(500);
    const p = pxOf(38.7, -120.99);
    src.data[p.y * cols + p.x] = 4000; // a single 40 m pixel
    const out = resampleUtmToGrid(grid, src);
    const { col, row } = latLngToCell(grid, 38.7, -120.99);
    expect(out[row * grid.cols + col]).toBeCloseTo(40, 5);
    expect(out[0]).toBeCloseTo(5, 5);
  });

  it('nodata → NaN, and an all-nodata cell stays NaN (uncovered, not 0 m)', () => {
    const src = makeSrc(1200);
    const p = pxOf(38.702, -120.988);
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) src.data[(p.y + dy) * cols + (p.x + dx)] = NAIP_CHM_NODATA;
    const out = resampleUtmToGrid(grid, src);
    const { col, row } = latLngToCell(grid, 38.702, -120.988);
    expect(Number.isNaN(out[row * grid.cols + col])).toBe(true);
    expect(out[0]).toBeCloseTo(12, 5);
  });

  it('cells whose centre falls outside the window are NaN', () => {
    const src = makeSrc(1000);
    src.cols = 100; src.rows = 100; src.data = new Uint16Array(100 * 100).fill(1000); // 300 m window: covers only the NW corner (origin sits 150 m outside the grid)
    const out = resampleUtmToGrid(grid, src);
    expect(Number.isFinite(out[0])).toBe(true);
    expect(Number.isNaN(out[out.length - 1])).toBe(true);
  });
});

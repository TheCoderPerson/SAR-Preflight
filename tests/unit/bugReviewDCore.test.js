// Pure helpers added for the D01–D14 review fixes.
const {
  combineProhibitedAreas, arcgisExceededLimit, arcgisPageUrl, ringAreaKm2, polygonAreaKm2,
  localDateISO, gridCellSpacingKm, calcSlopeFromGrid, findEmergencyLZs, generateElevationGrid, haversine,
} = require('../../sar-preflight-core.js');

const fc = (features, extra) => Object.assign({ type: 'FeatureCollection', features }, extra || {});
const pf = (name, type) => ({ type: 'Feature', properties: { NAME: name, TYPE_CODE: type || 'P' }, geometry: null });

describe('combineProhibitedAreas (D04)', () => {
  it('merges the dedicated layer and SUA P-types, deduplicated by name', () => {
    const r = combineProhibitedAreas(fc([pf('P-1'), pf('R-2', 'R'), pf('P-3')]), fc([pf('p-1 '), pf('P-9')]));
    expect(r.features.map(f => f.properties.NAME)).toEqual(['p-1 ', 'P-9', 'P-3']);
    expect(r.unknown).toBe(false);
  });
  it('a failed layer does not hide the other layer\'s hits, but makes "none" unknown', () => {
    expect(combineProhibitedAreas(fc([], { _unavailable: true }), fc([pf('P-9')])).features).toHaveLength(1);
    expect(combineProhibitedAreas(fc([], { _unavailable: true }), fc([])).unknown).toBe(true);
    expect(combineProhibitedAreas(fc([]), null).unknown).toBe(true);
  });
  it('flags a contributing cached layer', () => {
    expect(combineProhibitedAreas(fc([]), fc([], { _cachedAt: 1 })).cached).toBe(true);
  });
});

describe('ArcGIS truncation helpers (D12)', () => {
  it('reads both flag placements', () => {
    expect(arcgisExceededLimit({ exceededTransferLimit: true })).toBe(true);
    expect(arcgisExceededLimit({ properties: { exceededTransferLimit: true } })).toBe(true);
    expect(arcgisExceededLimit({ features: [] })).toBe(false);
    expect(arcgisExceededLimit(null)).toBe(false);
  });
  it('builds page URLs, replacing an existing offset', () => {
    expect(arcgisPageUrl('https://x/query?f=geojson', 200)).toBe('https://x/query?f=geojson&resultOffset=200');
    expect(arcgisPageUrl('https://x/query?resultOffset=5&f=geojson', 10)).toBe('https://x/query?f=geojson&resultOffset=10');
    expect(arcgisPageUrl('https://x/query?f=geojson&resultOffset=5', 10)).toBe('https://x/query?f=geojson&resultOffset=10');
  });
});

describe('polygon area (D11)', () => {
  const rect = [{ lat: 37.99, lng: -121.01 }, { lat: 37.99, lng: -120.99 }, { lat: 38.01, lng: -120.99 }, { lat: 38.01, lng: -121.01 }];
  const tri = rect.slice(0, 3);
  it('a rectangle matches its planar size; its half-triangle is half of it', () => {
    const r = polygonAreaKm2([rect]);
    expect(r).toBeCloseTo(3.90, 1);
    expect(polygonAreaKm2([tri])).toBeCloseTo(r / 2, 2);
  });
  it('winding order and a closing vertex do not matter', () => {
    expect(ringAreaKm2(tri.slice().reverse())).toBeCloseTo(ringAreaKm2(tri), 9);
    expect(ringAreaKm2(tri.concat([tri[0]]))).toBeCloseTo(ringAreaKm2(tri), 9);
  });
  it('an L-shape is 3/4 of its box; holes are subtracted; multipolygons sum', () => {
    const d = 0.01, la = 38, ln = -121;
    const L = [[la, ln], [la, ln + 2 * d], [la + d, ln + 2 * d], [la + d, ln + d], [la + 2 * d, ln + d], [la + 2 * d, ln]]
      .map(([lat, lng]) => ({ lat, lng }));
    const box = [[la, ln], [la, ln + 2 * d], [la + 2 * d, ln + 2 * d], [la + 2 * d, ln]].map(([lat, lng]) => ({ lat, lng }));
    expect(polygonAreaKm2([L]) / polygonAreaKm2([box])).toBeCloseTo(0.75, 2);
    const hole = [[la + d / 2, ln + d / 2], [la + d / 2, ln + d], [la + d, ln + d], [la + d, ln + d / 2]].map(([lat, lng]) => ({ lat, lng }));
    expect(polygonAreaKm2([box, hole])).toBeCloseTo(polygonAreaKm2([box]) - ringAreaKm2(hole), 6);
    expect(polygonAreaKm2([[box], [box]])).toBeCloseTo(2 * polygonAreaKm2([box]), 6);
  });
});

describe('slope from rectangular grids (D07)', () => {
  // Analytical plane z = gx·east_m + gy·north_m (feet) sampled on the app's
  // 5×5 grid; the grid slope must match atan(|∇z|) whatever the aspect ratio.
  function plane(latHalf, lngHalf, gx, gy) {
    const c = { lat: 38, lng: -121 };
    const pts = generateElevationGrid(c.lat, c.lng, { lat: c.lat + latHalf, lng: c.lng + lngHalf }, { lat: c.lat - latHalf, lng: c.lng - lngHalf }, 5)
      .map(p => {
        const east = Math.sign(p.longitude - c.lng) * haversine(c.lat, c.lng, c.lat, p.longitude) * 3280.84;
        const north = Math.sign(p.latitude - c.lat) * haversine(c.lat, c.lng, p.latitude, c.lng) * 3280.84;
        return { lat: p.latitude, lng: p.longitude, elevFt: 1000 + gx * east + gy * north };
      });
    return pts;
  }
  const trueDeg = (gx, gy) => Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
  const shapes = { square: [0.005, 0.0063], wideShort: [0.00045, 0.0057], narrowTall: [0.0057, 0.00045] };
  const grads = { east: [0.6, 0], north: [0, 0.6], diagonal: [0.4, 0.4] };
  for (const [sn, [la, ln]] of Object.entries(shapes)) {
    for (const [gn, [gx, gy]] of Object.entries(grads)) {
      it(`${sn} grid, ${gn} gradient → slope matches the plane`, () => {
        const pts = plane(la, ln, gx, gy);
        const sp = gridCellSpacingKm(pts, 5);
        const res = calcSlopeFromGrid(pts.map(p => p.elevFt), 5, sp);
        expect(res.maxSlopeDeg).toBeCloseTo(trueDeg(gx, gy), 0);
        expect(res.avgSlopeDeg).toBeCloseTo(trueDeg(gx, gy), 0);
      });
    }
  }
  it('the finding\'s 31° north-rising plane yields no "flat" landing candidates', () => {
    const c = { lat: 38, lng: -121 };
    const pts = generateElevationGrid(c.lat, c.lng, { lat: c.lat + 0.00045, lng: c.lng + 0.0057 }, { lat: c.lat - 0.00045, lng: c.lng - 0.0057 }, 5)
      .map((p, i) => ({ lat: p.latitude, lng: p.longitude, elevFt: 100 + 50 * Math.floor(i / 5) }));
    const sp = gridCellSpacingKm(pts, 5);
    expect(sp.xKm * 1000).toBeCloseTo(249.7, 0);
    expect(sp.yKm * 1000).toBeCloseTo(25.0, 0);
    expect(calcSlopeFromGrid(pts.map(p => p.elevFt), 5, sp).maxSlopeDeg).toBeCloseTo(31.35, 1);
    expect(findEmergencyLZs(pts, 5, sp).filter(z => z.slopeDeg < 5)).toEqual([]);
  });
  it('a single number still means square cells (existing callers)', () => {
    const flat = new Array(25).fill(100);
    expect(calcSlopeFromGrid(flat, 5, 1).maxSlopeDeg).toBe(0);
  });
});

describe('localDateISO (D14)', () => {
  const at = iso => Date.parse(iso);
  it('west of UTC: after UTC midnight the local date is still the previous day', () => {
    expect(localDateISO(at('2026-09-23T03:00:00Z'), 'America/Los_Angeles')).toBe('2026-09-22');
    expect(localDateISO(at('2026-09-23T06:59:00Z'), 'America/Los_Angeles')).toBe('2026-09-22');
    expect(localDateISO(at('2026-09-23T07:01:00Z'), 'America/Los_Angeles')).toBe('2026-09-23');
  });
  it('east of UTC: before UTC midnight the local date is already the next day', () => {
    expect(localDateISO(at('2026-09-22T22:30:00Z'), 'Asia/Tokyo')).toBe('2026-09-23');
    expect(localDateISO(at('2026-09-22T14:00:00Z'), 'Asia/Tokyo')).toBe('2026-09-22');
  });
  it('daylight-saving transitions keep the calendar date', () => {
    // US DST ends 2026-11-01 at 02:00 PDT (09:00Z); 23:30 PST Nov 1 = 07:30Z Nov 2.
    expect(localDateISO(at('2026-11-01T08:30:00Z'), 'America/Los_Angeles')).toBe('2026-11-01');
    expect(localDateISO(at('2026-11-02T07:30:00Z'), 'America/Los_Angeles')).toBe('2026-11-01');
    expect(localDateISO(at('2026-03-08T11:00:00Z'), 'America/Los_Angeles')).toBe('2026-03-08');
  });
  it('an unknown zone falls back to the UTC date instead of throwing', () => {
    expect(localDateISO(at('2026-09-23T03:00:00Z'), 'Not/AZone')).toBe('2026-09-23');
  });
});

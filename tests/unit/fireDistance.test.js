// distanceToGeoJsonKm: proximity to a fire FOOTPRINT (BUG_REVIEW_2026-09-22-b
// B02). A vertex (or "first-point centroid") is not proximity: a launch inside
// a large perimeter was reported 38 nm away.
const { distanceToGeoJsonKm, haversine } = require('../../sar-preflight-core.js');

const sq = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const poly = (...rings) => ({ type: 'Polygon', coordinates: rings });

describe('distanceToGeoJsonKm(lat, lng, geometry)', () => {
  it('is 0 for a point inside, whatever the ring order or winding', () => {
    const ring = [[-120.5, 38.5], [-121.01, 38.5], [-121.01, 37.99], [-120.5, 37.99], [-120.5, 38.5]];
    const rotated = [[-121.01, 37.99], [-120.5, 37.99], [-120.5, 38.5], [-121.01, 38.5], [-121.01, 37.99]];
    expect(distanceToGeoJsonKm(38, -121, poly(ring))).toBe(0);
    expect(distanceToGeoJsonKm(38, -121, poly(rotated))).toBe(0);
    expect(distanceToGeoJsonKm(38, -121, poly(ring.slice().reverse()))).toBe(0);
  });

  it('outside: the shortest distance to the boundary, not to a vertex', () => {
    // East edge at lng -120.9 spans 37.5–38.5; the point sits due west of its middle.
    const g = poly(sq(-120.9, 37.5, -120.0, 38.5));
    const expected = haversine(38, -121, 38, -120.9);
    expect(distanceToGeoJsonKm(38, -121, g)).toBeCloseTo(expected, 2);
    // ...much closer than any vertex
    expect(distanceToGeoJsonKm(38, -121, g)).toBeLessThan(haversine(38, -121, 38.5, -120.9) / 3);
  });

  it('a point in a hole is outside: distance to the hole edge', () => {
    const g = poly(sq(-121.5, 37.5, -120.5, 38.5), sq(-121.1, 37.9, -120.9, 38.1));
    const d = distanceToGeoJsonKm(38, -121, g);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeCloseTo(haversine(38, -121, 38, -120.9), 1);
  });

  it('MultiPolygon: inside any component is 0; otherwise the nearest component', () => {
    const far = sq(-119, 38, -118.9, 38.1), mid = sq(-121.1, 38.2, -120.9, 38.3), around = sq(-121.1, 37.9, -120.9, 38.1);
    expect(distanceToGeoJsonKm(38, -121, { type: 'MultiPolygon', coordinates: [[far], [around]] })).toBe(0);
    const d = distanceToGeoJsonKm(38, -121, { type: 'MultiPolygon', coordinates: [[far], [mid]] });
    expect(d).toBeCloseTo(haversine(38, -121, 38.2, -121), 1);
  });

  it('threshold sides: 9.9 nm vs 10.1 nm from a straight edge', () => {
    const kmPerDegLat = haversine(38, -121, 39, -121);
    const at = nm => poly(sq(-121.5, 38 + nm * 1.852 / kmPerDegLat, -120.5, 39));
    expect(distanceToGeoJsonKm(38, -121, at(9.9)) * 0.539957).toBeLessThan(10);
    expect(distanceToGeoJsonKm(38, -121, at(10.1)) * 0.539957).toBeGreaterThan(10);
  });

  it('null / empty geometry → null (unknown), never 0 or a made-up distance', () => {
    expect(distanceToGeoJsonKm(38, -121, null)).toBeNull();
    expect(distanceToGeoJsonKm(38, -121, { type: 'Polygon', coordinates: [] })).toBeNull();
  });

  it('a Point geometry measures to the point', () => {
    expect(distanceToGeoJsonKm(38, -121, { type: 'Point', coordinates: [-121, 38.1] }))
      .toBeCloseTo(haversine(38, -121, 38.1, -121), 2);
  });
});

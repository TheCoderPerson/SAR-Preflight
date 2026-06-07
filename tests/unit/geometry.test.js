const {
  pointInPolygon, polygonBBox, bboxesOverlap, segmentsIntersect,
  polygonsIntersect, circleToPolygon, parseFaaCoord, normalizeFaaDate,
} = require('../../sar-preflight-core.js');

// A simple square ring around El Dorado County center, [lat,lng]
const square = [
  [38.6, -121.0], [38.6, -120.9], [38.7, -120.9], [38.7, -121.0], [38.6, -121.0],
];

describe('pointInPolygon()', () => {
  it('returns true for a point inside', () => {
    expect(pointInPolygon(38.65, -120.95, square)).toBe(true);
  });
  it('returns false for a point outside', () => {
    expect(pointInPolygon(40.0, -120.0, square)).toBe(false);
  });
  it('returns false for a degenerate polygon', () => {
    expect(pointInPolygon(38.65, -120.95, [[0, 0], [1, 1]])).toBe(false);
  });
});

describe('polygonBBox() / bboxesOverlap()', () => {
  it('computes the bounding box', () => {
    const bb = polygonBBox(square);
    expect(bb).toEqual({ minLat: 38.6, minLng: -121.0, maxLat: 38.7, maxLng: -120.9 });
  });
  it('detects overlapping and disjoint bboxes', () => {
    const a = { minLat: 0, minLng: 0, maxLat: 2, maxLng: 2 };
    const b = { minLat: 1, minLng: 1, maxLat: 3, maxLng: 3 };
    const c = { minLat: 5, minLng: 5, maxLat: 6, maxLng: 6 };
    expect(bboxesOverlap(a, b)).toBe(true);
    expect(bboxesOverlap(a, c)).toBe(false);
  });
});

describe('segmentsIntersect()', () => {
  it('detects crossing segments', () => {
    expect(segmentsIntersect([0, 0], [2, 2], [0, 2], [2, 0])).toBe(true);
  });
  it('returns false for parallel/non-crossing segments', () => {
    expect(segmentsIntersect([0, 0], [0, 2], [1, 0], [1, 2])).toBe(false);
  });
});

describe('polygonsIntersect()', () => {
  const big = [[38.0, -122.0], [38.0, -120.0], [39.0, -120.0], [39.0, -122.0]];
  const inside = [[38.64, -120.96], [38.64, -120.94], [38.66, -120.94], [38.66, -120.96]];
  const disjoint = [[10.0, 10.0], [10.0, 11.0], [11.0, 11.0], [11.0, 10.0]];

  it('true when one polygon fully contains the other', () => {
    expect(polygonsIntersect(big, inside)).toBe(true);
    expect(polygonsIntersect(inside, big)).toBe(true);
  });
  it('true for partial overlap (edge crossing)', () => {
    const overlap = [[38.65, -120.95], [38.65, -120.5], [38.8, -120.5], [38.8, -120.95]];
    expect(polygonsIntersect(square, overlap)).toBe(true);
  });
  it('false for disjoint polygons', () => {
    expect(polygonsIntersect(square, disjoint)).toBe(false);
  });
  it('false for degenerate inputs', () => {
    expect(polygonsIntersect(square, [[0, 0], [1, 1]])).toBe(false);
    expect(polygonsIntersect(null, square)).toBe(false);
  });
});

describe('circleToPolygon()', () => {
  it('produces a closed ring with the requested segment count', () => {
    const ring = circleToPolygon(38.685, -120.99, 1852, 12); // 1 NM
    expect(ring.length).toBe(13); // 12 + closing vertex
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });
  it('vertices sit roughly the radius away from center', () => {
    const ring = circleToPolygon(38.685, -120.99, 1852, 8);
    // northernmost vertex ~1 NM (~0.0167 deg lat) north of center
    const north = Math.max(...ring.map(p => p[0]));
    expect(north - 38.685).toBeGreaterThan(0.014);
    expect(north - 38.685).toBeLessThan(0.020);
  });
  it('the drawn-area center is inside its own circle ring', () => {
    const ring = circleToPolygon(38.685, -120.99, 3000, 24);
    expect(pointInPolygon(38.685, -120.99, ring)).toBe(true);
  });
});

describe('parseFaaCoord()', () => {
  it('parses decimal degrees with hemisphere letter', () => {
    expect(parseFaaCoord('47.84996991N')).toBeCloseTo(47.84997, 4);
    expect(parseFaaCoord('120.01666667W')).toBeCloseTo(-120.016667, 4);
  });
  it('parses packed DMS with hemisphere letter', () => {
    expect(parseFaaCoord('474800N')).toBeCloseTo(47.8, 4);   // 47 deg 48 min
    expect(parseFaaCoord('1200100W')).toBeCloseTo(-120.016667, 4); // 120 deg 01 min
  });
  it('honors a leading minus sign', () => {
    expect(parseFaaCoord('-120.5')).toBeCloseTo(-120.5, 4);
  });
  it('returns NaN on garbage', () => {
    expect(Number.isNaN(parseFaaCoord(''))).toBe(true);
    expect(Number.isNaN(parseFaaCoord(null))).toBe(true);
  });
});

describe('normalizeFaaDate()', () => {
  it('appends Z to an offset-less ISO time', () => {
    expect(normalizeFaaDate('2026-06-06T20:46:00')).toBe('2026-06-06T20:46:00Z');
  });
  it('leaves an already-zoned time untouched', () => {
    expect(normalizeFaaDate('2026-06-06T20:46:00Z')).toBe('2026-06-06T20:46:00Z');
    expect(normalizeFaaDate('2026-06-06T20:46:00+00:00')).toBe('2026-06-06T20:46:00+00:00');
  });
  it('returns null for empty input', () => {
    expect(normalizeFaaDate('')).toBeNull();
    expect(normalizeFaaDate(null)).toBeNull();
  });
});

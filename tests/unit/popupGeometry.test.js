const { pointInRings, distPointToSegment, pointInPolygon } = require('../../sar-preflight-core.js');

// A square ring [lat,lng] from (0,0) to (10,10)
const square = [[0, 0], [0, 10], [10, 10], [10, 0]];
// A hole inside it from (3,3) to (7,7)
const hole = [[3, 3], [3, 7], [7, 7], [7, 3]];

describe('pointInRings (even-odd, supports holes & multipolygons)', () => {
  it('returns false for empty/missing rings', () => {
    expect(pointInRings(5, 5, [])).toBe(false);
    expect(pointInRings(5, 5, null)).toBe(false);
  });

  it('matches a single ring like pointInPolygon', () => {
    expect(pointInRings(5, 5, [square])).toBe(true);
    expect(pointInRings(50, 50, [square])).toBe(false);
    expect(pointInRings(5, 5, [square])).toBe(pointInPolygon(5, 5, square));
  });

  it('treats a point inside a hole as OUTSIDE (odd-even)', () => {
    // inside outer + inside hole = 2 rings = even = outside
    expect(pointInRings(5, 5, [square, hole])).toBe(false);
    // inside outer but not the hole = 1 ring = odd = inside
    expect(pointInRings(1, 1, [square, hole])).toBe(true);
  });

  it('handles a multipolygon (two separate outer rings)', () => {
    const far = [[100, 100], [100, 110], [110, 110], [110, 100]];
    expect(pointInRings(5, 5, [square, far])).toBe(true);
    expect(pointInRings(105, 105, [square, far])).toBe(true);
    expect(pointInRings(50, 50, [square, far])).toBe(false);
  });
});

describe('distPointToSegment', () => {
  it('is 0 when the point lies on the segment', () => {
    expect(distPointToSegment(5, 0, 0, 0, 10, 0)).toBe(0);
  });

  it('measures perpendicular distance to the segment interior', () => {
    expect(distPointToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 6);
  });

  it('clamps to the nearest endpoint past the segment ends', () => {
    // point beyond B=(10,0): nearest is the endpoint, distance = 5
    expect(distPointToSegment(15, 0, 0, 0, 10, 0)).toBeCloseTo(5, 6);
    // point before A=(0,0)
    expect(distPointToSegment(-3, 4, 0, 0, 10, 0)).toBeCloseTo(5, 6);
  });

  it('handles a degenerate (zero-length) segment as point distance', () => {
    expect(distPointToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 6);
  });
});

const { artccForPoint, artccsForArea } = require('../../sar-preflight-core.js');

describe('artccForPoint()', () => {
  it('maps El Dorado County to Oakland Center (ZOA)', () => {
    const a = artccForPoint(38.685, -120.99);
    expect(a).not.toBeNull();
    expect(a.id).toBe('ZOA');
    expect(a.name).toBe('Oakland Center');
  });
  it('maps a SoCal point to Los Angeles Center (ZLA)', () => {
    const a = artccForPoint(34.05, -118.24);
    expect(a.id).toBe('ZLA');
  });
  it('returns null for a point outside the covered region', () => {
    expect(artccForPoint(40.71, -74.0)).toBeNull(); // NYC
  });
});

describe('artccsForArea()', () => {
  it('returns ZOA for a small area in El Dorado County', () => {
    const area = [[38.64, -120.96], [38.64, -120.94], [38.66, -120.94], [38.66, -120.96]];
    const ids = artccsForArea(area).map(a => a.id);
    expect(ids).toContain('ZOA');
    expect(ids.length).toBe(1);
  });
  it('returns multiple centers for an area spanning the ZOA/ZLA boundary', () => {
    // straddles ZOA's southern edge (~lat 36.4): south corners fall in ZLA, north in ZOA
    const area = [[35.8, -120.8], [35.8, -120.4], [38.0, -120.4], [38.0, -120.8]];
    const ids = artccsForArea(area).map(a => a.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids).toContain('ZOA');
    expect(ids).toContain('ZLA');
  });
  it('returns [] for empty input', () => {
    expect(artccsForArea([])).toEqual([]);
  });
});

const {
  smaAgencyInfo, smaIsPublic, classifyAreaPublicPrivate, cellCoverageAt,
} = require('../../sar-preflight-core.js');

// Rings are [lat,lng]; a generous ring that strictly contains the unit square.
const BIG = [[-1, -1], [-1, 2], [2, 2], [2, -1], [-1, -1]];
const UNIT = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]];
const LEFT_HALF = [[-1, -1], [-1, 0.5], [2, 0.5], [2, -1], [-1, -1]]; // lng <= 0.5

describe('smaAgencyInfo / smaIsPublic', () => {
  it('classifies federal/state/tribal codes as public', () => {
    ['BLM', 'USFS', 'NPS', 'FWS', 'ST', 'LG', 'BIA', 'NTVALL', 'DOD', 'USACE'].forEach(c => {
      expect(smaIsPublic(c)).toBe(true);
      expect(smaAgencyInfo(c).label).toBeTruthy();
    });
  });
  it('classifies PVT and UND (and blank) as non-public', () => {
    expect(smaIsPublic('PVT')).toBe(false);
    expect(smaIsPublic('UND')).toBe(false);
    expect(smaIsPublic('')).toBe(false);
    expect(smaIsPublic(null)).toBe(false);
    expect(smaAgencyInfo('PVT').label).toBe('Private');
  });
  it('is case-insensitive and trims', () => {
    expect(smaIsPublic('  blm ')).toBe(true);
    expect(smaIsPublic('pvt')).toBe(false);
  });
  it('treats an unknown code as managed (public) unless explicitly non-public', () => {
    expect(smaIsPublic('XYZ')).toBe(true);
  });
});

describe('classifyAreaPublicPrivate', () => {
  it('reports 0% private when a public ring fully covers the area', () => {
    const r = classifyAreaPublicPrivate(UNIT, [BIG], 11);
    expect(r.sampled).toBeGreaterThan(0);
    expect(r.privateFrac).toBe(0);
    expect(r.anyPublic).toBe(true);
  });
  it('reports 100% private when there are no public rings', () => {
    const r = classifyAreaPublicPrivate(UNIT, [], 11);
    expect(r.sampled).toBeGreaterThan(0);
    expect(r.privateFrac).toBe(1);
    expect(r.anyPublic).toBe(false);
  });
  it('reports a partial fraction when public land covers part of the area', () => {
    const r = classifyAreaPublicPrivate(UNIT, [LEFT_HALF], 11);
    expect(r.privateFrac).toBeGreaterThan(0.3);
    expect(r.privateFrac).toBeLessThan(0.7);
  });
  it('handles a degenerate / missing AOI without throwing', () => {
    expect(classifyAreaPublicPrivate(null, [BIG]).sampled).toBe(0);
    expect(classifyAreaPublicPrivate([[0, 0], [0, 1]], [BIG]).sampled).toBe(0);
  });
});

describe('cellCoverageAt', () => {
  const carriers = {
    att: [UNIT],
    tmobile: [[[2, 2], [2, 3], [3, 3], [3, 2], [2, 2]]],
    verizon: [],
  };
  it('flags only the carrier whose polygon contains the point', () => {
    const r = cellCoverageAt(0.5, 0.5, carriers);
    expect(r.att).toBe(true);
    expect(r.tmobile).toBe(false);
    expect(r.count).toBe(1);
    expect(r.anyCovered).toBe(true);
  });
  it('returns no coverage when the point is outside every carrier', () => {
    const r = cellCoverageAt(9, 9, carriers);
    expect(r.count).toBe(0);
    expect(r.anyCovered).toBe(false);
  });
  it('tolerates a missing carriers object', () => {
    expect(cellCoverageAt(0, 0, null).anyCovered).toBe(false);
  });
});

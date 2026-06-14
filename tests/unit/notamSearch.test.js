const { parseNotamSearchResponse, parseNotamSearchItem } = require('../../sar-preflight-core.js');

const sampleItem = {
  facilityDesignator: 'SAC',
  notamNumber: '01/234',
  featureName: 'OBSTRUCTION',
  keyword: 'OBST',
  startDate: '2026-06-13T22:30:00',
  endDate: '2026-12-31T23:59:00',
  traditionalMessage: '!SAC 01/234 SAC OBST TOWER LGT (ASR 1234567) ...',
  icaoMessage: 'A0001/26 ...',
  plainLanguageMessage: 'Tower light out of service',
  icaoId: 'KSAC',
  airportName: 'SACRAMENTO EXEC',
  mapPointer: 'POINT(-121.493 38.512)',
  cancelledOrExpired: false,
};

describe('parseNotamSearchItem', () => {
  it('maps the notamSearch fields into the app NOTAM shape', () => {
    const n = parseNotamSearchItem(sampleItem);
    expect(n.id).toBe('01/234');
    expect(n.location).toBe('SAC');
    expect(n.type).toBe('OBST');
    expect(n.body).toContain('OBST TOWER LGT');
    expect(n.source).toBe('notamSearch');
    expect(n.polygons).toEqual([]);
  });

  it('extracts lng/lat from the WKT mapPointer (POINT(lon lat))', () => {
    const n = parseNotamSearchItem(sampleItem);
    expect(n.lng).toBeCloseTo(-121.493, 3);
    expect(n.lat).toBeCloseTo(38.512, 3);
  });

  it('normalizes parseable dates to ISO', () => {
    const n = parseNotamSearchItem(sampleItem);
    // toISOString() is UTC, so the exact day can shift by TZ; assert ISO shape.
    expect(n.effectiveStart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(n.effectiveEnd).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('parses the real FAA "MM/DD/YYYY HHMM" format as UTC', () => {
    const n = parseNotamSearchItem({ ...sampleItem, startDate: '03/17/2020 1826', endDate: '04/30/2027 2359' });
    expect(n.effectiveStart).toBe('2020-03-17T18:26:00Z');
    expect(n.effectiveEnd).toBe('2027-04-30T23:59:00Z');
  });

  it('handles a glued timezone suffix and the PERM sentinel', () => {
    const n = parseNotamSearchItem({ ...sampleItem, startDate: '03/09/2026 1953EST', endDate: 'PERM' });
    expect(n.effectiveStart).toBe('2026-03-09T19:53:00Z'); // TZ letters ignored (treated UTC)
    expect(n.effectiveEnd).toBe('PERM');
  });

  it('returns null for an empty date', () => {
    const n = parseNotamSearchItem({ ...sampleItem, startDate: '', endDate: null });
    expect(n.effectiveStart).toBe(null);
    expect(n.effectiveEnd).toBe(null);
  });

  it('drops cancelled/expired NOTAMs', () => {
    expect(parseNotamSearchItem({ ...sampleItem, cancelledOrExpired: true })).toBe(null);
  });

  it('falls back to traditional→icao→plain message and other id sources', () => {
    const n = parseNotamSearchItem({ facilityDesignator: 'MHR', plainLanguageMessage: 'GPS testing', icaoId: 'KMHR' });
    expect(n.body).toBe('GPS testing');
    expect(n.location).toBe('MHR');
    // no notamNumber → id derived from location + feature
    expect(n.id.length).toBeGreaterThan(0);
  });
});

describe('parseNotamSearchResponse', () => {
  it('parses a notamList payload', () => {
    const out = parseNotamSearchResponse({ notamList: [sampleItem, { ...sampleItem, notamNumber: '02/345' }] });
    expect(out).toHaveLength(2);
    expect(out[1].id).toBe('02/345');
  });

  it('accepts a JSON string', () => {
    const out = parseNotamSearchResponse(JSON.stringify({ notamList: [sampleItem] }));
    expect(out).toHaveLength(1);
  });

  it('returns [] for missing/invalid payloads', () => {
    expect(parseNotamSearchResponse(null)).toEqual([]);
    expect(parseNotamSearchResponse({})).toEqual([]);
    expect(parseNotamSearchResponse('not json')).toEqual([]);
  });

  it('skips cancelled items in the list', () => {
    const out = parseNotamSearchResponse({ notamList: [sampleItem, { ...sampleItem, notamNumber: 'X', cancelledOrExpired: true }] });
    expect(out).toHaveLength(1);
  });
});

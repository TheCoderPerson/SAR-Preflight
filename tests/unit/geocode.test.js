const {
  GEOCODE_PROVIDER, GEOCODE_MIN_INTERVAL_MS, GEOCODE_LIMIT, GEOCODE_FIT_MIN_SPAN_M,
  geocodeViewbox, geocodeQueryUrl, geocodeKindLabel,
  normalizeNominatimResult, normalizeGeocodeResults, rankGeocodeResults, geocodeFitBounds,
  formatGeocodeDistance, formatGeocodeResult,
  geocodeQueryHasHouseNumber, geocodeMatchWarning,
  geocodeStatusText, geocodeAnchorLabel, geocodeCacheKey, geocodeRateLimitDelay,
} = require('../../sar-preflight-core.js');

const FX = require('../fixtures/nominatim-search.json');

// Default map center (CLAUDE.md): El Dorado County, CA.
const EDC = { lat: 38.685, lng: -120.99, source: 'map', at: null };

describe('geocodeViewbox', () => {
  it('emits west/north/east/south around the anchor', () => {
    const vb = geocodeViewbox(EDC, 1.5);
    expect(vb.north).toBeCloseTo(40.185, 6);
    expect(vb.south).toBeCloseTo(37.185, 6);
    expect(vb.west).toBeLessThan(EDC.lng);
    expect(vb.east).toBeGreaterThan(EDC.lng);
  });

  it('widens the longitude span by 1/cos(lat) so the box stays square on the ground', () => {
    const vb = geocodeViewbox({ lat: 60, lng: 0 }, 1);
    const latSpan = vb.north - vb.south;   // 2
    const lngSpan = vb.east - vb.west;     // 2 / cos(60) = 4
    expect(lngSpan / latSpan).toBeCloseTo(1 / Math.cos(60 * Math.PI / 180), 3);
  });

  it('clamps at the poles and survives a degenerate anchor', () => {
    expect(geocodeViewbox({ lat: 89.5, lng: 0 }, 1.5).north).toBe(90);
    expect(geocodeViewbox({ lat: -89.5, lng: 0 }, 1.5).south).toBe(-90);
    expect(geocodeViewbox(null, 1.5)).toBeNull();
    expect(geocodeViewbox({ lat: NaN, lng: 0 }, 1.5)).toBeNull();
  });
});

describe('geocodeQueryUrl', () => {
  it('builds a jsonv2 query against the configured provider', () => {
    const url = geocodeQueryUrl('Jenkinson Lake', {});
    expect(url.startsWith(GEOCODE_PROVIDER.base + '?')).toBe(true);
    expect(url).toContain('format=jsonv2');
    expect(url).toContain('addressdetails=1');
    expect(url).toContain('limit=' + GEOCODE_LIMIT);
    expect(url).toContain('q=Jenkinson%20Lake');
  });

  it('encodes commas, ampersands and unicode in the query', () => {
    const url = geocodeQueryUrl('7020 Talmage Ct, El Dorado Hills, CA & Cafè', {});
    expect(url).toContain('q=7020%20Talmage%20Ct%2C%20El%20Dorado%20Hills%2C%20CA%20%26%20Caf%C3%A8');
  });

  it('includes viewbox when given one and omits it otherwise — and never sets bounded', () => {
    const withVb = geocodeQueryUrl('Pyramid Peak', { viewbox: geocodeViewbox(EDC, 1.5) });
    expect(withVb).toContain('viewbox=');
    // viewbox is a BIAS, not a filter: a bounded=1 would hide out-of-region places.
    expect(withVb).not.toContain('bounded');
    expect(geocodeQueryUrl('Pyramid Peak', {})).not.toContain('viewbox');
    expect(geocodeQueryUrl('Pyramid Peak', { viewbox: { west: NaN, north: 1, east: 2, south: 0 } }))
      .not.toContain('viewbox');
  });

  it('never leaks a contact email to the provider', () => {
    expect(geocodeQueryUrl('Jenkinson Lake', {})).not.toContain('email');
  });

  it('returns null for an empty query', () => {
    expect(geocodeQueryUrl('', {})).toBeNull();
    expect(geocodeQueryUrl('   ', {})).toBeNull();
    expect(geocodeQueryUrl(null, {})).toBeNull();
  });
});

describe('geocodeKindLabel', () => {
  it('maps known category/type pairs to human labels', () => {
    expect(geocodeKindLabel('natural', 'peak')).toBe('Peak');
    expect(geocodeKindLabel('leisure', 'nature_reserve')).toBe('Nature Reserve');
    expect(geocodeKindLabel('place', 'house')).toBe('Address');
  });

  it('title-cases an unknown type rather than showing a raw snake_case token', () => {
    expect(geocodeKindLabel('shop', 'car_repair')).toBe('Car Repair');
    expect(geocodeKindLabel('', '')).toBe('');
  });
});

describe('normalizeNominatimResult', () => {
  it('produces the canonical record for a peak', () => {
    const rec = normalizeNominatimResult(FX.mountBaldy[0]);
    expect(rec.id).toBe('osm:N:357557559');
    expect(rec.provider).toBe('nominatim');
    expect(rec.name).toBe('Mount Baldy');
    expect(rec.kindLabel).toBe('Peak');
    expect(rec.admin).toBe('Washoe County, Nevada');
    expect(rec.lat).toBeCloseTo(39.2785182, 6);
    expect(rec.lng).toBeCloseTo(-120.0001918, 6);
    expect(rec.isExactAddress).toBe(false);
    expect(rec.distanceKm).toBeNull();
  });

  it('converts boundingbox [S,N,W,E] strings into a numeric bbox', () => {
    const rec = normalizeNominatimResult(FX.jenkinsonLake[0]);
    expect(rec.bbox).toEqual({
      south: 38.7146812, west: -120.5732408, north: 38.7371481, east: -120.5288582,
    });
    expect(rec.kindLabel).toBe('Reservoir');
    expect(rec.admin).toBe('Sly Park, El Dorado County, California');
  });

  it('falls back to the leading display_name component when jsonv2 name is blank', () => {
    // Real behavior: house-level hits come back with name:"".
    const raw = FX.addressExact[0];
    expect(raw.name).toBe('');
    const rec = normalizeNominatimResult(raw);
    expect(rec.name).toBe('2850');
    expect(rec.displayName).toBe(raw.display_name);
  });

  it('flags a house-number hit as an exact address', () => {
    expect(normalizeNominatimResult(FX.addressExact[0]).isExactAddress).toBe(true);
    expect(normalizeNominatimResult(FX.addressRoadOnly[0]).isExactAddress).toBe(false);
    expect(normalizeNominatimResult(FX.addressRoadOnly[0]).addressType).toBe('road');
  });

  it('returns null for unusable rows', () => {
    expect(normalizeNominatimResult(null)).toBeNull();
    expect(normalizeNominatimResult({})).toBeNull();
    expect(normalizeNominatimResult({ lat: 'x', lon: '1', display_name: 'a' })).toBeNull();
    expect(normalizeNominatimResult({ lat: '95', lon: '1', display_name: 'a' })).toBeNull();
    expect(normalizeNominatimResult({ lat: '38', lon: '-120', display_name: '' })).toBeNull();
  });

  it('drops a malformed boundingbox rather than emitting a broken bbox', () => {
    const bad = Object.assign({}, FX.jenkinsonLake[0], { boundingbox: ['a', 'b', 'c', 'd'] });
    expect(normalizeNominatimResult(bad).bbox).toBeNull();
    const inverted = Object.assign({}, FX.jenkinsonLake[0], { boundingbox: ['39', '38', '-120', '-121'] });
    expect(normalizeNominatimResult(inverted).bbox).toBeNull();
  });
});

describe('normalizeGeocodeResults', () => {
  it('normalizes a whole response', () => {
    const recs = normalizeGeocodeResults(FX.mountBaldy);
    expect(recs).toHaveLength(4);
    expect(recs.every(r => r.provider === 'nominatim')).toBe(true);
  });

  it('returns [] for non-array input', () => {
    expect(normalizeGeocodeResults(null)).toEqual([]);
    expect(normalizeGeocodeResults({ error: 'nope' })).toEqual([]);
    expect(normalizeGeocodeResults(FX.empty)).toEqual([]);
  });

  it('collapses a node/way duplicate of the same place, keeping the row with a bbox', () => {
    const node = Object.assign({}, FX.jenkinsonLake[0], {
      osm_type: 'node', osm_id: 999, boundingbox: undefined,
    });
    const recs = normalizeGeocodeResults([node, FX.jenkinsonLake[0]]);
    expect(recs).toHaveLength(1);
    expect(recs[0].bbox).not.toBeNull();
  });
});

describe('rankGeocodeResults — the Mount Baldy case', () => {
  it('re-orders nearest-first, overriding the provider importance order', () => {
    const raw = normalizeGeocodeResults(FX.mountBaldy);
    // Provider order is by importance, NOT distance: the Santa Cruz hit
    // (importance 0.16005) is last despite being nearer than both Humboldts.
    expect(raw.map(r => r.admin)).toEqual([
      'Washoe County, Nevada',
      'Humboldt County, California',
      'Humboldt County, Nevada',
      'Santa Cruz County, California',
    ]);

    const ranked = rankGeocodeResults(raw, EDC);
    expect(ranked.map(r => r.admin)).toEqual([
      'Washoe County, Nevada',          // ~109 km
      'Santa Cruz County, California',  // ~205 km
      'Humboldt County, California',    // ~309 km
      'Humboldt County, Nevada',        // ~384 km
    ]);

    // distanceKm is filled and monotonically non-decreasing.
    const d = ranked.map(r => r.distanceKm);
    expect(d.every(Number.isFinite)).toBe(true);
    expect(d[0]).toBeCloseTo(108.05, 1);
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1]);
  });

  it('ranks from the anchor it is given — a different anchor gives a different winner', () => {
    const raw = normalizeGeocodeResults(FX.mountBaldy);
    const fromHumboldt = rankGeocodeResults(raw, { lat: 40.4, lng: -123.9 });
    expect(fromHumboldt[0].admin).toBe('Humboldt County, California');
  });

  it('does not mutate the input records', () => {
    const raw = normalizeGeocodeResults(FX.mountBaldy);
    rankGeocodeResults(raw, EDC);
    expect(raw.every(r => r.distanceKm === null)).toBe(true);
    expect(raw[0].admin).toBe('Washoe County, Nevada');
  });

  it('leaves provider order intact when there is no anchor', () => {
    const raw = normalizeGeocodeResults(FX.mountBaldy);
    const ranked = rankGeocodeResults(raw, null);
    expect(ranked.map(r => r.id)).toEqual(raw.map(r => r.id));
    expect(ranked.every(r => r.distanceKm === null)).toBe(true);
    expect(rankGeocodeResults(null, EDC)).toEqual([]);
  });
});

describe('geocodeFitBounds', () => {
  it('returns the extent for a real place', () => {
    const lake = rankGeocodeResults(normalizeGeocodeResults(FX.jenkinsonLake), EDC)[0];
    const b = geocodeFitBounds(lake);
    expect(b).toEqual({ south: 38.7146812, west: -120.5732408, north: 38.7371481, east: -120.5288582 });
  });

  it('returns null for a house-sized bbox so the caller falls back to setView', () => {
    // The addressExact fixture's bbox spans ~0.0001 deg (~11 m).
    const house = normalizeGeocodeResults(FX.addressExact)[0];
    expect(house.bbox).not.toBeNull();
    expect(geocodeFitBounds(house)).toBeNull();
  });

  it('honors an explicit minSpanM override', () => {
    const house = normalizeGeocodeResults(FX.addressExact)[0];
    expect(geocodeFitBounds(house, { minSpanM: 1 })).not.toBeNull();
  });

  it('returns null for a missing or malformed bbox', () => {
    expect(geocodeFitBounds(null)).toBeNull();
    expect(geocodeFitBounds({ bbox: null })).toBeNull();
    expect(geocodeFitBounds({ bbox: { south: 39, north: 38, west: -121, east: -120 } })).toBeNull();
    expect(geocodeFitBounds({ bbox: { south: NaN, north: 38, west: -121, east: -120 } })).toBeNull();
  });

  it('uses GEOCODE_FIT_MIN_SPAN_M as the default threshold', () => {
    const justUnder = { bbox: { south: 0, north: (GEOCODE_FIT_MIN_SPAN_M * 0.9) / 111320, west: 0, east: 0.000001 } };
    const justOver = { bbox: { south: 0, north: (GEOCODE_FIT_MIN_SPAN_M * 1.1) / 111320, west: 0, east: 0.000001 } };
    expect(geocodeFitBounds(justUnder)).toBeNull();
    expect(geocodeFitBounds(justOver)).not.toBeNull();
  });
});

describe('formatGeocodeDistance', () => {
  it('formats imperial by default with feet under a tenth of a mile', () => {
    expect(formatGeocodeDistance(0.02)).toMatch(/ft$/);
    expect(formatGeocodeDistance(2.3)).toBe('1.4 mi');
    expect(formatGeocodeDistance(1400)).toMatch(/^87\d ,?|^870 mi$/);
    expect(formatGeocodeDistance(1400).endsWith(' mi')).toBe(true);
  });

  it('formats metric on request', () => {
    expect(formatGeocodeDistance(0.4, { metric: true })).toBe('400 m');
    expect(formatGeocodeDistance(2.34, { metric: true })).toBe('2.3 km');
  });

  it('returns empty string for a null/NaN distance', () => {
    expect(formatGeocodeDistance(null)).toBe('');
    expect(formatGeocodeDistance(NaN)).toBe('');
    expect(formatGeocodeDistance(undefined)).toBe('');
  });
});

describe('formatGeocodeResult', () => {
  it('builds title / meta / subtitle / distance for a row', () => {
    const rec = rankGeocodeResults(normalizeGeocodeResults(FX.jenkinsonLake), EDC)[0];
    const f = formatGeocodeResult(rec);
    expect(f.title).toBe('Jenkinson Lake');
    expect(f.meta).toBe('Reservoir · Sly Park, El Dorado County, California');
    expect(f.distance).toMatch(/mi$/);
  });

  it('NEVER truncates or ellipsizes the matched string — an operator must see exactly what matched', () => {
    const long = 'A'.repeat(400) + ', Somewhere County, California, United States';
    const f = formatGeocodeResult({ name: 'X', displayName: long, kindLabel: '', admin: '', distanceKm: 1 });
    expect(f.subtitle).toBe(long);
    expect(f.subtitle).not.toContain('…');
    expect(f.subtitle).not.toContain('...');
    expect(f.subtitle.length).toBe(long.length);
  });

  it('returns null for a null record', () => {
    expect(formatGeocodeResult(null)).toBeNull();
  });
});

describe('geocodeQueryHasHouseNumber', () => {
  it('detects a leading street number', () => {
    expect(geocodeQueryHasHouseNumber('7020 Talmage Ct, El Dorado Hills, CA 95762')).toBe(true);
    expect(geocodeQueryHasHouseNumber('2850 Fairlane Ct')).toBe(true);
  });

  it('does not fire on place names or on coordinate-shaped strings', () => {
    expect(geocodeQueryHasHouseNumber('Mount Baldy')).toBe(false);
    expect(geocodeQueryHasHouseNumber('Highway 50')).toBe(false);
    expect(geocodeQueryHasHouseNumber('38 47 12')).toBe(false);   // DMS
    expect(geocodeQueryHasHouseNumber('38.78673')).toBe(false);
    expect(geocodeQueryHasHouseNumber('')).toBe(false);
  });
});

describe('geocodeMatchWarning — honest degradation', () => {
  it('warns when a street-number query only matched a road', () => {
    const recs = normalizeGeocodeResults(FX.addressRoadOnly);
    const w = geocodeMatchWarning('4750 Golden Foothill Pkwy, El Dorado Hills, CA 95762', recs);
    expect(w).toBeTruthy();
    expect(w).toMatch(/street-number/i);
  });

  it('stays silent when the street number actually matched', () => {
    const recs = normalizeGeocodeResults(FX.addressExact);
    expect(geocodeMatchWarning('2850 Fairlane Ct, Placerville, CA 95667', recs)).toBeNull();
  });

  it('stays silent for name queries and for empty result sets', () => {
    expect(geocodeMatchWarning('Mount Baldy', normalizeGeocodeResults(FX.mountBaldy))).toBeNull();
    expect(geocodeMatchWarning('7020 Talmage Ct', [])).toBeNull();
    expect(geocodeMatchWarning('7020 Talmage Ct', null)).toBeNull();
  });
});

describe('geocodeStatusText', () => {
  it('covers every state with a valid tone', () => {
    const cases = [
      geocodeStatusText({ loading: true }),
      geocodeStatusText({ error: 'rate-limited' }),
      geocodeStatusText({ error: 'offline' }),
      geocodeStatusText({ error: 'HTTP 500' }),
      geocodeStatusText({ count: 0 }),
      geocodeStatusText({ count: 1 }),
      geocodeStatusText({ count: 4 }),
      geocodeStatusText({ count: 2, fromCache: true, cachedAt: 0, nowMs: 3 * 86400000 }),
    ];
    for (const c of cases) {
      expect(typeof c.text).toBe('string');
      expect(c.text.length).toBeGreaterThan(0);
      expect(['loading', 'ok', 'warn', 'error']).toContain(c.tone);
    }
  });

  it('says match / matches correctly and reports cached age', () => {
    expect(geocodeStatusText({ count: 1 }).text).toContain('1 match');
    expect(geocodeStatusText({ count: 4 }).text).toContain('4 matches');
    const cached = geocodeStatusText({ count: 2, fromCache: true, cachedAt: 0, nowMs: 3 * 86400000 });
    expect(cached.text).toContain('cached 3d ago');
    expect(cached.tone).toBe('warn');
  });

  it('treats a rate limit as an explicit non-retrying state', () => {
    const s = geocodeStatusText({ error: 'rate-limited' });
    expect(s.tone).toBe('error');
    expect(s.text).toMatch(/coordinates/i); // always points at the offline-capable path
  });

  it('tells the operator coordinates still work when offline', () => {
    expect(geocodeStatusText({ error: 'offline' }).text).toMatch(/coordinates/i);
  });
});

describe('geocodeAnchorLabel', () => {
  it('names the GPS source and its age', () => {
    const l = geocodeAnchorLabel({ source: 'gps', at: 0 }, 4 * 60000);
    expect(l).toContain('GPS fix');
    expect(l).toContain('4m');
  });

  it('names the map source, and is empty with no anchor', () => {
    expect(geocodeAnchorLabel({ source: 'map' }, 1)).toContain('map center');
    expect(geocodeAnchorLabel(null, 1)).toBe('');
  });
});

describe('geocodeCacheKey', () => {
  it('is case- and whitespace-insensitive', () => {
    expect(geocodeCacheKey('  Jenkinson   LAKE ', EDC)).toBe(geocodeCacheKey('jenkinson lake', EDC));
  });

  it('quantizes the anchor so nearby searches share a cache entry', () => {
    expect(geocodeCacheKey('x', { lat: 38.685, lng: -120.99 }))
      .toBe(geocodeCacheKey('x', { lat: 38.71, lng: -120.95 }));
  });

  it('separates anchors that are far enough apart to change the viewbox result set', () => {
    expect(geocodeCacheKey('x', { lat: 38.685, lng: -120.99 }))
      .not.toBe(geocodeCacheKey('x', { lat: 39.5, lng: -105.0 }));
  });

  it('handles a missing anchor and rejects an empty query', () => {
    expect(geocodeCacheKey('x', null)).toContain('none');
    expect(geocodeCacheKey('', EDC)).toBeNull();
    expect(geocodeCacheKey('   ', EDC)).toBeNull();
  });
});

describe('geocodeRateLimitDelay', () => {
  it('is 0 on the first request and after the interval has elapsed', () => {
    expect(geocodeRateLimitDelay(0, 5000, 1100)).toBe(0);
    expect(geocodeRateLimitDelay(1000, 5000, 1100)).toBe(0);
    expect(geocodeRateLimitDelay(1000, 2100, 1100)).toBe(0);
  });

  it('returns the exact remaining wait mid-interval', () => {
    expect(geocodeRateLimitDelay(1000, 1500, 1100)).toBe(600);
  });

  it('is never negative and treats a backwards clock jump as a full wait', () => {
    expect(geocodeRateLimitDelay(5000, 1000, 1100)).toBe(1100);
    for (const [last, now] of [[0, 0], [1, 0], [1e12, 1], [5000, 5000]]) {
      expect(geocodeRateLimitDelay(last, now, 1100)).toBeGreaterThanOrEqual(0);
    }
  });

  it('defaults to the policy interval', () => {
    expect(geocodeRateLimitDelay(1000, 1000)).toBe(GEOCODE_MIN_INTERVAL_MS);
    expect(GEOCODE_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(1000); // 1 req/s policy
  });
});

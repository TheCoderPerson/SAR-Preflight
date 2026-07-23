const {
  PARCEL_REGISTRY, PARCEL_MIN_ZOOM, parcelSourcesForBounds, parcelQueryUrl,
  normalizeParcels, parcelChipState,
} = require('../../sar-preflight-core.js');

const edcFixture = require('../fixtures/parcels-edc-response.json');
const dwrFixture = require('../fixtures/parcels-dwr-response.json');

const EDC = PARCEL_REGISTRY.counties['06017'];
const DWR = PARCEL_REGISTRY.fallback;

// View bboxes
const PLACERVILLE = { west: -120.82, south: 38.72, east: -120.79, north: 38.74 };
const SACRAMENTO = { west: -121.50, south: 38.52, east: -121.42, north: 38.60 };
const COUNTY_LINE = { west: -121.20, south: 38.60, east: -121.10, north: 38.70 }; // straddles EDC west edge

// ============================================================
// Registry
// ============================================================

describe('PARCEL_REGISTRY', () => {
  it('fallback (DWR) carries the verified field map and no owner fields', () => {
    expect(DWR.tier).toBe(2);
    expect(DWR.fields.apn).toBe('PARCEL_APN');
    expect(DWR.fields.situsAddress).toBe('SITE_ADDR');
    expect(DWR.fields.countyFips).toBe('FIPS_CODE');
    expect(DWR.maxRecordCount).toBe(1500);
    expect(Object.keys(DWR.fields).some(k => /owner/i.test(k))).toBe(false);
  });

  it('El Dorado Tier 1 entry is schema-confirmed with a bbox and verified field map', () => {
    expect(EDC.tier).toBe(1);
    expect(EDC.fips).toBe('06017');
    expect(EDC.verifiedLevel).toBe('schema_confirmed');
    expect(EDC.bbox.west).toBeLessThan(EDC.bbox.east);
    expect(EDC.bbox.south).toBeLessThan(EDC.bbox.north);
    expect(EDC.fields.apn).toBe('PRCL_ID');
    expect(EDC.fields.situsAddress).toBe('PRCL_ADDR');
    expect(EDC.maxRecordCount).toBe(2000);
    expect(Object.keys(EDC.fields).some(k => /owner/i.test(k))).toBe(false);
  });

  it('gates below z15 (a wider view exceeds the servers’ record caps)', () => {
    expect(PARCEL_MIN_ZOOM).toBe(15);
  });
});

// ============================================================
// parcelSourcesForBounds — county resolution + ladder order
// ============================================================

describe('parcelSourcesForBounds', () => {
  it('inside El Dorado -> county first, statewide fallback last', () => {
    const s = parcelSourcesForBounds(PARCEL_REGISTRY, PLACERVILLE);
    expect(s.map(c => c.id)).toEqual(['edc-parcels', 'ca-dwr-lightbox']);
  });

  it('outside any Tier 1 county (Sacramento) -> fallback only', () => {
    const s = parcelSourcesForBounds(PARCEL_REGISTRY, SACRAMENTO);
    expect(s.map(c => c.id)).toEqual(['ca-dwr-lightbox']);
  });

  it('a view straddling the county line still includes the county source', () => {
    const s = parcelSourcesForBounds(PARCEL_REGISTRY, COUNTY_LINE);
    expect(s[0].id).toBe('edc-parcels');
  });

  it('fallback is always present and always last', () => {
    for (const bbox of [PLACERVILLE, SACRAMENTO, COUNTY_LINE]) {
      const s = parcelSourcesForBounds(PARCEL_REGISTRY, bbox);
      expect(s[s.length - 1].id).toBe('ca-dwr-lightbox');
    }
  });
});

// ============================================================
// parcelQueryUrl
// ============================================================

describe('parcelQueryUrl', () => {
  it('builds a direct (no proxy) EDC geojson query with the mapped outFields', () => {
    const url = parcelQueryUrl(EDC, PLACERVILLE);
    expect(url.startsWith('https://gis.eldoradocounty.ca.gov/')).toBe(true);
    expect(url).toContain('geometry=-120.82,38.72,-120.79,38.74'); // w,s,e,n order
    expect(url).toContain(encodeURIComponent('PRCL_ID,PRCL_ADDR,ACREAGE,USE_CD_LITPRI,YR_BUILT,JURS_LIT,FIRE_DIST'));
    expect(url).toContain('resultRecordCount=2000');
    expect(url).toContain('f=geojson');
    expect(url).toContain('outSR=4326');
    expect(url).toContain('returnGeometry=true');
    expect(url).not.toContain('maxAllowableOffset'); // parcel boundary fidelity is the point
  });

  it('builds the DWR query with its own field list and record cap', () => {
    const url = parcelQueryUrl(DWR, SACRAMENTO);
    expect(url.startsWith('https://gis.water.ca.gov/')).toBe(true);
    expect(url).toContain('PARCEL_APN');
    expect(url).toContain('resultRecordCount=1500');
  });
});

// ============================================================
// normalizeParcels
// ============================================================

describe('normalizeParcels', () => {
  it('normalizes EDC features: apn/situs/acreage, county fips from the registry, nulls for absent fields', () => {
    const out = normalizeParcels(edcFixture.features, EDC, 1753000000000);
    expect(out).toHaveLength(2); // geometry-less third feature dropped
    const p = out[0];
    expect(p.apn).toBe('003101032');
    expect(p.id).toBe('06017:003101032');
    expect(p.countyFips).toBe('06017');
    expect(p.situsAddress).toBe('3211 SACRAMENTO ST'); // trimmed
    expect(p.acreage).toBe(0.55);
    expect(p.landUseDesc).toMatch(/SINGLE FAM/);
    expect(p.yearBuilt).toBe(1972);
    expect(p.city).toBeNull();   // EDC publishes no city/zip — null, never ''
    expect(p.zip).toBeNull();
    expect(p.sourceTier).toBe(1);
    expect(p.sourceId).toBe('edc-parcels');
    expect(p.fetchedAt).toBe(1753000000000);
  });

  it('empty-string source values become null (second EDC feature has PRCL_ADDR "")', () => {
    const out = normalizeParcels(edcFixture.features, EDC, 0);
    expect(out[1].situsAddress).toBeNull();
    expect(out[1].yearBuilt).toBeNull();
  });

  it('normalizes DWR features: situs/city/zip populated, fips from FIPS_CODE, acreage null', () => {
    const out = normalizeParcels(dwrFixture.features, DWR, 1);
    expect(out).toHaveLength(2);
    expect(out[0].apn).toBe('051-250-013');
    expect(out[0].countyFips).toBe('06067');
    expect(out[0].id).toBe('06067:051-250-013');
    expect(out[0].city).toBe('SACRAMENTO');
    expect(out[0].zip).toBe('95820');
    expect(out[0].acreage).toBeNull();      // DWR doesn't publish acreage
    expect(out[0].sourceTier).toBe(2);
    expect(out[1].situsAddress).toBeNull(); // null situs stays null
  });

  it('handles null/empty inputs', () => {
    expect(normalizeParcels(null, DWR, 0)).toEqual([]);
    expect(normalizeParcels([], EDC, 0)).toEqual([]);
  });
});

// ============================================================
// parcelChipState — provenance chip + degradation ladder (§9/§12)
// ============================================================

describe('parcelChipState', () => {
  it('unavailable state is explicit and safety-worded (highest precedence)', () => {
    const c = parcelChipState({ unavailable: true, zoom: 16, gateZoom: 15, loading: true });
    expect(c.tone).toBe('error');
    expect(c.text).toContain('do not interpret as public land');
  });

  it('below the zoom gate', () => {
    const c = parcelChipState({ zoom: 13, gateZoom: 15 });
    expect(c.tone).toBe('muted');
    expect(c.text).toContain('zoom in to load');
  });

  it('loading', () => {
    expect(parcelChipState({ zoom: 16, gateZoom: 15, loading: true }).text).toContain('loading');
  });

  it('live tier 1 shows the county label and count', () => {
    const c = parcelChipState({ zoom: 16, gateZoom: 15, cfg: EDC, count: 755 });
    expect(c.tone).toBe('ok');
    expect(c.text).toContain('El Dorado County GIS');
    expect(c.text).toContain('755');
  });

  it('tier 2 after a tier-1 failure warns about the degradation', () => {
    const c = parcelChipState({ zoom: 16, gateZoom: 15, cfg: DWR, count: 900, failedTier1: true });
    expect(c.tone).toBe('warn');
    expect(c.text).toContain('County source unavailable');
  });

  it('tier 2 normally states scope (APN+address only)', () => {
    const c = parcelChipState({ zoom: 16, gateZoom: 15, cfg: DWR, count: 900 });
    expect(c.tone).toBe('ok');
    expect(c.text).toContain('APN+address only');
    expect(c.text).toContain('quarterly');
  });

  it('cached data shows source + age with a warning tone', () => {
    const now = 10 * 60000;
    const c = parcelChipState({ zoom: 16, gateZoom: 15, cfg: DWR, count: 5, fromCache: true, cachedAt: 0, nowMs: now });
    expect(c.tone).toBe('warn');
    expect(c.text).toContain('cached 10m ago');
  });

  it('truncated results are flagged, never silently capped', () => {
    const c = parcelChipState({ zoom: 15, gateZoom: 15, cfg: DWR, count: 1500, truncated: true });
    expect(c.tone).toBe('warn');
    expect(c.text).toContain('first 1500 only');
  });

  it('a genuine zero-parcel result is stated explicitly', () => {
    const c = parcelChipState({ zoom: 16, gateZoom: 15, cfg: DWR, count: 0 });
    expect(c.text).toContain('0 parcels in view');
  });
});

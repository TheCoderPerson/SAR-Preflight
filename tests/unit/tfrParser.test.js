const {
  parseTfrGeoJson, parseTfrList, parseTfrDetailXml,
  filterTfrsIntersectingArea, isTfrActiveNow, geoJsonOuterRings,
} = require('../../sar-preflight-core.js');

// --- GeoServer GeoJSON fixture (TFR:V_TFR_LOC shape) ---
const geojsonFixture = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        NOTAM_KEY: '6/4112-1-FDC-F', TITLE: 'Wildfire near Placerville',
        LEGAL: 'HAZARDS', CNS_LOCATION_ID: 'ZOA', STATE: 'CA',
      },
      geometry: {
        type: 'Polygon',
        // GeoJSON is [lng,lat]; a box overlapping El Dorado County
        coordinates: [[[-121.0, 38.6], [-120.9, 38.6], [-120.9, 38.7], [-121.0, 38.7], [-121.0, 38.6]]],
      },
    },
    {
      type: 'Feature',
      properties: { NOTAM_KEY: '6/9999-2-FDC-F', TITLE: 'Far away TFR', LEGAL: 'SECURITY', CNS_LOCATION_ID: 'ZNY', STATE: 'NY' },
      geometry: { type: 'Polygon', coordinates: [[[-74.0, 40.0], [-73.9, 40.0], [-73.9, 40.1], [-74.0, 40.1], [-74.0, 40.0]]] },
    },
  ],
};

const area = [[38.64, -120.96], [38.64, -120.94], [38.66, -120.94], [38.66, -120.96], [38.64, -120.96]];

describe('parseTfrGeoJson()', () => {
  it('parses a FeatureCollection into normalized TFRs', () => {
    const { tfrs, errors } = parseTfrGeoJson(geojsonFixture);
    expect(errors).toEqual([]);
    expect(tfrs.length).toBe(2);
    const t = tfrs[0];
    expect(t.id).toBe('6/4112'); // NOTAM_KEY truncated at first '-'
    expect(t.name).toBe('Wildfire near Placerville');
    expect(t.type).toBe('HAZARDS');
    expect(t.artcc).toBe('ZOA');
    expect(t.source).toBe('geojson');
    expect(t.polygons.length).toBe(1);
    // coordinates swapped to [lat,lng]
    expect(t.polygons[0][0]).toEqual([38.6, -121.0]);
  });

  it('accepts a JSON string', () => {
    const { tfrs } = parseTfrGeoJson(JSON.stringify(geojsonFixture));
    expect(tfrs.length).toBe(2);
  });

  it('returns an error (not a throw) on invalid JSON', () => {
    const { tfrs, errors } = parseTfrGeoJson('{not json');
    expect(tfrs).toEqual([]);
    expect(errors.length).toBe(1);
  });

  it('handles MultiPolygon geometries', () => {
    const mp = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature', properties: { NOTAM_KEY: '1/1', TITLE: 'multi' },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [[[-121, 38], [-120, 38], [-120, 39], [-121, 39], [-121, 38]]],
            [[[-119, 37], [-118, 37], [-118, 38], [-119, 38], [-119, 37]]],
          ],
        },
      }],
    };
    const { tfrs } = parseTfrGeoJson(mp);
    expect(tfrs[0].polygons.length).toBe(2);
  });
});

describe('parseTfrList()', () => {
  it('parses exportTfrList JSON into geometry-less TFRs', () => {
    const list = [{ notam_id: '6/5974', type: 'SECURITY', facility: 'ZOA', state: 'CA', description: 'VIP movement' }];
    const { tfrs } = parseTfrList(list);
    expect(tfrs.length).toBe(1);
    expect(tfrs[0].id).toBe('6/5974');
    expect(tfrs[0].source).toBe('list');
    expect(tfrs[0].polygons).toEqual([]);
  });
  it('parseTfrGeoJson delegates array input to parseTfrList', () => {
    const { tfrs } = parseTfrGeoJson([{ notam_id: '6/1', facility: 'ZOA' }]);
    expect(tfrs[0].source).toBe('list');
  });
});

describe('filterTfrsIntersectingArea()', () => {
  it('keeps only TFRs whose geometry intersects the area', () => {
    const { tfrs } = parseTfrGeoJson(geojsonFixture);
    const hits = filterTfrsIntersectingArea(tfrs, area);
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe('6/4112');
  });
  it('returns [] for geometry-less TFRs', () => {
    const { tfrs } = parseTfrList([{ notam_id: '6/1', facility: 'ZOA' }]);
    expect(filterTfrsIntersectingArea(tfrs, area)).toEqual([]);
  });
});

describe('isTfrActiveNow()', () => {
  it('treats null effective times as active (safety default)', () => {
    expect(isTfrActiveNow({ effectiveStart: null, effectiveEnd: null }, Date.UTC(2026, 5, 7))).toBe(true);
  });
  it('is false before the start', () => {
    expect(isTfrActiveNow({ effectiveStart: '2026-06-10T00:00:00Z', effectiveEnd: '2026-06-11T00:00:00Z' }, Date.UTC(2026, 5, 7))).toBe(false);
  });
  it('is false after the end', () => {
    expect(isTfrActiveNow({ effectiveStart: '2026-06-01T00:00:00Z', effectiveEnd: '2026-06-02T00:00:00Z' }, Date.UTC(2026, 5, 7))).toBe(false);
  });
  it('is true within the window', () => {
    expect(isTfrActiveNow({ effectiveStart: '2026-06-06T00:00:00Z', effectiveEnd: '2026-06-08T00:00:00Z' }, Date.UTC(2026, 5, 7))).toBe(true);
  });
});

// --- FAA "XNOTAM-Update" detail XML fixture (no namespaces) ---
const detailXml = `<?xml version="1.0" encoding="UTF-8"?>
<XNOTAM-Update>
  <Group><Add><Not>
    <NotUid><txtLocalName>6/5974</txtLocalName><noSeqNo>5974</noSeqNo></NotUid>
    <dateEffective>2026-06-06T20:46:00</dateEffective>
    <dateExpire>2026-06-08T07:00:00</dateExpire>
    <codeFacility>ZOA</codeFacility>
    <txtNameUSState>CA</txtNameUSState>
    <codeType>91.137(a)(2)</codeType>
    <txtDescrPurpose>Firefighting operations</txtDescrPurpose>
    <aseTFRArea>
      <valDistVerLower>0</valDistVerLower><uomDistVerLower>FT</uomDistVerLower>
      <valDistVerUpper>8000</valDistVerUpper><uomDistVerUpper>FT</uomDistVerUpper>
      <abdMergedArea>
        <Avx><codeType>GRC</codeType><geoLat>38.60N</geoLat><geoLong>121.00W</geoLong></Avx>
        <Avx><codeType>GRC</codeType><geoLat>38.60N</geoLat><geoLong>120.90W</geoLong></Avx>
        <Avx><codeType>GRC</codeType><geoLat>38.70N</geoLat><geoLong>120.90W</geoLong></Avx>
        <Avx><codeType>GRC</codeType><geoLat>38.70N</geoLat><geoLong>121.00W</geoLong></Avx>
      </abdMergedArea>
    </aseTFRArea>
  </Not></Add></Group>
</XNOTAM-Update>`;

describe('parseTfrDetailXml()', () => {
  it('extracts id, altitudes, times, and polygon from detail XML', () => {
    const { tfrs, errors } = parseTfrDetailXml(detailXml);
    expect(errors).toEqual([]);
    expect(tfrs.length).toBe(1);
    const t = tfrs[0];
    expect(t.id).toBe('6/5974');
    expect(t.lowerAlt).toBe(0);
    expect(t.upperAlt).toBe(8000);
    expect(t.altUom).toBe('FT');
    expect(t.effectiveStart).toBe('2026-06-06T20:46:00Z');
    expect(t.artcc).toBe('ZOA');
    expect(t.polygons.length).toBe(1);
    expect(t.polygons[0].length).toBe(4);
    expect(t.polygons[0][0][0]).toBeCloseTo(38.6, 4);
    expect(t.polygons[0][0][1]).toBeCloseTo(-121.0, 4);
  });

  it('parses a circular (CIR) TFR into a polygon ring', () => {
    const circleXml = `<XNOTAM-Update><Not>
      <NotUid><txtLocalName>6/0001</txtLocalName></NotUid>
      <aseShapes><Abd><Avx><codeType>CIR</codeType><geoLat>38.685N</geoLat><geoLong>120.99W</geoLong><valRadiusArc>3.0</valRadiusArc><uomRadiusArc>NM</uomRadiusArc></Avx></Abd></aseShapes>
    </Not></XNOTAM-Update>`;
    const { tfrs } = parseTfrDetailXml(circleXml);
    expect(tfrs.length).toBe(1);
    expect(tfrs[0].polygons.length).toBe(1);
    expect(tfrs[0].polygons[0].length).toBeGreaterThan(10);
  });

  it('returns an error (not a throw) on malformed XML', () => {
    const { tfrs, errors } = parseTfrDetailXml('<XNOTAM><Not</broken>');
    expect(tfrs).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('the detail XML polygon intersects an overlapping drawn area', () => {
    const { tfrs } = parseTfrDetailXml(detailXml);
    const hits = filterTfrsIntersectingArea(tfrs, area);
    expect(hits.length).toBe(1);
  });
});

describe('geoJsonOuterRings()', () => {
  it('returns [] for non-polygon geometries', () => {
    expect(geoJsonOuterRings({ type: 'Point', coordinates: [0, 0] })).toEqual([]);
    expect(geoJsonOuterRings(null)).toEqual([]);
  });
});

// Utility wire sources (PG&E GRIP feeders + CEC transmission) — pure core fns.
const {
  WIRE_CATEGORIES, UTILITY_WIRE_SOURCES,
  utilityWireSourcesForBounds, utilityWireQueryUrl, normalizeUtilityWires, geojsonLineLatLngs,
  clipLineGeometryToBbox,
} = require('../../sar-preflight-core.js');

const pgeFixture = require('../fixtures/utility-pge-response.json');
const cecFixture = require('../fixtures/utility-cec-response.json');

const PGE = UTILITY_WIRE_SOURCES.find(s => s.id === 'pge-grip-feeders');
const CEC = UTILITY_WIRE_SOURCES.find(s => s.id === 'cec-transmission');

describe('WIRE_CATEGORIES src partition', () => {
  it('marks every category as osm or utility', () => {
    Object.values(WIRE_CATEGORIES).forEach(info => {
      expect(['osm', 'utility']).toContain(info.src);
    });
  });
  it('has exactly the two utility categories the registry references', () => {
    const utilCats = Object.keys(WIRE_CATEGORIES).filter(k => WIRE_CATEGORIES[k].src === 'utility').sort();
    expect(utilCats).toEqual(['utility_distribution', 'utility_transmission']);
    expect(UTILITY_WIRE_SOURCES.map(s => s.category).sort()).toEqual(utilCats);
  });
});

describe('utilityWireSourcesForBounds — coverage gating', () => {
  it('El Dorado County op area gets both sources', () => {
    const bbox = { west: -120.85, south: 38.68, east: -120.75, north: 38.75 };
    const ids = utilityWireSourcesForBounds(UTILITY_WIRE_SOURCES, bbox).map(c => c.id);
    expect(ids).toEqual(['pge-grip-feeders', 'cec-transmission']);
  });
  it('San Diego (outside PG&E territory) gets CEC only', () => {
    const bbox = { west: -117.3, south: 32.6, east: -117.0, north: 32.9 };
    const ids = utilityWireSourcesForBounds(UTILITY_WIRE_SOURCES, bbox).map(c => c.id);
    expect(ids).toEqual(['cec-transmission']);
  });
  it('Tahoe basin still gates in (bbox is coarse; the live query just returns nothing there)', () => {
    const bbox = { west: -120.05, south: 38.85, east: -119.90, north: 38.99 };
    expect(utilityWireSourcesForBounds(UTILITY_WIRE_SOURCES, bbox).length).toBeGreaterThan(0);
  });
  it('an out-of-state op area (Denver) gets no sources — OSM stays the only wire source', () => {
    const bbox = { west: -105.1, south: 39.6, east: -104.8, north: 39.9 };
    expect(utilityWireSourcesForBounds(UTILITY_WIRE_SOURCES, bbox)).toEqual([]);
  });
  it('handles null inputs', () => {
    expect(utilityWireSourcesForBounds(null, { west: 0, south: 0, east: 1, north: 1 })).toEqual([]);
    expect(utilityWireSourcesForBounds(UTILITY_WIRE_SOURCES, null)).toEqual([]);
  });
});

describe('utilityWireQueryUrl', () => {
  const bbox = { west: -120.85, south: 38.68, east: -120.75, north: 38.75 };
  it('builds a direct ArcGIS GeoJSON envelope query with display simplification', () => {
    const url = utilityWireQueryUrl(PGE, bbox);
    expect(url).toContain(PGE.url + '/query?');
    expect(url).toContain('geometry=-120.85,38.68,-120.75,38.75');
    expect(url).toContain('geometryType=esriGeometryEnvelope');
    expect(url).toContain('inSR=4326');
    expect(url).toContain('outSR=4326');
    expect(url).toContain('f=geojson');
    expect(url).toContain('resultRecordCount=2000');
    // Unlike parcels, hazard corridors WANT server-side simplification
    expect(url).toContain('maxAllowableOffset=0.00003');
    expect(url).toContain('geometryPrecision=5');
  });
  it('requests exactly the mapped fields', () => {
    const url = utilityWireQueryUrl(CEC, bbox);
    const fields = decodeURIComponent(url.match(/outFields=([^&]+)/)[1]);
    expect(fields.split(',')).toEqual(expect.arrayContaining(['Name', 'kV', 'Owner', 'Status', 'Circuit', 'Type', 'TLine_Name']));
  });
});

describe('normalizeUtilityWires — PG&E feeders', () => {
  const recs = normalizeUtilityWires(pgeFixture.features, PGE, 1234);
  it('maps the schema-confirmed fields', () => {
    expect(recs).toHaveLength(2);
    const r = recs[0];
    expect(r.id).toBe('pge-grip-feeders:152261106');
    expect(r.category).toBe('utility_distribution');
    expect(r.name).toBe('DIAMOND SPRINGS 1106');
    expect(r.voltageKv).toBe(12);       // numeric, parsed from the string field
    expect(r.substation).toBe('DIAMOND SPRINGS');
    expect(r.division).toBe('Sierra');
    expect(r.geometry.type).toBe('MultiLineString');
    expect(r.fetchedAt).toBe(1234);
  });
  it('carries the OH/UG + service-drop caveat and attribution on every record', () => {
    recs.forEach(r => {
      expect(r.caveat).toMatch(/no overhead\/underground/i);
      expect(r.attribution).toMatch(/PG&E GRIP/);
    });
  });
  it('fields the source lacks are null, never empty string', () => {
    const r = recs[0];
    expect(r.owner).toBeNull();
    expect(r.ohUg).toBeNull();     // the critical gap: GRIP has no OH/UG flag
    expect(r.status).toBeNull();
    expect(r.lineName).toBeNull();
  });
});

describe('normalizeUtilityWires — CEC transmission', () => {
  const recs = normalizeUtilityWires(cecFixture.features, CEC, null);
  it('drops Proposed lines (not built = not a hazard) and geometry-less rows', () => {
    // fixture: 3 operational + 1 Proposed + 1 geometry-less
    expect(recs).toHaveLength(3);
    expect(recs.every(r => r.status !== 'Proposed')).toBe(true);
  });
  it('maps voltage/owner/circuit and the OH/UG flag', () => {
    const r = recs[0];
    expect(r.category).toBe('utility_transmission');
    expect(r.voltageKv).toBe(115);
    expect(r.owner).toBe('PG&E');
    expect(r.circuit).toBe('Single');
    expect(r.ohUg).toBe('OH');
  });
  it('whitespace-only strings normalize to null (live TLine_Name is " ")', () => {
    expect(recs[0].lineName).toBeNull();
  });
});

describe('clipLineGeometryToBbox', () => {
  const box = { west: 0, south: 0, east: 10, north: 10 };
  it('keeps a fully-inside line untouched (as MultiLineString)', () => {
    const g = { type: 'LineString', coordinates: [[1, 1], [2, 2], [3, 1]] };
    expect(clipLineGeometryToBbox(g, box)).toEqual({
      type: 'MultiLineString', coordinates: [[[1, 1], [2, 2], [3, 1]]],
    });
  });
  it('drops a fully-outside line', () => {
    const g = { type: 'LineString', coordinates: [[20, 20], [30, 30]] };
    expect(clipLineGeometryToBbox(g, box)).toBeNull();
  });
  it('clips a crossing segment to the bbox edge', () => {
    const g = { type: 'LineString', coordinates: [[-5, 5], [15, 5]] };
    expect(clipLineGeometryToBbox(g, box)).toEqual({
      type: 'MultiLineString', coordinates: [[[0, 5], [10, 5]]],
    });
  });
  it('splits a line that exits and re-enters into separate parts', () => {
    // in → out the east side → back in: the outside excursion is cut
    const g = { type: 'LineString', coordinates: [[5, 5], [15, 5], [15, 8], [5, 8]] };
    const clipped = clipLineGeometryToBbox(g, box);
    expect(clipped.type).toBe('MultiLineString');
    expect(clipped.coordinates).toEqual([
      [[5, 5], [10, 5]],
      [[10, 8], [5, 8]],
    ]);
  });
  it('merges consecutive in-bbox segments into one part', () => {
    const g = { type: 'MultiLineString', coordinates: [[[1, 1], [2, 2]], [[20, 20], [21, 21]]] };
    const clipped = clipLineGeometryToBbox(g, box);
    expect(clipped.coordinates).toEqual([[[1, 1], [2, 2]]]);
  });
  it('without a bbox returns the geometry unchanged', () => {
    const g = { type: 'LineString', coordinates: [[1, 1], [2, 2]] };
    expect(clipLineGeometryToBbox(g, null)).toBe(g);
  });
});

describe('normalizeUtilityWires — clipBbox', () => {
  it('clips geometry to the fetch bbox and drops features left with nothing inside', () => {
    const feats = [
      { geometry: { type: 'LineString', coordinates: [[-120.80, 38.71], [-120.79, 38.72]] }, properties: { Feeder_Name: 'IN', Nominal_Voltage: '12' } },
      { geometry: { type: 'LineString', coordinates: [[-121.5, 39.5], [-121.4, 39.6]] }, properties: { Feeder_Name: 'OUT', Nominal_Voltage: '12' } },
    ];
    const bbox = { west: -120.85, south: 38.68, east: -120.75, north: 38.75 };
    const recs = normalizeUtilityWires(feats, PGE, null, bbox);
    expect(recs).toHaveLength(1);
    expect(recs[0].name).toBe('IN');
    expect(recs[0].geometry.type).toBe('MultiLineString');
  });
});

describe('geojsonLineLatLngs', () => {
  it('flips LineString [lng,lat] → [lat,lng]', () => {
    const g = { type: 'LineString', coordinates: [[-120.8, 38.7], [-120.9, 38.8]] };
    expect(geojsonLineLatLngs(g)).toEqual([[38.7, -120.8], [38.8, -120.9]]);
  });
  it('produces nested arrays for MultiLineString (the L.polyline multi shape)', () => {
    const g = { type: 'MultiLineString', coordinates: [[[-120.8, 38.7], [-120.81, 38.71]], [[-121, 39], [-121.1, 39.1]]] };
    expect(geojsonLineLatLngs(g)).toEqual([
      [[38.7, -120.8], [38.71, -120.81]],
      [[39, -121], [39.1, -121.1]],
    ]);
  });
  it('returns null for missing or non-line geometry', () => {
    expect(geojsonLineLatLngs(null)).toBeNull();
    expect(geojsonLineLatLngs({ type: 'Polygon', coordinates: [] })).toBeNull();
    expect(geojsonLineLatLngs({ type: 'LineString' })).toBeNull();
  });
});

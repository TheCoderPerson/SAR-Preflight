const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// Minimal Leaflet mock (render layer fns are guarded; we exercise card/link/assessment DOM)
const layerGroupMock = () => ({ _layers: [], addLayer(x){ this._layers.push(x); }, clearLayers(){ this._layers = []; }, getLayers(){ return this._layers; }, addTo(){ return this; } });
globalThis.L = {
  layerGroup: () => layerGroupMock(),
  polygon: () => ({ bindPopup() { return this; } }),
  circleMarker: () => ({ bindPopup() { return this; } }),
};

const app = require('../../sar-preflight.js');
const { S, ingestFaaFileText, renderTfrCards, renderDeepLinks, renderNotamCards, computeAssessment, applyTfrImport, parsePastedNotams, focusNotam } = app;

// Mock map so renderImportedTfrLayer/buildLayerControl don't crash if reached
S.map = { hasLayer: () => false, addLayer() {}, removeLayer() {}, fitBounds: vi.fn(), setView: vi.fn() };

const geojson = JSON.stringify({
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { NOTAM_KEY: '6/4112-1-FDC-F', TITLE: 'Wildfire near Placerville', LEGAL: 'HAZARDS', CNS_LOCATION_ID: 'ZOA', STATE: 'CA' },
    geometry: { type: 'Polygon', coordinates: [[[-121.0, 38.6], [-120.9, 38.6], [-120.9, 38.7], [-121.0, 38.7], [-121.0, 38.6]]] },
  }],
});

function setBody() {
  document.body.innerHTML = `
    <input id="cfgMaxWind" type="number" value="27" />
    <span id="assessBadge" class="assessment-badge">--</span>
    <span id="assessText">--</span>
    <span id="notamStatus"></span>
    <div id="tfrStaleBanner"></div>
    <div id="notamDeepLinks"></div>
    <div id="tfrList"></div><span id="tfrCount"></span>
    <textarea id="notamPasteBox"></textarea>
    <div id="notamParseMsg"></div>
    <div id="notamList"></div>
    <div id="layerList"></div>
  `;
}

function setArea() {
  const areaRing = [{ lat: 38.6, lng: -121.0 }, { lat: 38.6, lng: -120.9 }, { lat: 38.7, lng: -120.9 }, { lat: 38.7, lng: -121.0 }];
  S.areaType = 'POLYGON';
  S.areaCenter = { lat: 38.65, lng: -120.95 };
  S.areaBounds = { getSouthWest: () => ({ lat: 38.6, lng: -121.0 }), getNorthEast: () => ({ lat: 38.7, lng: -120.9 }) };
  S.currentArea = { getLatLngs: () => [areaRing] };
}

describe('TFR import → render → assessment (DOM)', () => {
  beforeEach(() => {
    setBody();
    setArea();
    S.tfrs = []; S.importedNotams = []; S.tfrImportMeta = null;
    S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
    S.wind = { maxWind: 5, maxGust: 8 };
    S.elev = { center: 2000 };
  });
  afterEach(() => { S.tfrs = []; S.importedNotams = []; S.currentArea = null; S.areaType = null; document.body.innerHTML = ''; });

  it('ingests GeoJSON text and populates S.tfrs', () => {
    ingestFaaFileText(geojson, 'oakland.geojson');
    expect(S.tfrs.length).toBe(1);
    expect(S.tfrs[0].id).toBe('6/4112');
    expect(S.tfrImportMeta.fileName).toBe('oakland.geojson');
  });

  it('renderTfrCards shows the TFR flagged OVER AREA', () => {
    applyTfrImport(parseTfrGeoJson(geojson).tfrs, 'oakland.geojson', 'geojson');
    renderTfrCards();
    const html = document.getElementById('tfrList').innerHTML;
    expect(html).toContain('6/4112');
    expect(html).toContain('OVER AREA');
    expect(document.getElementById('tfrCount').textContent).toContain('over area');
  });

  it('renderDeepLinks builds an area-scoped GeoServer link and resolves ZOA', () => {
    renderDeepLinks(38.65, -120.95);
    const html = document.getElementById('notamDeepLinks').innerHTML;
    expect(html).toContain('tfr.faa.gov/geoserver/TFR/ows');
    expect(html).toContain('Oakland Center (ZOA)');
    expect(html).toContain('skyvector.com');
  });

  it('an imported active TFR over the area drives the assessment to NO-GO', () => {
    applyTfrImport(parseTfrGeoJson(geojson).tfrs, 'oakland.geojson', 'geojson');
    computeAssessment();
    expect(document.getElementById('assessBadge').textContent).toBe('NO-GO');
    expect(document.getElementById('assessText').textContent).toContain('6/4112');
  });

  it('renderNotamCards shows the empty-state when no NOTAMs imported', () => {
    renderNotamCards();
    expect(document.getElementById('notamList').innerHTML).toContain('No NOTAMs parsed yet');
  });

  it('NOTAM text import lists a record', () => {
    ingestFaaFileText('A) KPVF B) 2606061200 C) 2606080700\nE) RWY 05/23 CLSD', 'notams.txt');
    expect(S.importedNotams.length).toBe(1);
    renderNotamCards();
    expect(document.getElementById('notamList').innerHTML).toContain('KPVF');
  });

  it('pasted NOTAM text is parsed, listed, and geolocated', () => {
    document.getElementById('notamPasteBox').value =
      '(A1234/26 NOTAMN Q) ZOA A) KPVF B) 2606061200 C) 2606080700 E) RWY 05/23 CLSD)';
    parsePastedNotams();
    expect(S.importedNotams.length).toBe(1);
    expect(S.importedNotams[0].id).toBe('A1234/26');
    // KPVF resolved from the static reference table (S.nearbyAirports empty here)
    expect(S.importedNotams[0].lat).toBeCloseTo(38.7243, 3);
    expect(document.getElementById('notamList').innerHTML).toContain('A1234/26');
    expect(document.getElementById('notamParseMsg').textContent).toContain('Parsed 1 NOTAM');
  });

  it('a pasted domestic area NOTAM over the search area plots a polygon and drives CAUTION', () => {
    // Triangle overlapping the El Dorado test area, active 2020–2099
    document.getElementById('notamPasteBox').value =
      '!OAK 01/099 ZOA AIRSPACE UAS WI AN AREA DEFINED AS 383600N1210000W 383600N1205400W 384200N1205400W TO POINT OF ORIGIN SFC-400FT AGL 2001011200-9912312359';
    parsePastedNotams();
    expect(S.importedNotams.length).toBe(1);
    expect(S.importedNotams[0].polygons.length).toBe(1);
    expect(document.getElementById('assessBadge').textContent).toBe('CAUTION');
    expect(document.getElementById('assessText').textContent).toContain('01/099');
    expect(document.getElementById('notamParseMsg').textContent).toContain('OVER your search area');
  });

  it('a circular NOTAM (radius + decimal-second center) plots and clicking it centers the map', () => {
    document.getElementById('notamPasteBox').value =
      '!OAK 04/186 ZOA AIRSPACE UAS WI AN AREA DEFINED AS 5NM RADIUS OF 382948.90N1201252.70W SFC-400FT AGL 2001011200-9912312359';
    parsePastedNotams();
    expect(S.importedNotams.length).toBe(1);
    expect(S.importedNotams[0].polygons.length).toBe(1);
    expect(S.importedNotams[0].polygons[0].length).toBeGreaterThan(20);
    S.map.fitBounds.mockClear();
    focusNotam('04/186');
    expect(S.map.fitBounds).toHaveBeenCalled();
  });
});

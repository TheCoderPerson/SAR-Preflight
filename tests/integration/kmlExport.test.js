const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

// ---- Minimal Leaflet mock with real classes so `instanceof` works ----
class MockGroup { constructor(layers) { this._layers = layers; } getLayers() { return this._layers; } }
class MPolyline {
  constructor(latlngs, popup) { this._ll = latlngs; this._p = { getContent: () => popup }; }
  getLatLngs() { return this._ll; }
  getPopup() { return this._p; }
}
class MPolygon extends MPolyline {}
class MMarker {
  constructor(ll, popup) { this._ll = ll; this._p = { getContent: () => popup }; }
  getLatLng() { return this._ll; }
  getPopup() { return this._p; }
}
globalThis.L = { Polygon: MPolygon, Polyline: MPolyline, Marker: MMarker, Circle: class {}, CircleMarker: class {} };

const app = require('../../sar-preflight.js');
const {
  S, gatherVisibleLayerFolders, buildSunWindFolders, populateExportModal,
  exportRasterGeoTiff, EXPORT_DISCLAIMER,
} = app;

// Capture every Blob handed to the downloader (URL.createObjectURL).
function captureDownloads(fn) {
  const blobs = [];
  const real = globalThis.URL.createObjectURL;
  globalThis.URL.createObjectURL = (b) => { blobs.push(b); return 'blob:x'; };
  globalThis.URL.revokeObjectURL = () => {};
  try { fn(); } finally { globalThis.URL.createObjectURL = real; }
  return blobs;
}

const LL = (lat, lng) => ({ lat, lng });

beforeEach(() => {
  S.map = { hasLayer: () => true, distance: () => 1500 };
  S.mapLayers = {};
  S.areaCenter = LL(38.7, -120.99);
  S.areaType = 'CIRCLE';
  S.currentArea = { getRadius: () => 1500 };
  document.body.innerHTML = '';
});

describe('gatherVisibleLayerFolders', () => {
  beforeEach(() => {
    S.mapLayers.faa_obstacles = new MockGroup([new L.Marker(LL(38.7, -120.99), '<b>Tower</b> 200 ft AGL')]);
    S.mapLayers.wire_power_line = new MockGroup([new L.Polyline([LL(38.70, -121.00), LL(38.71, -121.01)], 'Power line 115kV')]);
    S.mapLayers.faa_class_airspace = new MockGroup([new L.Polygon([[LL(38.6, -121.0), LL(38.6, -120.9), LL(38.7, -120.9)]], 'Class D')]);
  });

  it('exports point, line and polygon geometry from visible layers', () => {
    const kml = gatherVisibleLayerFolders(null);
    expect(kml).toContain('<Point>');
    expect(kml).toContain('<LineString>');
    expect(kml).toContain('<Polygon>');
    expect(kml).toContain('<Folder><name>Obstacle</name>');
    expect(kml).toContain('<Folder><name>Class Airspace</name>');
  });

  it('derives the placemark name from the popup text', () => {
    const kml = gatherVisibleLayerFolders(null);
    expect(kml).toContain('<name>Tower 200 ft AGL</name>');
  });

  it('renders descriptions as plain text with the popup HTML stripped', () => {
    const kml = gatherVisibleLayerFolders(new Set(['faa_obstacles']));
    expect(kml).toContain('Tower 200 ft AGL');   // text survives
    expect(kml).not.toContain('<b>');             // markup does not
  });

  it('attaches the verify-independently disclaimer to obstacle and wire folders but not airspace', () => {
    expect(gatherVisibleLayerFolders(new Set(['faa_obstacles']))).toContain(EXPORT_DISCLAIMER);
    expect(gatherVisibleLayerFolders(new Set(['wire_power_line']))).toContain(EXPORT_DISCLAIMER);
    expect(gatherVisibleLayerFolders(new Set(['faa_class_airspace']))).not.toContain(EXPORT_DISCLAIMER);
  });

  it('honours a selected-keys filter', () => {
    const only = gatherVisibleLayerFolders(new Set(['faa_class_airspace']));
    expect(only).toContain('Class Airspace');
    expect(only).not.toContain('<Point>'); // obstacle excluded
  });
});

describe('buildSunWindFolders', () => {
  beforeEach(() => {
    document.body.innerHTML = '<input type="checkbox" id="expSun" checked><input type="checkbox" id="expWind" checked>';
    S.wx = { hourly: {
      time: ['2026-06-16T12:00', '2026-06-16T13:00'],
      wind_direction_10m: [270, 280],
      wind_speed_10m: [10, 12],
      wind_gusts_10m: [16, 18],
    } };
  });

  it('builds a wind folder with downwind arrows labelled by source bearing', () => {
    const kml = buildSunWindFolders();
    expect(kml).toContain('<Folder><name>Wind (hourly)</name>');
    expect(kml).toContain('FROM 270°');
    expect((kml.match(/#windArrow/g) || []).length).toBe(2);
  });
});

describe('imported NOTAM/TFR export', () => {
  it('lists the plain-English summary before the raw NOTAM text', () => {
    S.mapLayers.notam_imported = new MockGroup([]); // visibility flag; data comes from state
    const notam = {
      id: 'A1/26', location: 'KPVF', body: '!PVF 06/001 PVF OBST TOWER LGT U/S',
      lat: 38.72, lng: -120.75, _relevance: { relevant: true },
    };
    S.importedNotams = [notam];
    const summary = globalThis.notamPlainSummary(notam);
    const kml = gatherVisibleLayerFolders(new Set(['notam_imported']));
    expect(kml).toContain('<Folder><name>NOTAM</name>');
    expect(summary.length).toBeGreaterThan(0);
    // Order: plain-English summary, then the "Full NOTAM" marker, then the raw body.
    expect(kml.indexOf(summary)).toBeGreaterThanOrEqual(0);
    expect(kml.indexOf(summary)).toBeLessThan(kml.indexOf('— Full NOTAM —'));
    expect(kml.indexOf('— Full NOTAM —')).toBeLessThan(kml.indexOf('OBST TOWER LGT U/S'));
  });
});

describe('airport icons by type', () => {
  it('uses the airport style for runways and the heliport style for helipads', () => {
    S.mapLayers.airports = new MockGroup([]);
    S.nearbyAirports = [
      { icao: 'KPVF', name: 'Placerville', type: 'small_airport', lat: 38.72, lng: -120.75, distKm: 5 },
      { icao: 'EDSAR', name: 'Hospital Helipad', type: 'heliport', lat: 38.70, lng: -120.80, distKm: 6 },
    ];
    const kml = gatherVisibleLayerFolders(new Set(['airports']));
    expect(kml).toContain('<styleUrl>#airport</styleUrl>');
    expect(kml).toContain('<styleUrl>#heliport</styleUrl>');
  });
});

describe('populateExportModal', () => {
  it('lists visible layers with feature counts and toggles raster rows by availability', () => {
    document.body.innerHTML =
      '<div id="exportLayerList"></div>' +
      '<label id="expCanopyKmzRow"><input type="checkbox" id="expCanopyKmz"></label>' +
      '<label id="expCanopyRow"><input type="checkbox" id="expCanopyTiff"></label>' +
      '<label id="expViewshedKmzRow"><input type="checkbox" id="expViewshedKmz"></label>' +
      '<label id="expViewshedRow"><input type="checkbox" id="expViewshedTiff"></label>';
    S.mapLayers.faa_obstacles = new MockGroup([new L.Marker(LL(38.7, -120.99), 'Tower')]);
    S.canopy = { grid: {}, canopyFlat: new Float32Array(1) };
    S.viewshed = {}; // no mask -> viewshed export disabled
    populateExportModal();
    const list = document.getElementById('exportLayerList');
    expect(list.querySelectorAll('input[type="checkbox"]').length).toBe(1);
    expect(list.querySelector('input').dataset.layerKey).toBe('faa_obstacles');
    // Canopy available -> GeoTIFF (CalTopo) checked by default, KMZ opt-in.
    expect(document.getElementById('expCanopyTiff').checked).toBe(true);
    expect(document.getElementById('expCanopyKmz').disabled).toBe(false);
    expect(document.getElementById('expCanopyKmz').checked).toBe(false);
    // Viewshed unavailable -> both disabled.
    expect(document.getElementById('expViewshedKmz').disabled).toBe(true);
    expect(document.getElementById('expViewshedTiff').disabled).toBe(true);
  });
});

describe('exportRasterGeoTiff', () => {
  it('reprojects to Web Mercator and hands a single .tif blob to the downloader', () => {
    const grid = { cols: 4, rows: 4, bounds: { west: -121, east: -120.99, south: 38.7, north: 38.71 } };
    S.canopy = { grid, canopyFlat: new Float32Array(16).fill(12) };
    const blobs = captureDownloads(() => exportRasterGeoTiff('canopy'));
    expect(blobs.length).toBe(1);
    expect(blobs[0].type).toBe('image/tiff');
  });
});

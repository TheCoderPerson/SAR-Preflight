// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || function() {};

const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// Mock Leaflet — comprehensive chainable mock for processArea chain
function chainMock() {
  const m = {};
  const handler = { get(target, prop) { if (prop in target) return target[prop]; return vi.fn(() => new Proxy({}, handler)); } };
  return new Proxy(m, handler);
}
const mockLayerGroup = { addLayer: vi.fn(), clearLayers: vi.fn(), getLayers: vi.fn(() => []), addTo: vi.fn() };
globalThis.L = {
  map: vi.fn(),
  tileLayer: vi.fn(),
  control: { zoom: vi.fn() },
  Draw: { Event: {} },
  FeatureGroup: vi.fn(),
  layerGroup: vi.fn(() => mockLayerGroup),
  marker: vi.fn(() => chainMock()),
  divIcon: vi.fn(),
  circle: vi.fn((latlng, opts) => ({
    _latlng: latlng, _radius: opts.radius,
    getBounds: () => ({ getNorthEast: () => ({ lat: latlng[0] + 0.02, lng: latlng[1] + 0.02 }), getSouthWest: () => ({ lat: latlng[0] - 0.02, lng: latlng[1] - 0.02 }), getCenter: () => ({ lat: latlng[0], lng: latlng[1] }) }),
    getLatLng: () => ({ lat: latlng[0], lng: latlng[1] }),
    getRadius: () => opts.radius,
  })),
  polygon: vi.fn((coords, opts) => ({
    _coords: coords,
    getBounds: () => ({ getNorthEast: () => ({ lat: Math.max(...coords.map(c => c[0])), lng: Math.max(...coords.map(c => c[1])) }), getSouthWest: () => ({ lat: Math.min(...coords.map(c => c[0])), lng: Math.min(...coords.map(c => c[1])) }), getCenter: () => ({ lat: coords.reduce((s, c) => s + c[0], 0) / coords.length, lng: coords.reduce((s, c) => s + c[1], 0) / coords.length }) }),
    getLatLngs: () => [coords.map(c => ({ lat: c[0], lng: c[1] }))],
  })),
  circleMarker: vi.fn(() => chainMock()),
  latLng: vi.fn((lat, lng) => ({ lat, lng })),
  polyline: vi.fn(() => chainMock()),
  geoJSON: vi.fn(() => chainMock()),
};

const { S, parseKML } = require('../../sar-preflight.js');

describe('parseKML(kmlText)', () => {
  // Suppress unhandled rejections from processArea's async chain
  // (processArea triggers parallel API fetches which fail in test env — this is expected)
  let rejectHandler;
  beforeAll(() => {
    rejectHandler = () => {};
    process.on('unhandledRejection', rejectHandler);
  });
  afterAll(() => {
    process.removeListener('unhandledRejection', rejectHandler);
  });

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="noAreaOverlay"></div>
      <div id="assessmentBanner" style="display:none;"></div>
      <div id="areaInfoBar" style="display:none;"></div>
      <div id="noAreaState"></div>
      <div id="areaCenter"></div>
      <div id="areaSize"></div>
      <div id="areaType"></div>
      <div id="areaPerimeter"></div>
      <div id="areaMaxDim"></div>
      <div id="tabNav"><button class="tab-btn active" data-tab="wx"></button></div>
      <div id="tab-wx" class="tab-panel"></div>
      <div id="windTableBody"></div>
      <div id="satTableBody"></div>
      <input id="cfgMaxWind" value="27" />
      <input id="cfgFlightTime" value="38" />
      <div id="assessBadge"></div>
      <div id="assessText"></div>
      <div id="airClass"></div>
      <div id="airLAANC"></div>
      <div id="airLAANCAlt"></div>
      <div id="airNearAirport"></div>
      <div id="airNearDist"></div>
      <div id="airMOA"></div>
      <div id="airRestricted"></div>
      <div id="airProhibited"></div>
      <div id="airHeliports"></div>
      <div id="opsTempFactor"></div>
      <div id="opsAltFactor"></div>
      <div id="opsWindFactor"></div>
      <div id="opsFlightTime"></div>
      <div id="opsCapacity"></div>
      <div id="opsCapBar" style="width:0"></div>
      <div id="opsBirds"></div>
      <div id="tabScrollLeft"></div>
      <div id="tabScrollRight"></div>
      <div id="layerList"></div>
      <div id="wxStatus"></div><div id="windStatus"></div><div id="elevStatus"></div>
      <div id="astroStatus"></div><div id="notamStatus"></div><div id="wireStatus"></div>
      <div id="alertStatus"></div><div id="alertSection" style="display:none;"></div>
      <div id="alertList"></div>
      <div id="forecastSection" style="display:none;"></div>
      <div id="forecastChart"></div>
      <div id="notamList"></div>
      <div id="wxTemp"></div><div id="wxVis"></div><div id="wxPrecip"></div>
      <div id="wxKp"></div><div id="satKp"></div><div id="satAccuracy"></div>
      <div id="satAssessment"></div>
      <div id="terrMin"></div><div id="terrMax"></div><div id="terrRange"></div>
      <div id="terrLaunch"></div><div id="terrClass"></div><div id="terrSlope"></div>
      <div id="terrPower"></div><div id="terrTowers"></div>
      <div id="terrCell"></div><div id="terrRID"></div>
      <div id="astSunrise"></div><div id="astSunset"></div>
      <div id="astTwilightAM"></div><div id="astTwilightPM"></div>
      <div id="astSunAz"></div><div id="astSunEl"></div>
      <div id="astMoonPhase"></div><div id="astMoonIllum"></div>
      <div id="astDayWindow"></div><div id="astNightOps"></div>
      <div id="astShadow"></div><div id="astMagDec"></div>
      <div id="radarControls" style="display:none;"></div>
    `;
    const mockLG = { addLayer: vi.fn(), clearLayers: vi.fn(), getLayers: vi.fn(() => []), addTo: vi.fn() };
    S.drawnItems = { clearLayers: vi.fn(), addLayer: vi.fn() };
    S.map = { fitBounds: vi.fn(), hasLayer: vi.fn(() => false), addLayer: vi.fn(), removeLayer: vi.fn() };
    const makeLG = () => ({ addLayer: vi.fn(), clearLayers: vi.fn(), getLayers: vi.fn(() => []) });
    S.mapLayers = { airports: makeLG(), nws_alerts: makeLG(), cell_towers: makeLG() };
    S.nwsAlerts = [];
    S.wx = {}; S.wind = {}; S.elev = {};
    S.currentArea = null;
    S.radarAnim = null;
    S.wireHazardCounts = {};
    S.towerCount = 0;
    // Mock global fetch for processArea's API calls
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
  });

  it('parses a KML polygon with namespace', () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document><Placemark>
        <Polygon><outerBoundaryIs><LinearRing>
          <coordinates>-120.5,38.5,0 -120.6,38.5,0 -120.6,38.6,0 -120.5,38.6,0 -120.5,38.5,0</coordinates>
        </LinearRing></outerBoundaryIs></Polygon>
      </Placemark></Document>
    </kml>`;

    parseKML(kml);
    expect(L.polygon).toHaveBeenCalled();
    const coords = L.polygon.mock.calls[L.polygon.mock.calls.length - 1][0];
    expect(coords.length).toBe(4); // duplicate closing point removed
    expect(coords[0]).toEqual([38.5, -120.5]);
    expect(coords[1]).toEqual([38.5, -120.6]);
    expect(S.drawnItems.clearLayers).toHaveBeenCalled();
    expect(S.drawnItems.addLayer).toHaveBeenCalled();
  });

  it('parses a KML polygon without namespace', () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
    <kml>
      <Document><Placemark>
        <Polygon><outerBoundaryIs><LinearRing>
          <coordinates>-121.0,39.0,0 -121.1,39.0,0 -121.1,39.1,0 -121.0,39.1,0 -121.0,39.0,0</coordinates>
        </LinearRing></outerBoundaryIs></Polygon>
      </Placemark></Document>
    </kml>`;

    parseKML(kml);
    expect(L.polygon).toHaveBeenCalled();
    const coords = L.polygon.mock.calls[L.polygon.mock.calls.length - 1][0];
    expect(coords.length).toBe(4);
    expect(coords[0]).toEqual([39.0, -121.0]);
  });

  it('parses a KML LineString as polygon', () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document><Placemark>
        <LineString>
          <coordinates>-120.0,38.0,0 -120.1,38.0,0 -120.1,38.1,0</coordinates>
        </LineString>
      </Placemark></Document>
    </kml>`;

    parseKML(kml);
    expect(L.polygon).toHaveBeenCalled();
    const coords = L.polygon.mock.calls[L.polygon.mock.calls.length - 1][0];
    expect(coords.length).toBe(3);
    expect(coords[0]).toEqual([38.0, -120.0]);
    expect(coords[2]).toEqual([38.1, -120.1]);
  });

  it('parses a KML Point and creates a circle with 2km radius', () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document><Placemark>
        <Point><coordinates>-120.99,38.685,0</coordinates></Point>
      </Placemark></Document>
    </kml>`;

    parseKML(kml);
    expect(L.circle).toHaveBeenCalled();
    const call = L.circle.mock.calls[L.circle.mock.calls.length - 1];
    expect(call[0]).toEqual([38.685, -120.99]);
    expect(call[1].radius).toBe(2000);
  });

  it('prefers Polygon over LineString and Point', () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document><Placemark>
        <Point><coordinates>-120.0,38.0,0</coordinates></Point>
        <Polygon><outerBoundaryIs><LinearRing>
          <coordinates>-120.5,38.5,0 -120.6,38.5,0 -120.6,38.6,0 -120.5,38.5,0</coordinates>
        </LinearRing></outerBoundaryIs></Polygon>
        <LineString><coordinates>-121.0,39.0,0 -121.1,39.1,0</coordinates></LineString>
      </Placemark></Document>
    </kml>`;

    L.polygon.mockClear();
    L.circle.mockClear();
    parseKML(kml);
    expect(L.polygon).toHaveBeenCalled();
    expect(L.circle).not.toHaveBeenCalled();
  });

  it('alerts when no geometry is found', () => {
    const alertSpy = vi.spyOn(globalThis, 'alert').mockImplementation(() => {});
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document><name>Empty</name></Document>
    </kml>`;

    parseKML(kml);
    expect(alertSpy).toHaveBeenCalledWith('No valid geometry found in KML file.');
    alertSpy.mockRestore();
  });

  it('handles coordinates with varying whitespace', () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document><Placemark>
        <Polygon><outerBoundaryIs><LinearRing>
          <coordinates>
            -120.5,38.5,0
            -120.6,38.5,0
            -120.6,38.6,0
            -120.5,38.6,0
            -120.5,38.5,0
          </coordinates>
        </LinearRing></outerBoundaryIs></Polygon>
      </Placemark></Document>
    </kml>`;

    parseKML(kml);
    expect(L.polygon).toHaveBeenCalled();
    const coords = L.polygon.mock.calls[L.polygon.mock.calls.length - 1][0];
    expect(coords.length).toBe(4);
  });

  it('handles coordinates without altitude component', () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document><Placemark>
        <Point><coordinates>-120.99,38.685</coordinates></Point>
      </Placemark></Document>
    </kml>`;

    parseKML(kml);
    expect(L.circle).toHaveBeenCalled();
    const call = L.circle.mock.calls[L.circle.mock.calls.length - 1];
    expect(call[0]).toEqual([38.685, -120.99]);
  });

  it('swaps lng,lat to [lat,lng] for Leaflet', () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document><Placemark>
        <Polygon><outerBoundaryIs><LinearRing>
          <coordinates>-121.5,37.5,0 -121.6,37.5,0 -121.6,37.6,0 -121.5,37.5,0</coordinates>
        </LinearRing></outerBoundaryIs></Polygon>
      </Placemark></Document>
    </kml>`;

    parseKML(kml);
    const coords = L.polygon.mock.calls[L.polygon.mock.calls.length - 1][0];
    // KML has lng,lat; Leaflet needs [lat,lng]
    expect(coords[0][0]).toBe(37.5); // lat
    expect(coords[0][1]).toBe(-121.5); // lng
  });

  it('removes duplicate closing point in polygon', () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document><Placemark>
        <Polygon><outerBoundaryIs><LinearRing>
          <coordinates>-120.0,38.0,0 -120.1,38.0,0 -120.1,38.1,0 -120.0,38.0,0</coordinates>
        </LinearRing></outerBoundaryIs></Polygon>
      </Placemark></Document>
    </kml>`;

    parseKML(kml);
    const coords = L.polygon.mock.calls[L.polygon.mock.calls.length - 1][0];
    // 4 points in KML, last duplicates first, so only 3 unique
    expect(coords.length).toBe(3);
    expect(coords[0]).toEqual([38.0, -120.0]);
    expect(coords[2]).toEqual([38.1, -120.1]);
  });
});
